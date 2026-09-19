/**
 * lib/business-brain/finding-feedback.ts
 *
 * Was the briefing worth reading? The reads behind the one question the module
 * has never asked.
 *
 * ## Why a snooze is not an answer
 *
 * `problem_dismissals` is the closest thing to feedback OraMedha has had, and it
 * cannot carry this: a dentist snoozes a problem that is real and inconvenient
 * exactly as readily as one that is wrong. So "dismissed" says nothing about
 * whether the finding was true, and precision — the share of what we say that is
 * worth saying — has been unmeasurable since the first rule shipped.
 *
 * ## The latest verdict wins
 *
 * A correction is a new row (see the migration), so every read here takes the
 * most recent row per finding. Nothing is overwritten and nothing is lost.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";

export type FindingVerdict = "useful" | "not_relevant";

export type FindingFeedbackReason =
  | "already_knew"
  | "not_true"
  | "not_my_priority"
  | "cannot_act"
  | "other";

/** One finding's standing verdict, as last recorded. */
export interface RecordedVerdict {
  readonly verdict: FindingVerdict;
  readonly reason: FindingFeedbackReason | null;
}

interface FeedbackRow {
  finding_id: string;
  finding_kind: string;
  category: string | null;
  verdict: FindingVerdict;
  reason: FindingFeedbackReason | null;
  business_date: string;
  recorded_at: string;
}

/**
 * What this clinic has already said about today's findings.
 *
 * Scoped to the business date, so yesterday's verdict never marks today's card:
 * the same problem flagged again tomorrow is a new claim, and whether it is
 * still worth saying is a new question.
 *
 * A failed read yields an empty map — the cards then offer the question again,
 * which is the harmless direction. A duplicate verdict is refused by the action,
 * not by hiding the buttons.
 */
export async function readFindingVerdicts(
  db: SupabaseClient<Database>,
  clinicId: string,
  businessDate: string,
): Promise<Map<string, RecordedVerdict>> {
  const { data, error } = await db
    .from("finding_feedback")
    .select("finding_id, finding_kind, category, verdict, reason, business_date, recorded_at")
    .eq("clinic_id", clinicId)
    .eq("business_date", businessDate)
    // Oldest first, so the loop below leaves the LATEST verdict in place.
    .order("recorded_at", { ascending: true })
    .returns<FeedbackRow[]>();

  if (error || data === null) return new Map();

  const latest = new Map<string, RecordedVerdict>();
  for (const row of data) {
    latest.set(row.finding_id, { verdict: row.verdict, reason: row.reason });
  }
  return latest;
}

/** Precision for one group of findings, over the window read. */
export interface FindingPrecision {
  /** The finding kind or category the group is about. */
  readonly group: string;
  readonly useful: number;
  readonly notRelevant: number;
  /** Useful as a share of both (%), or null when nothing was answered. */
  readonly precisionPercent: number | null;
  /** Why they were not relevant, most common first. Empty when all were useful. */
  readonly reasons: readonly { readonly reason: FindingFeedbackReason; readonly count: number }[];
}

/**
 * Precision by rule over a window.
 *
 * Grouped by CATEGORY where a finding has one and by kind otherwise, because the
 * question worth answering is whether a RULE earns its place. A finding id
 * answers only whether one card was useful on one Tuesday.
 *
 * Counts the latest verdict per (day, finding), so a clinic that corrects itself
 * is counted once. Returns an empty list when nothing has been answered — which
 * is not 0% precision, and must never be rendered as one.
 */
export async function readFindingPrecision(
  db: SupabaseClient<Database>,
  params: {
    /** One clinic, or every clinic the caller may read when omitted. */
    readonly clinicId?: string;
    /** Business date to count from, inclusive. */
    readonly since: string;
  },
): Promise<readonly FindingPrecision[]> {
  let query = db
    .from("finding_feedback")
    .select("clinic_id, finding_id, finding_kind, category, verdict, reason, business_date, recorded_at")
    .gte("business_date", params.since)
    .order("recorded_at", { ascending: true });
  if (params.clinicId !== undefined) query = query.eq("clinic_id", params.clinicId);
  // Without a clinic this reads whatever the caller is entitled to: everything
  // for the service role, and one clinic's own rows for a dentist's session,
  // because RLS scopes it either way. No caller can widen its own view by
  // omitting the argument.
  const { data, error } = await query.returns<(FeedbackRow & { clinic_id: string })[]>();

  if (error || data === null) return [];

  // Latest verdict per finding per day, then grouped. Keyed by clinic too, so a
  // platform-wide read cannot collapse two clinics' verdicts on findings that
  // happen to share an id.
  const latest = new Map<string, FeedbackRow & { clinic_id?: string }>();
  for (const row of data) {
    latest.set(`${row.clinic_id ?? ""}|${row.business_date}|${row.finding_id}`, row);
  }

  const groups = new Map<
    string,
    { useful: number; notRelevant: number; reasons: Map<FindingFeedbackReason, number> }
  >();
  for (const row of latest.values()) {
    const key = row.category ?? row.finding_kind;
    const group = groups.get(key) ?? {
      useful: 0,
      notRelevant: 0,
      reasons: new Map<FindingFeedbackReason, number>(),
    };
    if (row.verdict === "useful") group.useful += 1;
    else {
      group.notRelevant += 1;
      if (row.reason !== null) {
        group.reasons.set(row.reason, (group.reasons.get(row.reason) ?? 0) + 1);
      }
    }
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([group, counts]) => {
      const answered = counts.useful + counts.notRelevant;
      return {
        group,
        useful: counts.useful,
        notRelevant: counts.notRelevant,
        precisionPercent:
          answered === 0 ? null : Math.round((counts.useful / answered) * 1000) / 10,
        reasons: [...counts.reasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      };
    })
    .sort((a, b) => b.useful + b.notRelevant - (a.useful + a.notRelevant) || a.group.localeCompare(b.group));
}
