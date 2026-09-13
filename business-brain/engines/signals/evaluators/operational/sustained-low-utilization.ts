/**
 * Signal: operational.sustained_low_utilization
 *
 * Business rule: over the trailing window, the clinic booked materially less of
 * the chair time it offered than it should have.
 *
 * ## Why the daily rule is not enough, and is part of the problem
 *
 * `low_chair_utilization` reads one date. Dentistry is lumpy — a quiet Tuesday
 * after a festival, a morning of cancellations, a day the dentist blocked for
 * admin and forgot to close — and the daily rule fires on all of them at the same
 * severity as a genuinely empty month. That is the mechanism by which a dashboard
 * trains a dentist to stop opening it.
 *
 * This reads `capacity.chair_utilization_30d`, computed and consumed by nothing
 * until now. Its threshold sits BELOW the daily one on purpose: a month averaging
 * under 40% is a materially worse claim than a single day under 50%, and setting
 * them equal would make this fire for every clinic the daily rule already
 * over-fires for.
 *
 * ## No open-slots guard is needed
 *
 * The daily rule needs one, because a closed day reports 0% utilization against 0
 * open minutes and must stay silent. The 30-day figure has the clinic's offered
 * chair-minutes across the whole window as its denominator, so closed days
 * contribute nothing to either side of the ratio, and the metric is withheld
 * outright for a clinic that offered no capacity at all.
 */

import { MetricUnit, SignalCategory, SignalType } from "../../../../domain";
import { MetricKey } from "../../../metrics/metric-ids";
import { ThresholdDirection } from "../../support/severity";
import { buildThresholdSignal } from "../../support/signal-builder";
import {
  skippedForMissing,
  type EvaluatorContext,
  type EvaluatorOutcome,
  type SignalEvaluator,
} from "../types";

const REQUIRED = [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D] as const;
const OPTIONAL = [MetricKey.CAPACITY_CHAIR_UTILIZATION] as const;

export const sustainedLowUtilizationEvaluator: SignalEvaluator = {
  type: SignalType.OPERATIONAL_SUSTAINED_LOW_UTILIZATION,
  category: SignalCategory.OPERATIONAL,
  requiredMetrics: REQUIRED,
  optionalMetrics: OPTIONAL,

  evaluate(ctx: EvaluatorContext): EvaluatorOutcome {
    const required = ctx.metrics.require(...REQUIRED);
    if (!required.ok) return skippedForMissing(required.missing);

    const sustained = required.metrics.value(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D);
    const { capacity } = ctx.config;

    if (sustained >= capacity.minimumSustainedChairUtilization) {
      return {
        kind: "no_signal",
        reason: `30-day chair utilization ${sustained}% at or above the minimum ${capacity.minimumSustainedChairUtilization}%.`,
      };
    }

    // Read to describe, never to gate. Today being busy does not undo a month of
    // empty chairs, and a clinic reading this card is entitled to see both.
    const today = ctx.metrics.get(MetricKey.CAPACITY_CHAIR_UTILIZATION);

    return buildThresholdSignal(ctx, {
      type: SignalType.OPERATIONAL_SUSTAINED_LOW_UTILIZATION,
      category: SignalCategory.OPERATIONAL,
      title: "Chair time going unused month after month",
      description: `Over the last 30 days the clinic booked ${sustained}% of the chair time it offered, against a minimum of ${capacity.minimumSustainedChairUtilization}%. This is a standing level rather than one quiet day.`,
      observed: {
        label: "Chair utilization (30 days)",
        value: sustained,
        unit: MetricUnit.PERCENTAGE,
      },
      threshold: {
        label: "Minimum sustained chair utilization",
        value: capacity.minimumSustainedChairUtilization,
        unit: MetricUnit.PERCENTAGE,
        direction: ThresholdDirection.LOWER,
      },
      inputs: today
        ? [{ label: "Chair utilization today", value: today.value, unit: MetricUnit.PERCENTAGE }]
        : [],
      missingOptionalMetrics: today ? 0 : 1,
      metricsRead: today ? [...required.metrics.all, today] : required.metrics.all,
    });
  },
};
