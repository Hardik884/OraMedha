/**
 * Signal: retention.lapsed_patient_base
 *
 * Business rule: more patients than the configured limit have been seen at least
 * once, have not been back for a recall interval, and have nothing booked.
 *
 * ## Why the metric behind this reached nobody until now
 *
 * `patients.reactivation_candidates` has been computed correctly for a long time
 * and consumed by exactly one thing: the Value Engine, to SIZE the retention
 * bottleneck. Sizing is not raising. Nothing could ever put the number in front of
 * a dentist, because the retention constraint only comes into existence when the
 * follow-up backlog or the returning-volume rule fires — and neither of those can
 * see a lapsed patient who was never put on a follow-up list in the first place.
 *
 * That is the gap, and it is the common case rather than an edge one. A clinic
 * that simply does not use follow-ups has zero overdue follow-ups by
 * construction, so its recall list looks immaculate while two hundred patients
 * quietly go elsewhere.
 *
 * ## No sample guard, and no activity guard
 *
 * This is a LEVEL read off the patient roster, not a rate and not a property of
 * the business date. There is no denominator to be small, and a closed day does
 * not make the finding less true — a clinic's dormant patients are dormant on
 * Sunday too. The metric is withheld outright when the repository supplies no
 * roster, so a deployment that cannot answer the question skips rather than
 * reporting a confident zero.
 *
 * The reactivation interval itself is the clinic's own
 * (`clinic_settings.recall_interval_days`), resolved inside the calculator — so
 * an orthodontic list reviewing in weeks and an implant-led one reviewing in
 * years are each judged against their own definition of "gone quiet".
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

const REQUIRED = [MetricKey.PATIENTS_REACTIVATION_CANDIDATES] as const;
const OPTIONAL = [MetricKey.FOLLOWUPS_OVERDUE] as const;

export const lapsedPatientBaseEvaluator: SignalEvaluator = {
  type: SignalType.RETENTION_LAPSED_PATIENT_BASE,
  category: SignalCategory.RETENTION,
  requiredMetrics: REQUIRED,
  optionalMetrics: OPTIONAL,

  evaluate(ctx: EvaluatorContext): EvaluatorOutcome {
    const required = ctx.metrics.require(...REQUIRED);
    if (!required.ok) return skippedForMissing(required.missing);

    const lapsed = required.metrics.value(MetricKey.PATIENTS_REACTIVATION_CANDIDATES);
    const { patients } = ctx.config;

    if (lapsed <= patients.lapsedPatientLimit) {
      return {
        kind: "no_signal",
        reason: `${lapsed} lapsed patient(s) within limit ${patients.lapsedPatientLimit}.`,
      };
    }

    // Read only to describe the finding. Deliberately NOT a gate: the whole point
    // is that this fires when the recall list looks clean. The comparison between
    // the two populations is the Diagnosis Engine's job, not this rule's.
    const overdue = ctx.metrics.get(MetricKey.FOLLOWUPS_OVERDUE);

    return buildThresholdSignal(ctx, {
      type: SignalType.RETENTION_LAPSED_PATIENT_BASE,
      category: SignalCategory.RETENTION,
      title: "Patients gone quiet with nothing booked",
      description:
        `${lapsed} patients have been seen before, have not been back for a full recall interval, and have no appointment booked, against a configured limit of ${patients.lapsedPatientLimit}` +
        (overdue === undefined
          ? "."
          : `. The clinic's overdue recall list holds ${overdue.value}, so the two populations are not the same people.`),
      observed: {
        label: "Patients gone quiet with nothing booked",
        value: lapsed,
        unit: MetricUnit.COUNT,
      },
      threshold: {
        label: "Configured limit for lapsed patients",
        value: patients.lapsedPatientLimit,
        unit: MetricUnit.COUNT,
        direction: ThresholdDirection.UPPER,
      },
      inputs: overdue
        ? [{ label: "Overdue follow-ups", value: overdue.value, unit: MetricUnit.COUNT }]
        : [],
      missingOptionalMetrics: overdue ? 0 : 1,
      metricsRead: overdue ? [...required.metrics.all, overdue] : required.metrics.all,
    });
  },
};
