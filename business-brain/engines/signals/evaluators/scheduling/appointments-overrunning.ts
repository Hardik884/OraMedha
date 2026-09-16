/**
 * Signal: scheduling.appointments_overrunning
 *
 * Business rule: across the trailing window, appointments took materially longer
 * than the time booked for them.
 *
 * ## The one rule that needs two ledgers
 *
 * Every other signal in the engine reads one kind of record. This one compares
 * what the appointment book PLANNED against what the queue RECORDED, and neither
 * ledger can answer the question alone. A scheduling tool knows only the plan; a
 * check-in screen knows only the actual; a clinic running both as separate
 * products can never subtract one from the other.
 *
 * ## Why it is measured over the window and not the day
 *
 * A booking template is not an event. One difficult extraction on a Tuesday says
 * nothing; the same 30% overrun sustained across seventy visits says the clinic's
 * slot lengths are systematically short and every future day inherits the error.
 * That is also why the severity is capped: this is a standing condition, and it
 * must never outrank something actually going wrong on the day the dentist reads
 * the card.
 *
 * ## Both guards are load-bearing
 *
 * The sample guard (`minimumMeasuredVisits`) is required because the metric
 * cannot judge itself: +40% over four visits and over eighty are different
 * claims. Below the minimum the rule returns `no_signal` with the sample stated,
 * rather than a low-confidence signal — a clinic should not be told its booking
 * policy is broken on the evidence of a handful of visits.
 *
 * The rate guard is one-sided ON PURPOSE. Appointments finishing EARLY is a
 * negative overrun, and it is not this rule's finding: it may mean slots are
 * generously booked, or simply that staff close queue entries promptly. Reporting
 * it here would attach one action ("book longer") to two opposite observations.
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
  MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D,
  MetricKey.SCHEDULING_MEASURED_VISITS_30D,
] as const;
const OPTIONAL = [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D] as const;

export const appointmentsOverrunningEvaluator: SignalEvaluator = {
  type: SignalType.SCHEDULING_APPOINTMENTS_OVERRUNNING,
  category: SignalCategory.SCHEDULING,
  requiredMetrics: REQUIRED,
  optionalMetrics: OPTIONAL,

  evaluate(ctx: EvaluatorContext): EvaluatorOutcome {
    const required = ctx.metrics.require(...REQUIRED);
    if (!required.ok) return skippedForMissing(required.missing);

    const overrun = required.metrics.value(MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D);
    const sample = required.metrics.value(MetricKey.SCHEDULING_MEASURED_VISITS_30D);
    const { appointments } = ctx.config;

    if (sample < appointments.minimumMeasuredVisits) {
      return {
        kind: "no_signal",
        reason: `Only ${sample} visit(s) had both a called-in and a finished time, below the ${appointments.minimumMeasuredVisits} needed to judge booked length against actual.`,
      };
    }

    if (overrun <= appointments.appointmentOverrunRate) {
      return {
        kind: "no_signal",
        reason: `Appointments ran ${overrun}% over their booked time across ${sample} visits, within the ${appointments.appointmentOverrunRate}% limit.`,
      };
    }

    // Describes the finding; never gates it. A clinic that overruns while
    // half-empty and one that overruns while full have the same broken template —
    // separating them is the Diagnosis Engine's work, not this rule's.
    const utilization = ctx.metrics.get(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D);

    return buildThresholdSignal(ctx, {
      type: SignalType.SCHEDULING_APPOINTMENTS_OVERRUNNING,
      category: SignalCategory.SCHEDULING,
      title: "Appointments running longer than booked",
      description: `Across ${sample} visits in the last 30 days, appointments took ${overrun}% longer than the time booked for them, against a limit of ${appointments.appointmentOverrunRate}%.`,
      observed: {
        label: "Time taken over time booked",
        value: overrun,
        unit: MetricUnit.PERCENTAGE,
      },
      threshold: {
        label: "Configured overrun limit",
        value: appointments.appointmentOverrunRate,
        unit: MetricUnit.PERCENTAGE,
        direction: ThresholdDirection.UPPER,
      },
      inputs: [
        { label: "Visits with a measured length", value: sample, unit: MetricUnit.COUNT },
        ...(utilization
          ? [
              {
                label: "Chair utilization (30 days)",
                value: utilization.value,
                unit: MetricUnit.PERCENTAGE,
              },
            ]
          : []),
      ],
      missingOptionalMetrics: utilization ? 0 : 1,
      metricsRead: utilization ? [...required.metrics.all, utilization] : required.metrics.all,
    });
  },
};
