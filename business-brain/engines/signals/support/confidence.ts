/**
 * Business Brain — Signal Engine: confidence
 *
 * Confidence here means "how complete and current was the data behind this
 * observation". It is not an AI probability and it is not a measure of how bad
 * the situation is.
 *
 * Missing REQUIRED metrics never lower confidence — the evaluator is skipped
 * instead, because a signal we cannot compute is not a low-confidence signal.
 */

import type { Confidence } from "../../../types";
import type { Metric } from "../../../domain";
import type { SignalThresholdConfig } from "../config/signal-thresholds";
import { clamp, round2 } from "./numbers";

export interface ConfidenceInput {
  readonly config: SignalThresholdConfig;
  /** How many declared optional metrics were absent. */
  readonly missingOptionalMetrics?: number;
  /** The denominator the observation rests on, when it has one. */
  readonly denominator?: number;
  /** How many read metrics describe a period other than the requested date. */
  readonly staleMetrics?: number;
}

export interface ConfidenceAssessment {
  readonly confidence: Confidence;
  /** Human-readable reasons confidence was reduced, for evidence/trace. */
  readonly deductions: readonly string[];
}

/**
 * The business date a metric describes.
 *
 * Read from the metric's id (`<key>:<clinic>:<date>`), which the Metrics Engine
 * stamps with the clinic-local business date. It used to be the date part of
 * `timestamp` — a UTC instant — which differs from the business date whenever the
 * clinic is not in UTC: an Asia/Kolkata run before 05:30 local, or any history
 * day re-derived for a clinic west of UTC, marked every metric as describing
 * another period and docked every signal's confidence for it.
 */
export function metricDatePart(metric: Metric): string {
  if (metric.period?.start !== undefined) return metric.period.start.slice(0, 10);
  const fromId = metric.id.slice(metric.id.lastIndexOf(":") + 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(fromId) ? fromId : metric.timestamp.slice(0, 10);
}

/** How many of these metrics describe a period other than `date`. */
export function countStaleMetrics(metrics: readonly Metric[], date: string): number {
  return metrics.filter((metric) => metricDatePart(metric) !== date).length;
}

/** Compute data-completeness confidence. Rounded to 2dp for stable output. */
export function computeConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const { confidence: rules, appointments } = input.config;
  const deductions: string[] = [];
  let score = 1;

  const missingOptional = input.missingOptionalMetrics ?? 0;
  if (missingOptional > 0) {
    score -= rules.missingOptionalMetricPenalty * missingOptional;
    deductions.push(`${missingOptional} optional metric(s) absent`);
  }

  if (
    input.denominator !== undefined &&
    input.denominator < appointments.minimumAppointmentSample
  ) {
    score -= rules.smallSamplePenalty;
    deductions.push(
      `governing denominator ${input.denominator} below minimum sample ${appointments.minimumAppointmentSample}`,
    );
  }

  const stale = input.staleMetrics ?? 0;
  if (stale > 0) {
    score -= rules.stalePeriodPenalty;
    deductions.push(`${stale} metric(s) describe a different period`);
  }

  return {
    confidence: round2(clamp(score, rules.floor, 1)),
    deductions,
  };
}

/** Mean confidence across emitted signals; 1 when nothing was emitted. */
export function meanConfidence(values: readonly (number | undefined)[]): Confidence {
  const present = values.filter((v): v is number => typeof v === "number");
  if (present.length === 0) return 1;
  const total = present.reduce((sum, v) => sum + v, 0);
  return round2(total / present.length);
}
