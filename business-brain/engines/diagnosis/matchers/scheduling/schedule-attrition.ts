/**
 * Pattern: schedule_attrition
 *
 * Correlation: appointments booked and then lost. Cancellations and no-shows are
 * one story about the schedule leaking, and when idle chairs or a revenue
 * shortfall appear the same day, they are the downstream half of it.
 *
 * Discrimination — cancellation-dominant vs no-show-dominant. Partially
 * separable, and worth separating: a cancellation means the patient decided in
 * advance and the slot was, in principle, recoverable. A no-show means the patient
 * did not communicate at all. Different mechanisms.
 *
 * What is NOT separable, and must not be claimed: WHY either happened. Nothing in
 * the metric set can distinguish a reminder that never sent from a reminder that
 * was ignored, an awkward slot time from an unpopular treatment type, or a local
 * illness outbreak from anything else. Those hypotheses stay undetermined with
 * discriminators attached — which is the honest answer, not a gap in the rules.
 *
 * ## Three triggers, one pattern
 *
 * The two daily rate signals judge TODAY, and both carry a sample guard because at
 * a five-appointment clinic one cancellation is 20%. `sustained_attrition` judges
 * the trailing window, where the denominator is large enough to mean something and
 * comparable to the industry figures. It triggers this same pattern rather than a
 * new one, deliberately: "appointments booked and then lost" is one bottleneck
 * whether it is read over a day or a month, and giving the window reading its own
 * pattern would put a second scheduling card on the dashboard describing the same
 * appointments.
 *
 * The discrimination between cancellation- and no-show-dominant still runs off
 * TODAY's counts, because those are the only counts the engine has per outcome. On
 * a day triggered only by the window signal, today's counts may be zero on both
 * sides — in which case neither dominance is called and both hypotheses stay
 * undetermined, which is the correct answer rather than a shortcoming.
 */

import { DiagnosisPattern, MetricUnit, SignalCategory, SignalType } from "../../../../domain";
import { MetricKey } from "../../../metrics/metric-ids";
import { formatValue } from "../../../signals/support/evidence";
import { round2 } from "../../../signals/support/numbers";
import type { DiscriminatorDeclaration } from "../../support/diagnosis-builder";
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

const REQUIRED = [
  SignalType.SCHEDULING_HIGH_CANCELLATION_RATE,
  SignalType.SCHEDULING_HIGH_NO_SHOW_RATE,
  SignalType.SCHEDULING_SUSTAINED_ATTRITION,
] as const;

const OPTIONAL = [
  SignalType.OPERATIONAL_LOW_CHAIR_UTILIZATION,
  SignalType.REVENUE_LOW_DAILY_REVENUE,
] as const;

const CANCELLATION_DOMINANT =
  "Lost appointments are predominantly advance cancellations rather than no-shows, so the slots were released before the appointment time.";
const NO_SHOW_DOMINANT =
  "Lost appointments are predominantly no-shows rather than advance cancellations, so the slots were held until the appointment time and then went unused.";
const REMINDER_PROCESS =
  "Appointment reminders were not delivered for the appointments that were lost.";
const SLOT_CLUSTERING =
  "Lost appointments are concentrated in a subset of appointment slots or treatment types rather than spread across the day.";
const PATIENT_LEVEL_PATTERN =
  "Lost appointments are concentrated among patients with a prior history of not attending.";

export const scheduleAttritionMatcher: PatternMatcher = {
  pattern: DiagnosisPattern.SCHEDULE_ATTRITION,
  category: SignalCategory.SCHEDULING,
  requiredSignals: REQUIRED,
  optionalSignals: OPTIONAL,
  rule: "Requires any of a high daily cancellation rate, a high daily no-show rate, or sustained attrition across the trailing window. Low chair utilization and low daily revenue strengthen it.",

  match(ctx: MatcherContext): MatcherOutcome {
    const present = ctx.signals.present(REQUIRED);
    if (present.length === 0) {
      return notMatched(
        `Neither required signal is present: ${absenceSummary(ctx, REQUIRED)}.`,
      );
    }

    const optionalPresent = ctx.signals.present(OPTIONAL);
    const contributing = [...present, ...optionalPresent];

    const cancelled = metricValue(ctx, MetricKey.APPOINTMENTS_CANCELLED_TODAY);
    const noShows = metricValue(ctx, MetricKey.APPOINTMENTS_NO_SHOWS_TODAY);
    const total = metricValue(ctx, MetricKey.APPOINTMENTS_TOTAL_TODAY);
    const cancellationRate30d = metricValue(ctx, MetricKey.SCHEDULING_CANCELLATION_RATE_30D);
    const noShowRate30d = metricValue(ctx, MetricKey.SCHEDULING_NO_SHOW_RATE_30D);
    const windowTriggered = ctx.signals.has(SignalType.SCHEDULING_SUSTAINED_ATTRITION);
    const { dominanceRatio } = ctx.config.discrimination;
    const bothKnown = cancelled !== undefined && noShows !== undefined;

    // Ratio with a zero denominator handled explicitly rather than as Infinity:
    // "8 cancellations and 0 no-shows" is dominance, not an arithmetic error.
    const ratio =
      bothKnown && noShows > 0 ? round2(cancelled / noShows) : undefined;
    const cancellationDominant =
      bothKnown && (noShows === 0 ? cancelled > 0 : cancelled >= noShows * dominanceRatio);
    const noShowDominant =
      bothKnown && (cancelled === 0 ? noShows > 0 : noShows >= cancelled * dominanceRatio);

    const arithmetic: EvidenceNote = {
      slug: "discrimination.attrition-mix",
      description: `Cancellations ${cancelled ?? "unavailable"} versus no-shows ${noShows ?? "unavailable"} out of ${total ?? "an unavailable number of"} booked appointment(s). Ratio ${ratio === undefined ? "undefined" : formatValue(ratio, MetricUnit.RATIO)} against the configured dominance ratio ${formatValue(dominanceRatio, MetricUnit.RATIO)}. Dominance is called only where one side exceeds the other by at least that factor. Over the trailing window: ${cancellationRate30d ?? "unavailable"}% cancelled and ${noShowRate30d ?? "unavailable"}% not attended${windowTriggered ? ", which is what triggered this pattern — the window rates carry a denominator the single-day counts do not" : ""}. The dominance split is read from today's counts because those are the only per-outcome counts available; where today lost nothing, neither dominance is called.`,
      data: {
        cancelled,
        noShows,
        total,
        ratio,
        dominanceRatio,
        cancellationDominant,
        noShowDominant,
        cancellationRate30d,
        noShowRate30d,
        windowTriggered,
      },
    };

    const hypotheses: HypothesisSpec[] = [];
    const discriminators: DiscriminatorDeclaration[] = [
      {
        key: "ATTRITION_MIX",
        separates: ["cancellation_dominant", "no_show_dominant"],
      },
      {
        key: "CANCELLATION_TIMING",
        separates: ["cancellation_dominant", "slot_clustering"],
      },
      {
        key: "CANCELLATION_SLOT_CLUSTERING",
        separates: ["slot_clustering", "reminder_process"],
      },
      {
        key: "SLOT_REFILL_OUTCOME",
        separates: ["cancellation_dominant", "no_show_dominant"],
      },
      {
        key: "REMINDER_DELIVERY_LOG",
        separates: ["reminder_process", "patient_level_pattern"],
      },
      {
        key: "NO_SHOW_PATIENT_HISTORY",
        separates: ["patient_level_pattern", "reminder_process"],
      },
    ];

    if (cancellationDominant && !noShowDominant) {
      hypotheses.push(
        {
          slug: "cancellation_dominant",
          statement: CANCELLATION_DOMINANT,
          status: "supported",
          supporting: [
            {
              slug: "mix",
              description: `Cancellations exceed no-shows by at least the configured dominance ratio, so most lost slots were released in advance of the appointment time.`,
              data: { cancelled, noShows, ratio },
            },
          ],
        },
        {
          slug: "no_show_dominant",
          statement: NO_SHOW_DOMINANT,
          status: "contradicted",
          contradicting: [
            {
              slug: "mix",
              description: `No-shows are the smaller share of lost appointments by at least the configured dominance ratio.`,
              data: { cancelled, noShows, ratio },
            },
          ],
        },
      );
    } else if (noShowDominant && !cancellationDominant) {
      hypotheses.push(
        {
          slug: "no_show_dominant",
          statement: NO_SHOW_DOMINANT,
          status: "supported",
          supporting: [
            {
              slug: "mix",
              description: `No-shows exceed cancellations by at least the configured dominance ratio, so most lost slots were held until the appointment time.`,
              data: { cancelled, noShows, ratio },
            },
          ],
        },
        {
          slug: "cancellation_dominant",
          statement: CANCELLATION_DOMINANT,
          status: "contradicted",
          contradicting: [
            {
              slug: "mix",
              description: `Advance cancellations are the smaller share of lost appointments by at least the configured dominance ratio.`,
              data: { cancelled, noShows, ratio },
            },
          ],
        },
      );
    } else {
      const reason = bothKnown
        ? "the two counts are too close on a single day to call either dominant"
        : "the cancellation and no-show counts were not both supplied";
      hypotheses.push(
        {
          slug: "cancellation_dominant",
          statement: CANCELLATION_DOMINANT,
          status: "undetermined",
          supporting: [
            {
              slug: "balanced-mix",
              description: `Cancellations ${cancelled ?? "unavailable"} and no-shows ${noShows ?? "unavailable"}: ${reason}.`,
              data: { cancelled, noShows, ratio },
            },
          ],
          requires: ["ATTRITION_MIX_OVER_TIME"],
        },
        {
          slug: "no_show_dominant",
          statement: NO_SHOW_DOMINANT,
          status: "undetermined",
          supporting: [
            {
              slug: "balanced-mix",
              description: `Cancellations ${cancelled ?? "unavailable"} and no-shows ${noShows ?? "unavailable"}: ${reason}.`,
              data: { cancelled, noShows, ratio },
            },
          ],
          requires: ["ATTRITION_MIX_OVER_TIME"],
        },
      );
      // A single day's counts could not separate the two, so the measurement that
      // would is the same ratio across more days.
      discriminators.push({
        key: "ATTRITION_MIX_OVER_TIME",
        separates: ["cancellation_dominant", "no_show_dominant"],
      });
    }

    hypotheses.push(
      {
        slug: "reminder_process",
        statement: REMINDER_PROCESS,
        status: "undetermined",
        requires: ["REMINDER_DELIVERY_LOG"],
      },
      {
        slug: "slot_clustering",
        statement: SLOT_CLUSTERING,
        status: "undetermined",
        requires: ["CANCELLATION_SLOT_CLUSTERING", "CANCELLATION_TIMING"],
      },
      {
        slug: "patient_level_pattern",
        statement: PATIENT_LEVEL_PATTERN,
        status: "undetermined",
        requires: ["NO_SHOW_PATIENT_HISTORY"],
      },
    );

    return emit(ctx, {
      pattern: DiagnosisPattern.SCHEDULE_ATTRITION,
      category: SignalCategory.SCHEDULING,
      title: "Booked appointments lost before delivery",
      summary: `Appointments that were booked did not convert into delivered care: ${present.length === 2 ? "both the cancellation rate and the no-show rate breached" : "the rate breached"} its configured threshold for the day.`,
      contributing,
      requiredSignals: REQUIRED,
      optionalSignals: OPTIONAL,
      hypotheses,
      discriminators,
      evidence: [arithmetic],
    });
  },
};
