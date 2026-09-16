/**
 * Business Brain — Diagnosis Engine: entity-context resolution
 *
 * A matcher can say "these two explanations both fit, and THIS measurement would
 * separate them" but cannot take the measurement: daily aggregates do not carry
 * which appointment was cancelled when. The catalogue's `requires_entity_data`
 * discriminators are therefore marked as such, and every hypothesis they would
 * separate stays `undetermined`.
 *
 * This layer takes those rows once they have been fetched and turns them into
 * evidence — and, where a rule is decisive, into a settled hypothesis.
 *
 * ## Why the fetching happens elsewhere
 *
 * Resolvers are PURE: rows in, evidence out. No clock, no I/O, no database
 * client — the same contract the matchers hold, and enforced by the same eslint
 * boundary over `engines/diagnosis/**`. The orchestrator decides which port
 * methods this run actually needs, fetches them, and hands the results in. That
 * keeps the engine testable with literals and keeps every query in one place.
 *
 * ## Absence stays absence
 *
 * `EntityContext` distinguishes three states per port method, and the difference
 * is the point:
 *
 *   undefined   not fetched — nothing in this run asked for it
 *   null        fetched, and the deployment CANNOT answer
 *   []          fetched, and there was genuinely nothing
 *
 * Only the third permits a conclusion. A resolver handed `null` leaves its
 * hypotheses exactly as the matcher left them, because "we do not record contact
 * attempts" must never be read as "no contact was attempted" — that is one of
 * the two answers the discriminator exists to choose between.
 */

import type { Evidence } from "../../../types";
import type {
  AppointmentArrivalRow,
  CancellationEvent,
  CompletedTreatmentRow,
  NoShowHistoryRow,
  OutstandingBalanceRow,
  PendingTreatmentRow,
} from "../ports/diagnosis-context-port";

/**
 * Entity rows fetched for one run, keyed by the port method that produced them.
 *
 * Every field is optional (not fetched) and independently nullable (cannot be
 * answered), so a partial fetch degrades to fewer conclusions rather than to a
 * failed run.
 */
export interface EntityContext {
  readonly cancellationEvents?: readonly CancellationEvent[] | null;
  readonly noShowHistory?: readonly NoShowHistoryRow[] | null;
  readonly pendingTreatments?: readonly PendingTreatmentRow[] | null;
  readonly outstandingBalances?: readonly OutstandingBalanceRow[] | null;
  readonly appointmentArrivals?: readonly AppointmentArrivalRow[] | null;
  readonly completedTreatments?: readonly CompletedTreatmentRow[] | null;
}

/** Which hypotheses a resolver settled, and what it observed. */
export interface ResolutionOutcome {
  /**
   * Evidence to attach. Always produced when rows were available, even when
   * nothing was settled: "we looked, and here is what we saw" is worth
   * recording, and it is what makes an unchanged `undetermined` inspectable
   * rather than merely unexplained.
   */
  readonly evidence: readonly Evidence[];
  /**
   * Hypothesis slugs the measurement SUPPORTS, and those it CONTRADICTS.
   *
   * Deliberately not a status: a resolver reports what it observed about each
   * hypothesis, and the caller decides what that does to the status. Two
   * resolvers can speak to the same hypothesis, and the last one to run must not
   * silently overwrite the first.
   */
  readonly supports: readonly string[];
  readonly contradicts: readonly string[];
}

/**
 * A pure discriminator resolver.
 *
 * Returns `null` when it cannot conclude anything — no rows, rows the deployment
 * cannot supply, or a sample too small to separate anything. `null` leaves the
 * hypotheses untouched, which is materially different from returning an empty
 * outcome that would claim the measurement was taken and found nothing.
 */
export type DiscriminatorResolver = (
  context: EntityContext,
  input: ResolverInput,
) => ResolutionOutcome | null;

/** Everything a resolver may depend on besides the rows themselves. */
export interface ResolverInput {
  /** Id of the diagnosis being resolved, for stable evidence ids. */
  readonly diagnosisId: string;
  /** The hypothesis slugs this discriminator was declared to separate. */
  readonly separates: readonly string[];
  /**
   * The run's logical moment, ISO-8601. Passed in rather than read, so a
   * resolver stays clock-free like every other part of this engine.
   */
  readonly now: string;
  /** Thresholds. No resolver may contain a bare number. */
  readonly config: EntityResolutionConfig;
}

/**
 * Thresholds for turning entity rows into a conclusion.
 *
 * Separate from the matchers' `discrimination` block because these are about
 * per-entity distributions rather than daily totals, and because a clinic tuning
 * one should not silently move the other.
 */
export interface EntityResolutionConfig {
  /**
   * Rows needed before a distribution is allowed to settle anything. Below this
   * a resolver still reports what it saw but concludes nothing — three
   * cancellations cannot establish that losses cluster.
   */
  readonly minimumSample: number;
  /**
   * Share of a distribution that must fall in one bucket before it is called
   * concentrated rather than spread.
   */
  readonly concentrationShare: number;
  /**
   * Hours of notice at or above which a cancellation is treated as having left
   * the slot recoverable.
   */
  readonly recoverableNoticeHours: number;
  /**
   * Share of a set that must share a property before the set is described by it
   * — for example, non-attenders who had missed before.
   */
  readonly majorityShare: number;
  /** Days beyond which a pending plan or unpaid balance counts as aged. */
  readonly agedDays: number;
}

export const DEFAULT_ENTITY_RESOLUTION: EntityResolutionConfig = {
  // Five is the smallest sample where a two-thirds concentration is not just one
  // extra row; below it the resolvers describe without concluding.
  minimumSample: 5,
  concentrationShare: 0.6,
  // A working day's notice. Below that a clinic realistically cannot refill.
  recoverableNoticeHours: 24,
  majorityShare: 0.6,
  agedDays: 30,
};
