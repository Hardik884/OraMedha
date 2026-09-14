/**
 * lib/business-brain/result-events.ts
 *
 * What followed an action for its target patients: the ONE place that turns the
 * clinic's records into "this target showed the intended result at moment X, and
 * this is the kind of record that shows it".
 *
 * ## Point in time where history reaches
 *
 * From recorded state history (migration 20260917100000), through the database's
 * `action_result_events` reader: a transition recorded in [since, knownAt] and
 * still standing at knownAt, dated by when it was RECORDED. Nothing recorded after
 * knownAt counts, and a later cancellation or deletion does not reach back.
 *
 * ## Current state before it
 *
 * For a window that starts before history capture began, the only records are
 * current rows, dated by `updated_at` / `created_at` — timestamps an unrelated
 * edit can move and a later deletion can erase. They are still read, because a
 * clinic's older actions are still worth listing, but the result says
 * `current_state` and every consumer treats it as such.
 *
 * ## Evidence kind
 *
 *   payment recorded, appointment booked  objectively_observed
 *   follow-up closed with an attended visit on record since the action
 *                                         objectively_observed
 *   follow-up closed with no such visit   staff_declared
 *   anything read from current state      a payment or booking row is still a
 *                                         record of the event (objectively
 *                                         observed); a follow-up closure cannot be
 *                                         corroborated from current rows (unknown)
 *
 * Patient ids go in and come out of `readResultEvents`, and the callers turn them
 * into delays without passing them on.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import {
  EvidenceSource,
  EvidenceTiming,
  historyCovers,
  type HistoryCapture,
  type HistoryEntity,
} from "@/business-brain";
import { VerificationTarget } from "@/business-brain/engines/outcome";
import { readUpTo } from "./paged-read";

const ID_CHUNK = 100;
const LIVE_APPOINTMENT_STATUSES = ["scheduled", "checked_in", "in_progress", "completed"] as const;

/** The history each target's evidence rests on. */
const ENTITIES_BY_TARGET: Readonly<Record<VerificationTarget, readonly HistoryEntity[]>> = {
  [VerificationTarget.FOLLOW_UP_COMPLETED]: ["follow_up", "appointment", "patient"],
  [VerificationTarget.PAYMENT_RECORDED]: ["payment", "patient"],
  [VerificationTarget.APPOINTMENT_BOOKED]: ["appointment", "patient"],
};

export interface ResultEvent {
  readonly patientId: string;
  /** When the result was on record. */
  readonly at: string;
  readonly source: EvidenceSource;
}

export interface ResultEvents {
  readonly events: readonly ResultEvent[];
  readonly timing: EvidenceTiming;
  readonly truncated: boolean;
}

/** Read once per request: when each entity's history capture began. */
export async function readHistoryCaptures(db: SupabaseClient<Database>): Promise<HistoryCapture[]> {
  const { data, error } = await db.from("entity_history_capture").select("entity, captured_since");
  if (error) throw new Error(`entity_history_capture: ${error.message}`);
  return ((data ?? []) as { entity: string; captured_since: string }[]).map((r) => ({ entity: r.entity as HistoryEntity, capturedSince: r.captured_since }));
}

/** Whether evidence for `target` over [since, knownAt] can be read from history. */
export function resultTiming(captures: readonly HistoryCapture[], target: VerificationTarget, since: string): EvidenceTiming {
  return historyCovers(captures, ENTITIES_BY_TARGET[target], since).covered ? EvidenceTiming.POINT_IN_TIME : EvidenceTiming.CURRENT_STATE;
}

/**
 * Target patients still live records at `knownAt`: from history where it
 * reaches, from current rows otherwise. A patient deleted since is still a
 * target of the action; whether they count in the denominator is a question
 * about the moment the evidence is judged.
 */
export async function livePatientsAt(
  db: SupabaseClient<Database>,
  clinicId: string,
  patientIds: readonly string[],
  knownAt: string,
  timing: EvidenceTiming,
): Promise<Set<string>> {
  const live = new Set<string>();
  const unique = [...new Set(patientIds)].sort();
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    if (timing === EvidenceTiming.POINT_IN_TIME) {
      const { rows } = await readUpTo<{ patient_id: string; is_deleted: boolean }>(
        "result events (patient states)",
        (from, to) =>
          db.rpc("patient_states_as_of", { p_clinic_id: clinicId, p_known_at: knownAt, p_patient_ids: chunk }).order("patient_id", { ascending: true }).range(from, to),
        chunk.length,
      );
      for (const p of rows) if (!p.is_deleted) live.add(p.patient_id);
    } else {
      const { rows } = await readUpTo<{ id: string }>(
        "result events (patients)",
        (from, to) => db.from("patients").select("id").eq("clinic_id", clinicId).is("deleted_at", null).in("id", chunk).order("id", { ascending: true }).range(from, to),
        chunk.length,
      );
      for (const p of rows) live.add(p.id);
    }
  }
  return live;
}

/**
 * Every result recorded for `patientIds` in [since, knownAt], with its evidence
 * kind. `limit` bounds rows per id chunk; a chunk that reaches it is reported
 * truncated, never returned as whole.
 */
export async function readResultEvents(
  db: SupabaseClient<Database>,
  input: {
    readonly clinicId: string;
    readonly target: VerificationTarget;
    readonly patientIds: readonly string[];
    readonly since: string;
    readonly knownAt: string;
    readonly timing: EvidenceTiming;
    readonly limit: number;
  },
): Promise<ResultEvents> {
  const events: ResultEvent[] = [];
  let truncated = false;
  const unique = [...new Set(input.patientIds)].sort();
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);
    const read =
      input.timing === EvidenceTiming.POINT_IN_TIME ? await pointInTimeEvents(db, input, chunk) : await currentStateEvents(db, input, chunk);
    events.push(...read.events);
    truncated ||= read.truncated;
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0));
  return { events, timing: input.timing, truncated };
}

async function pointInTimeEvents(
  db: SupabaseClient<Database>,
  input: Parameters<typeof readResultEvents>[1],
  chunk: string[],
): Promise<{ events: ResultEvent[]; truncated: boolean }> {
  const { rows, truncated } = await readUpTo<{ patient_id: string; recorded_at: string; evidence: string; seq: number }>(
    "result events (history)",
    (from, to) =>
      db
        .rpc("action_result_events", {
          p_clinic_id: input.clinicId,
          p_target: input.target,
          p_patient_ids: chunk,
          p_since: input.since,
          p_known_at: input.knownAt,
        })
        .order("recorded_at", { ascending: true })
        .order("seq", { ascending: true })
        .range(from, to),
    input.limit,
  );
  return {
    events: rows.map((r) => ({
      patientId: r.patient_id,
      at: r.recorded_at,
      source: r.evidence === EvidenceSource.OBJECTIVELY_OBSERVED ? EvidenceSource.OBJECTIVELY_OBSERVED : EvidenceSource.STAFF_DECLARED,
    })),
    truncated,
  };
}

async function currentStateEvents(
  db: SupabaseClient<Database>,
  input: Parameters<typeof readResultEvents>[1],
  chunk: string[],
): Promise<{ events: ResultEvent[]; truncated: boolean }> {
  if (input.target === VerificationTarget.FOLLOW_UP_COMPLETED) {
    const { rows, truncated } = await readUpTo<{ patient_id: string; updated_at: string }>(
      "result events (follow_ups)",
      (from, to) =>
        db
          .from("follow_ups")
          .select("patient_id, updated_at")
          .eq("clinic_id", input.clinicId)
          .in("patient_id", chunk)
          .eq("status", "completed")
          .is("deleted_at", null)
          .gte("updated_at", input.since)
          .lte("updated_at", input.knownAt)
          .order("updated_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      input.limit,
    );
    return { events: rows.map((r) => ({ patientId: r.patient_id, at: r.updated_at, source: EvidenceSource.UNKNOWN })), truncated };
  }
  if (input.target === VerificationTarget.PAYMENT_RECORDED) {
    const { rows, truncated } = await readUpTo<{ patient_id: string; created_at: string }>(
      "result events (payments)",
      (from, to) =>
        db
          .from("payments")
          .select("patient_id, created_at")
          .eq("clinic_id", input.clinicId)
          .in("patient_id", chunk)
          .is("deleted_at", null)
          .gte("created_at", input.since)
          .lte("created_at", input.knownAt)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      input.limit,
    );
    return { events: rows.map((r) => ({ patientId: r.patient_id, at: r.created_at, source: EvidenceSource.OBJECTIVELY_OBSERVED })), truncated };
  }
  const { rows, truncated } = await readUpTo<{ patient_id: string; created_at: string }>(
    "result events (appointments)",
    (from, to) =>
      db
        .from("appointments")
        .select("patient_id, created_at")
        .eq("clinic_id", input.clinicId)
        .in("patient_id", chunk)
        .in("status", [...LIVE_APPOINTMENT_STATUSES])
        .is("deleted_at", null)
        .gte("created_at", input.since)
        .lte("created_at", input.knownAt)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    input.limit,
  );
  return { events: rows.map((r) => ({ patientId: r.patient_id, at: r.created_at, source: EvidenceSource.OBJECTIVELY_OBSERVED })), truncated };
}
