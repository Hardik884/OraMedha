/**
 * Pattern: chronic_appointment_overrun
 *
 * Correlation: across the trailing window, appointments took materially longer
 * than the time booked for them. One measured fact, but a fact no single ledger
 * holds — it is the appointment book's plan subtracted from the queue's record.
 *
 * ## Guarded against the queue signals, and this is the important part
 *
 * `throughput_congestion` already carries `service_time_variance` — "individual
 * appointments took longer than their scheduled durations, pushing later patients
 * into the queue" — as a hypothesis it can settle from entity data. When patients
 * actually queued today, that is the sharper story: it has the consequence
 * attached, and the clinic felt it. Reporting this alongside would be the same
 * finding told twice, with the second telling lacking the consequence.
 *
 * So this fires on the days the queue behaved — which is exactly when a clinic
 * does not know it has the problem. A practice that absorbs a 30% overrun by
 * running late every evening never sees a queue backlog at 11am, and every
 * appointment it books from now on inherits the error.
 *
 * ## What is asserted, and what is not
 *
 * Supported: the booked lengths do not match the delivered lengths, at a sample
 * large enough to mean it. Not asserted, because the metric aggregates and cannot
 * see inside itself: WHICH treatments overrun, which clinician, or whether the
 * cause is the booking template or the delivery. The action that follows asks the
 * clinic to look at its own slot lengths — a scheduling decision — and never at
 * how care is delivered.
 */

import { DiagnosisPattern, SignalCategory, SignalType } from "../../../../domain";
import { MetricKey } from "../../../metrics/metric-ids";
import type { EvidenceNote, HypothesisSpec } from "../../support/hypothesis-builder";
import {
  absenceSummary,
  emit,
  metricValue,
  notMatched,
  type MatcherContext,
  type MatcherOutcome,
  type PatternMatcher,
} from "../types";

const REQUIRED = [SignalType.SCHEDULING_APPOINTMENTS_OVERRUNNING] as const;
const EXCLUDED = [
  SignalType.OPERATIONAL_LONG_WAITING_TIME,
  SignalType.OPERATIONAL_QUEUE_BACKLOG,
] as const;
const OPTIONAL: readonly SignalType[] = [];

const OVERRUN =
  "Appointments are consistently taking longer than the time booked for them, so the clinic's booked day is shorter on paper than the day it actually delivers.";

export const chronicAppointmentOverrunMatcher: PatternMatcher = {
  pattern: DiagnosisPattern.CHRONIC_APPOINTMENT_OVERRUN,
  category: SignalCategory.SCHEDULING,
  requiredSignals: REQUIRED,
  optionalSignals: OPTIONAL,
  rule: "Requires appointments overrunning their booked time across the trailing window, with BOTH queue signals absent (when patients queued today, the overrun is reported as the service-time cause of throughput congestion instead).",

  match(ctx: MatcherContext): MatcherOutcome {
    const overrunSignal = ctx.signals.get(SignalType.SCHEDULING_APPOINTMENTS_OVERRUNNING);
    if (!overrunSignal) {
      return notMatched(`Required signal absent: ${absenceSummary(ctx, REQUIRED)}.`);
    }

    for (const excluded of EXCLUDED) {
      if (!ctx.signals.has(excluded)) continue;
      return notMatched(
        `${excluded} is present, so the overrun has a measured consequence today. Reported as ${DiagnosisPattern.THROUGHPUT_CONGESTION} (service_time_variance) instead.`,
      );
    }

    const overrun = metricValue(ctx, MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D);
    const sample = metricValue(ctx, MetricKey.SCHEDULING_MEASURED_VISITS_30D);
    const utilization = metricValue(ctx, MetricKey.CAPACITY_CHAIR_UTILIZATION_30D);
    const { appointments } = ctx.config.signals;

    const arithmetic: EvidenceNote = {
      slug: "scheduling.booked_vs_actual",
      description: `Appointments ran ${overrun ?? "an unavailable amount"}% over their booked time across ${sample ?? "an unavailable number of"} measured visits, against a configured limit of ${appointments.appointmentOverrunRate}%, with 30-day chair utilization ${utilization ?? "unavailable"}. Measured by subtracting the booked duration from the called-in-to-finished interval, so only visits where both ends were recorded contribute. No patient queued beyond the configured limits today, so the overrun is absorbed rather than visible.`,
      data: {
        overrunPercent: overrun,
        measuredVisits: sample,
        appointmentOverrunRate: appointments.appointmentOverrunRate,
        chairUtilization30d: utilization,
      },
    };

    const hypotheses: HypothesisSpec[] = [
      {
        slug: "chronic_appointment_overrun",
        statement: OVERRUN,
        status: "supported",
        supporting: [
          {
            slug: "booked-shorter-than-delivered",
            description: `Over ${sample ?? "the measured"} visits, delivered time exceeded booked time by ${overrun ?? "more than"}%, above the configured limit of ${appointments.appointmentOverrunRate}%. The sample is large enough that no single long appointment accounts for it.`,
            data: { overrunPercent: overrun, measuredVisits: sample },
          },
        ],
      },
    ];

    return emit(ctx, {
      pattern: DiagnosisPattern.CHRONIC_APPOINTMENT_OVERRUN,
      category: SignalCategory.SCHEDULING,
      title: "Appointments booked shorter than they are delivered",
      summary: `Across the trailing window, appointments took materially longer than the time booked for them, on a day when no patient queued beyond the clinic's limits — so the difference is being absorbed by running late rather than showing up as a backlog.`,
      contributing: [overrunSignal],
      requiredSignals: REQUIRED,
      optionalSignals: OPTIONAL,
      hypotheses,
      discriminators: [],
      evidence: [arithmetic],
    });
  },
};
