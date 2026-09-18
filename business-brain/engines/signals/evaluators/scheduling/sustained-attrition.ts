/**
 * Signal: scheduling.sustained_attrition
 *
 * Business rule: across the trailing window, cancellations and no-shows together
 * consumed more of the appointment book than the clinic can absorb.
 *
 * ## The benchmarkable version of a rule that already exists twice
 *
 * `high_cancellation_rate` and `high_no_show_rate` both judge TODAY, and both
 * carry a sample guard to compensate — which is a confession that the denominator
 * is too small. At a five-appointment clinic one cancellation is 20%, twice the
 * threshold, on an entirely ordinary day.
 *
 * `scheduling.cancellation_rate_30d` and `scheduling.no_show_rate_30d` were built
 * to fix exactly this. Only the no-show rate was ever wired up (to
 * `high_no_show_rate` as an optional input); the cancellation rate has been
 * computed and read by nothing at all. This is the rule that reads both.
 *
 * ## Why the two are summed rather than judged separately
 *
 * A cancelled slot and a missed slot are different problems with different fixes,
 * and the daily rules keep them apart for good reason — `schedule_attrition`
 * discriminates between them to decide whether to advise a standby list or a
 * confirmation call. But the question THIS rule asks is prior to that one: how
 * much of the book does the clinic lose? That is one number, and splitting it lets
 * a clinic losing 9% to cancellations and 8% to no-shows clear both thresholds
 * while losing nearly a fifth of everything it books.
 *
 * The composition is preserved in the evidence, so the diagnosis downstream can
 * still say which half dominates without this rule pre-judging it.
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

const REQUIRED = [
  MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
  MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
  // The denominator both rates were divided by. Required rather than optional:
  // without it this rule cannot tell 1-of-3 from 30-of-90, and a rule that
  // cannot tell them apart should say it could not run.
  MetricKey.SCHEDULING_APPOINTMENTS_30D,
] as const;

export const sustainedAttritionEvaluator: SignalEvaluator = {
  type: SignalType.SCHEDULING_SUSTAINED_ATTRITION,
  category: SignalCategory.SCHEDULING,
  requiredMetrics: REQUIRED,

  evaluate(ctx: EvaluatorContext): EvaluatorOutcome {
    const required = ctx.metrics.require(...REQUIRED);
    if (!required.ok) return skippedForMissing(required.missing);

    const cancellation = required.metrics.value(MetricKey.SCHEDULING_CANCELLATION_RATE_30D);
    const noShow = required.metrics.value(MetricKey.SCHEDULING_NO_SHOW_RATE_30D);
    // Both rates share one denominator — every appointment in the window — so they
    // are shares of the same whole and add without double-counting. An appointment
    // carries exactly one status, so none can fall into both.
    const combined = Math.round((cancellation + noShow) * 10) / 10;
    const booked = required.metrics.value(MetricKey.SCHEDULING_APPOINTMENTS_30D);
    const { appointments } = ctx.config;

    // The guard the daily rules have had all along. A 30-day window was assumed
    // to be a large denominator; at five appointments a week it is thirty, and
    // two cancellations clear the limit between them.
    if (booked < appointments.minimumWindowAppointments) {
      return {
        kind: "no_signal",
        reason: `Only ${booked} appointment(s) booked across the window, below the ${appointments.minimumWindowAppointments} needed before a share of them is a rate rather than arithmetic.`,
      };
    }

    if (combined <= appointments.sustainedAttritionRate) {
      return {
        kind: "no_signal",
        reason: `${combined}% of appointments lost over the window (${cancellation}% cancelled, ${noShow}% missed), within the ${appointments.sustainedAttritionRate}% limit.`,
      };
    }

    return buildThresholdSignal(ctx, {
      type: SignalType.SCHEDULING_SUSTAINED_ATTRITION,
      category: SignalCategory.SCHEDULING,
      title: "A sustained share of the book being lost",
      description: `Over the last 30 days ${combined}% of ${booked} booked appointments were cancelled or missed — ${cancellation}% cancelled and ${noShow}% not attended — against a limit of ${appointments.sustainedAttritionRate}%.`,
      observed: {
        label: "Appointments lost (30 days)",
        value: combined,
        unit: MetricUnit.PERCENTAGE,
      },
      threshold: {
        label: "Configured sustained attrition limit",
        value: appointments.sustainedAttritionRate,
        unit: MetricUnit.PERCENTAGE,
        direction: ThresholdDirection.UPPER,
      },
      inputs: [
        {
          label: "Cancellation rate (30 days)",
          value: cancellation,
          unit: MetricUnit.PERCENTAGE,
        },
        { label: "No-show rate (30 days)", value: noShow, unit: MetricUnit.PERCENTAGE },
        { label: "Appointments booked (30 days)", value: booked, unit: MetricUnit.COUNT },
      ],
      denominator: booked,
      metricsRead: required.metrics.all,
    });
  },
};
