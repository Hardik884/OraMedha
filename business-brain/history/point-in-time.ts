/**
 * Business Brain — Point-in-time state.
 *
 * "What did OraMedha know about this record at moment T?" answered from the
 * append-only state versions the database writes on every change (migration
 * 20260917100000). Pure: versions in, state out.
 *
 * ## Two clocks, one gate
 *
 *   recordedAt   when OraMedha recorded the change — the database clock of the
 *                writing transaction. THE gate: a version recorded after T does
 *                not exist as far as T is concerned, whatever it says about when
 *                the change took effect.
 *   effectiveAt  when the change took effect in the world, where the record says
 *                (a treatment's performed_at, a payment's date), with the basis
 *                it rests on. Reported beside the state; it never lets a version
 *                through the gate early.
 *
 * So a payment keyed in on 5 September for 1 September is, as of 3 September,
 * not known at all; as of 6 September it is known, and dated 1 September.
 *
 * There is no correction model for valid time: what OraMedha knows NOW about 3
 * September is today's state with each transition's effective date, not a
 * rewritten past. That is deliberate — a bitemporal rewrite is exactly the
 * mechanism by which later knowledge leaks into an earlier observation.
 *
 * ## Three answers, never a guess
 *
 *   known    a version recorded by T gives the state
 *   absent   the record's first version is its OBSERVED creation, recorded after
 *            T: it did not exist in OraMedha at T
 *   unknown  no version recorded by T, and nothing proves it did not exist — a
 *            record that predates capture, or one with no history at all
 */

import { HistoryIntegrityError } from "./history-errors";

export const HistoryProvenance = {
  /** Captured by the database as the change happened. */
  OBSERVED: "observed",
  /** The state found when capture began: exact at its recorded moment, nothing known before it. */
  BASELINE: "baseline",
  /** Rebuilt afterwards from another source. Never point-in-time evidence. */
  RECONSTRUCTED: "reconstructed",
} as const;
export type HistoryProvenance = (typeof HistoryProvenance)[keyof typeof HistoryProvenance];

export const EffectiveTimeBasis = {
  /** No separate event time is captured; the change is dated when it was recorded. */
  RECORDED: "recorded",
  /** A treatment's own performed_at, which may be earlier than its recording. */
  PERFORMED_AT: "performed_at",
  /** The start of a payment's clinic-local payment date. */
  PAYMENT_DATE: "payment_date",
  /** Not known: a baseline records what was found, not when it came to be. */
  UNKNOWN: "unknown",
} as const;
export type EffectiveTimeBasis = (typeof EffectiveTimeBasis)[keyof typeof EffectiveTimeBasis];

/** One recorded version of a record's state. */
export interface EntityVersion<S> {
  readonly clinicId: string;
  readonly entityId: string;
  /** Database order of recording; breaks ties between versions recorded in the same transaction. */
  readonly seq: number;
  readonly recordedAt: string;
  readonly effectiveAt: string | null;
  readonly effectiveAtBasis: EffectiveTimeBasis;
  readonly provenance: HistoryProvenance;
  /** True for the version that recorded the record's creation. */
  readonly isCreation: boolean;
  readonly state: S;
}

export interface VersionStamp {
  readonly seq: number;
  readonly recordedAt: string;
  readonly effectiveAt: string | null;
  readonly effectiveAtBasis: EffectiveTimeBasis;
  readonly provenance: HistoryProvenance;
}

export type PointInTimeState<S> =
  | { readonly status: "known"; readonly state: S; readonly version: VersionStamp }
  | { readonly status: "absent" }
  | { readonly status: "unknown"; readonly reason: "no_history" | "before_capture" };

function stamp<S>(v: EntityVersion<S>): VersionStamp {
  return { seq: v.seq, recordedAt: v.recordedAt, effectiveAt: v.effectiveAt, effectiveAtBasis: v.effectiveAtBasis, provenance: v.provenance };
}

/**
 * A record's versions in recording order, duplicates removed.
 *
 * Deterministic whatever order they arrive in: by recording instant, then by
 * database sequence. A version seen twice (a retried read, an overlapping page)
 * is one version, identified by its sequence.
 */
export function orderVersions<S>(versions: readonly EntityVersion<S>[]): EntityVersion<S>[] {
  const bySeq = new Map<number, EntityVersion<S>>();
  for (const v of versions) {
    const ms = Date.parse(v.recordedAt);
    if (Number.isNaN(ms)) throw new HistoryIntegrityError(`Version ${v.seq} of ${v.entityId} has no valid recording moment.`);
    const seen = bySeq.get(v.seq);
    if (seen !== undefined && (seen.entityId !== v.entityId || seen.recordedAt !== v.recordedAt)) {
      throw new HistoryIntegrityError(`Two different versions share sequence ${v.seq}.`);
    }
    bySeq.set(v.seq, v);
  }
  return [...bySeq.values()].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.seq - b.seq);
}

/**
 * The state of ONE record as OraMedha knew it at `knownAt`.
 *
 * Throws when handed another clinic's versions, or versions of more than one
 * record: a mixed history has no single answer, and picking one would be a
 * cross-tenant or cross-record match.
 */
export function stateAsOf<S>(
  versions: readonly EntityVersion<S>[],
  input: { readonly clinicId: string; readonly knownAt: string },
): PointInTimeState<S> {
  const knownMs = Date.parse(input.knownAt);
  if (Number.isNaN(knownMs)) throw new HistoryIntegrityError(`Invalid knownAt: ${input.knownAt}.`);
  const ordered = orderVersions(versions);
  if (ordered.length === 0) return { status: "unknown", reason: "no_history" };
  const entityId = ordered[0].entityId;
  for (const v of ordered) {
    if (v.clinicId !== input.clinicId) throw new HistoryIntegrityError(`A version of ${v.entityId} belongs to another clinic.`);
    if (v.entityId !== entityId) throw new HistoryIntegrityError("Versions of more than one record were supplied.");
  }

  const visible = ordered.filter((v) => Date.parse(v.recordedAt) <= knownMs);
  if (visible.length > 0) {
    const latest = visible[visible.length - 1];
    return { status: "known", state: latest.state, version: stamp(latest) };
  }
  const first = ordered[0];
  if (first.provenance === HistoryProvenance.OBSERVED && first.isCreation) return { status: "absent" };
  return { status: "unknown", reason: first.provenance === HistoryProvenance.BASELINE ? "before_capture" : "no_history" };
}

/**
 * Every record's state at `knownAt`, keyed by record id, from a mixed list of
 * one clinic's versions. Output order is by record id, so it is identical for
 * any input order.
 */
export function statesAsOf<S>(
  versions: readonly EntityVersion<S>[],
  input: { readonly clinicId: string; readonly knownAt: string },
): ReadonlyMap<string, PointInTimeState<S>> {
  const byEntity = new Map<string, EntityVersion<S>[]>();
  for (const v of versions) byEntity.set(v.entityId, [...(byEntity.get(v.entityId) ?? []), v]);
  const out = new Map<string, PointInTimeState<S>>();
  for (const id of [...byEntity.keys()].sort()) out.set(id, stateAsOf(byEntity.get(id) as EntityVersion<S>[], input));
  return out;
}

/**
 * The first recorded moment, in (since, knownAt], at which a record entered a
 * state matching `enters` from one that did not — and still matched at
 * `knownAt`. Null when it did not, or when nothing recorded proves it did.
 *
 * A baseline cannot supply a transition: it records a state, not the moment it
 * was reached.
 */
export function firstObservedTransition<S>(
  versions: readonly EntityVersion<S>[],
  input: { readonly clinicId: string; readonly since: string; readonly knownAt: string; readonly enters: (state: S) => boolean },
): VersionStamp | null {
  const current = stateAsOf(versions, input);
  if (current.status !== "known" || !input.enters(current.state)) return null;
  const sinceMs = Date.parse(input.since);
  const knownMs = Date.parse(input.knownAt);
  const ordered = orderVersions(versions);
  let previous: EntityVersion<S> | undefined;
  for (const v of ordered) {
    const at = Date.parse(v.recordedAt);
    if (at > knownMs) break;
    const entered = input.enters(v.state) && (previous === undefined ? v.isCreation : !input.enters(previous.state));
    if (entered && at >= sinceMs && v.provenance === HistoryProvenance.OBSERVED) return stamp(v);
    previous = v;
  }
  return null;
}
