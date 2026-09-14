/**
 * DiagnosisEngine
 *
 * RESPONSIBILITY:
 * Correlates signals into patterns and frames the causes that are consistent with
 * the evidence. It moves from "what deserves attention" to "which of these
 * observations are one story, and what would tell the possible causes apart".
 *
 * It does NOT recommend, advise, or prescribe. A Diagnosis carries competing
 * hypotheses with explicit statuses and an explicit list of what data would
 * discriminate between them. Recommendations are a later phase.
 *
 * Consumes:  a signal run — signals, metrics, and the Signal Engine's decision
 *            trace — plus optional prior runs, all supplied by the caller
 * Produces:  correlated diagnoses with hypotheses, discriminators, persistence,
 *            severity, and confidence
 *
 * This file is the contract. The implementation lives in `./diagnosis`.
 */

import type { SnapshotKnowledge } from "../provenance/metric-provenance";
import { BaseEngine } from "../core";
import type { Diagnosis, Metric, Signal } from "../domain";
import type { DecisionTrace } from "../types";

/**
 * One complete signal run for a clinic-day.
 *
 * The trace is REQUIRED. Without it a consumer cannot tell an evaluator that
 * measured nothing from an evaluator that could not run, and those two absences
 * lead to different diagnoses.
 */
export interface SignalRun {
  /** Business date, "YYYY-MM-DD". */
  readonly date: string;
  readonly signals: readonly Signal[];
  readonly metrics: readonly Metric[];
  readonly trace: readonly DecisionTrace[];
}

/** A prior day supplied as metrics only, for signal re-derivation. */
export interface MetricsOnlyDay {
  readonly date: string;
  readonly metrics: readonly Metric[];
  /**
   * How the records behind a MEASURED day were read. Present only on days the run
   * measured itself; a day read from the store carries its provenance there.
   */
  readonly knowledge?: SnapshotKnowledge;
  /** The clinic timezone the day was measured in, alongside `knowledge`. */
  readonly timezone?: string;
}

/**
 * Input to the Diagnosis Engine. Everything arrives from the caller; the engine
 * never queries data itself and never fetches its own history.
 */
export interface DiagnosisEngineQuery {
  /** The signal run being diagnosed. */
  readonly current: SignalRun;
  /** Prior signal runs, ascending by date. */
  readonly history?: readonly SignalRun[];
  /** Prior days as metrics only; signals are re-derived from them. */
  readonly historyMetricsOnly?: readonly MetricsOnlyDay[];
}

export abstract class DiagnosisEngine extends BaseEngine<
  DiagnosisEngineQuery,
  Diagnosis[]
> {
  readonly name = "DiagnosisEngine";
}
