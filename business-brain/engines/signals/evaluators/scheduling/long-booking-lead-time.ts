/**
 * Signal: scheduling.long_booking_lead_time
 *
 * Business rule: the median gap between a patient booking and being seen is longer
 * than the clinic should be making people wait.
 *
 * ## This is a SUPPORTING signal, and that is a deliberate limitation
 *
 * `scheduling.booking_lead_time_days` was built as the discriminator between two
 * capacity readings that look identical in every other number: a clinic whose
 * chairs are full because demand exceeds capacity, and one whose chairs are full
 * because the day is packed too tightly. It has been computed and read by nothing.
 *
 * It is wired as an OPTIONAL strengthening signal on `capacity_ceiling` rather
 * than as a finding of its own, because alone a long lead time is genuinely
 * ambiguous. A patient who books a routine check-up three weeks out because that
 * suits them is indistinguishable, in this metric, from a patient who wanted
 * Tuesday and was offered the 24th. Reported alone it would accuse a clinic of
 * turning demand away on evidence that does not support it.
 *
 * Alongside near-full capacity it stops being ambiguous, which is the whole
 * argument for correlating signals rather than judging them one at a time.
 *
 * ## Median, and no sample guard
 *
 * The metric is already a median, so one appointment booked six months out cannot
 * move it, and it is withheld entirely when no appointment in the window has a
 * usable lead time. Negative lead times — backdated migration rows, where the
 * record was created after the visit — are excluded by the calculator as
 * historical noise rather than booking behaviour.
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

const REQUIRED = [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS] as const;
const OPTIONAL = [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D] as const;

export const longBookingLeadTimeEvaluator: SignalEvaluator = {
  type: SignalType.SCHEDULING_LONG_BOOKING_LEAD_TIME,
  category: SignalCategory.SCHEDULING,
  requiredMetrics: REQUIRED,
  optionalMetrics: OPTIONAL,

  evaluate(ctx: EvaluatorContext): EvaluatorOutcome {
    const required = ctx.metrics.require(...REQUIRED);
    if (!required.ok) return skippedForMissing(required.missing);

    const leadTime = required.metrics.value(MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS);
    const { appointments } = ctx.config;

    if (leadTime <= appointments.longBookingLeadTimeDays) {
      return {
        kind: "no_signal",
        reason: `Median booking lead time ${leadTime} day(s), within the ${appointments.longBookingLeadTimeDays}-day limit.`,
      };
    }

    const utilization = ctx.metrics.get(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D);

    return buildThresholdSignal(ctx, {
      type: SignalType.SCHEDULING_LONG_BOOKING_LEAD_TIME,
      category: SignalCategory.SCHEDULING,
      title: "Patients waiting a long time for an appointment",
      description: `The median gap between booking and being seen is ${leadTime} days, against a limit of ${appointments.longBookingLeadTimeDays}. On its own this is also consistent with patients choosing later dates; read alongside chair utilization it distinguishes a clinic that is genuinely booked out.`,
      observed: {
        label: "Median booking lead time",
        value: leadTime,
        unit: MetricUnit.DAYS,
      },
      threshold: {
        label: "Configured lead-time limit",
        value: appointments.longBookingLeadTimeDays,
        unit: MetricUnit.DAYS,
        direction: ThresholdDirection.UPPER,
      },
      inputs: utilization
        ? [
            {
              label: "Chair utilization (30 days)",
              value: utilization.value,
              unit: MetricUnit.PERCENTAGE,
            },
          ]
        : [],
      missingOptionalMetrics: utilization ? 0 : 1,
      metricsRead: utilization ? [...required.metrics.all, utilization] : required.metrics.all,
    });
  },
};
