/**
 * Pattern: sustained_idle_capacity
 *
 * Correlation: across the trailing window, the clinic booked materially less of
 * the chair time it offered than it should have. One measured fact about a habit
 * rather than about a date.
 *
 * ## Why this is not demand_supply_mismatch with a longer window
 *
 * `demand_supply_mismatch` requires TODAY's low-utilization signal, and its whole
 * job is to discriminate between three same-day readings: demand existed and went
 * unconverted, demand was genuinely thin, or no chair time was published at all.
 * Those are questions about a date, and it answers them well.
 *
 * A clinic can pass that check on most days — one quiet Tuesday is below the bar,
 * the next three days are fine — and still average 33% across the month, because
 * the daily rule sees a sequence of individually forgivable days. That clinic
 * currently receives a low-severity capacity signal on scattered days and no
 * statement at all about the month, which is the only timescale on which the
 * finding is actionable: you cannot add or remove a session in response to a
 * Tuesday.
 *
 * ## No exclusion guard, deliberately
 *
 * Every other standalone matcher added to this engine carries one. This does not,
 * and the reason is structural rather than an omission: both this and
 * `demand_supply_mismatch` map to `ConstraintCategory.CAPACITY`, so when a clinic
 * is quiet today AND quiet this month the Constraint Engine collapses them into
 * one bottleneck at the worse of the two severities, with both findings named in
 * its description. Two diagnoses, one card. That collapse is precisely what the
 * Constraint Engine exists to do, and guarding here would instead throw away the
 * window reading on exactly the clinics that need it most.
 *
 * ## What is not asserted
 *
 * WHY the chair is under-used is not separable from a utilization figure — thin
 * demand, capacity published that nobody wants, a clinic deliberately working
 * part-time — so no cause is claimed. The one thing worth distinguishing is
 * whether the clinic is short of patients or short of conversion, and the pending
 * treatment pipeline is the measurement that speaks to it, so it is read into the
 * evidence without being turned into a conclusion.
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

const REQUIRED = [SignalType.OPERATIONAL_SUSTAINED_LOW_UTILIZATION] as const;
const OPTIONAL = [SignalType.CLINICAL_ACCEPTED_TREATMENTS_UNSCHEDULED] as const;

const SUSTAINED_IDLE =
  "The clinic has been booking materially less of the chair time it offers than it should, across the window rather than on any single day.";

export const sustainedIdleCapacityMatcher: PatternMatcher = {
  pattern: DiagnosisPattern.SUSTAINED_IDLE_CAPACITY,
  category: SignalCategory.OPERATIONAL,
  requiredSignals: REQUIRED,
  optionalSignals: OPTIONAL,
  rule: "Requires sustained low chair utilization across the trailing window. Unbooked planned treatment strengthens it. No exclusion guard: this and demand_supply_mismatch both map to the capacity bottleneck, so the Constraint Engine collapses them into one card rather than two.",

  match(ctx: MatcherContext): MatcherOutcome {
    const sustained = ctx.signals.get(SignalType.OPERATIONAL_SUSTAINED_LOW_UTILIZATION);
    if (!sustained) {
      return notMatched(`Required signal absent: ${absenceSummary(ctx, REQUIRED)}.`);
    }

    const optionalPresent = ctx.signals.present(OPTIONAL);
    const contributing = [sustained, ...optionalPresent];

    const utilization30d = metricValue(ctx, MetricKey.CAPACITY_CHAIR_UTILIZATION_30D);
    const utilizationToday = metricValue(ctx, MetricKey.CAPACITY_CHAIR_UTILIZATION);
    const unbooked = metricValue(ctx, MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING);
    const { capacity } = ctx.config.signals;

    const arithmetic: EvidenceNote = {
      slug: "capacity.sustained",
      description: `Chair utilization over the window ${utilization30d ?? "unavailable"}% against the configured sustained minimum ${capacity.minimumSustainedChairUtilization}%, with today reading ${utilizationToday ?? "unavailable"}%. Patients with planned treatment and no next visit booked: ${unbooked ?? "unavailable"}. That count is stated because it speaks to whether the clinic is short of patients or short of conversion; it is not treated as settling which, because a utilization figure cannot.`,
      data: {
        chairUtilization30d: utilization30d,
        minimumSustainedChairUtilization: capacity.minimumSustainedChairUtilization,
        chairUtilizationToday: utilizationToday,
        patientsWithUnbookedTreatment: unbooked,
      },
    };

    const hypotheses: HypothesisSpec[] = [
      {
        slug: "sustained_idle_capacity",
        statement: SUSTAINED_IDLE,
        status: "supported",
        supporting: [
          {
            slug: "window-below-minimum",
            description: `Across the window the clinic booked ${utilization30d ?? "less than the minimum"}% of the chair time it offered, below the configured sustained minimum of ${capacity.minimumSustainedChairUtilization}%. Closed days contribute to neither side of the ratio, so this is not an artefact of the clinic being shut.`,
            data: {
              chairUtilization30d: utilization30d,
              minimum: capacity.minimumSustainedChairUtilization,
            },
          },
        ],
      },
    ];

    return emit(ctx, {
      pattern: DiagnosisPattern.SUSTAINED_IDLE_CAPACITY,
      category: SignalCategory.OPERATIONAL,
      title: "Chair time going unused across the month",
      summary: `Over the trailing window the clinic booked a share of its offered chair time below the configured sustained minimum, which is a standing level rather than a single quiet day.`,
      contributing,
      requiredSignals: REQUIRED,
      optionalSignals: OPTIONAL,
      hypotheses,
      discriminators: [],
      evidence: [arithmetic],
    });
  },
};
