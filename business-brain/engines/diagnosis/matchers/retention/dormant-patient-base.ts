/**
 * Pattern: dormant_patient_base
 *
 * Correlation: more patients have gone quiet — seen at least once, not back for a
 * full recall interval, nothing booked — than the clinic's configured limit. One
 * directly-measured fact off the patient roster, so it is reported on its own
 * rather than left unclustered.
 *
 * ## Two guards, and each excludes a different kind of double-report
 *
 * `returning_volume_dropping` absent: when return visits are measurably falling,
 * the dormant base is one symptom of a contraction that patient_base_erosion and
 * recall_process_failure localise more sharply. Same guard, same reasoning, as
 * acquisition_shortfall and recall_backlog already use.
 *
 * `followup_backlog` absent: this is the guard that keeps the new RETENTION and
 * REACTIVATION cards from being two cards about the same morning's phone calls.
 * When the clinic has an overdue recall list, that list IS its own record of who
 * to ring, it is more specific than a roster query, and working it is the first
 * action either card would name. So recall_backlog owns the finding and this
 * stands down.
 *
 * What is left is the case nothing in the pipeline could previously see: a clinic
 * whose recall list is empty or current — so no backlog signal can fire — while a
 * large share of its patient base has quietly stopped coming. The recall list
 * looks immaculate precisely BECAUSE nobody was ever put on it.
 *
 * ## What is not asserted
 *
 * The SIZE of the dormant base is supported. Why those patients stopped coming —
 * moved away, went to a competitor, finished their treatment and needed nothing —
 * is not separable from the roster, so the diagnosis names the population and
 * stops. It does not claim they are recoverable, and the strategy it leads to asks
 * the clinic to make contact, not to expect an outcome.
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

const REQUIRED = [SignalType.RETENTION_LAPSED_PATIENT_BASE] as const;
const EXCLUDED = [
  SignalType.RETENTION_RETURNING_VOLUME_DROPPING,
  SignalType.RETENTION_FOLLOWUP_BACKLOG,
] as const;
const OPTIONAL: readonly SignalType[] = [];

const DORMANT =
  "A share of the patient base above the clinic's limit has been seen before, has not returned within a recall interval, and has nothing booked — while the clinic's own recall list shows no backlog.";

export const dormantPatientBaseMatcher: PatternMatcher = {
  pattern: DiagnosisPattern.DORMANT_PATIENT_BASE,
  category: SignalCategory.RETENTION,
  requiredSignals: REQUIRED,
  optionalSignals: OPTIONAL,
  rule: "Requires a lapsed patient base above the limit, with BOTH the returning-volume-dropping and follow-up-backlog signals absent (a measured fall in returning volume is reported as recall process failure; an overdue recall list is reported as recall backlog, which names the same phone calls more specifically).",

  match(ctx: MatcherContext): MatcherOutcome {
    const lapsed = ctx.signals.get(SignalType.RETENTION_LAPSED_PATIENT_BASE);
    if (!lapsed) {
      return notMatched(`Required signal absent: ${absenceSummary(ctx, REQUIRED)}.`);
    }

    for (const excluded of EXCLUDED) {
      if (!ctx.signals.has(excluded)) continue;
      const instead =
        excluded === SignalType.RETENTION_RETURNING_VOLUME_DROPPING
          ? DiagnosisPattern.RECALL_PROCESS_FAILURE
          : DiagnosisPattern.RECALL_BACKLOG;
      return notMatched(
        `${excluded} is present, so the dormant base is not an isolated finding. Reported as ${instead} instead.`,
      );
    }

    const candidates = metricValue(ctx, MetricKey.PATIENTS_REACTIVATION_CANDIDATES);
    const overdue = metricValue(ctx, MetricKey.FOLLOWUPS_OVERDUE);
    const returning = metricValue(ctx, MetricKey.PATIENTS_RETURNING_TODAY);
    const { patients, followups } = ctx.config.signals;

    const arithmetic: EvidenceNote = {
      slug: "retention.dormant_base",
      description: `Patients gone quiet ${candidates ?? "unavailable"} against the configured limit ${patients.lapsedPatientLimit}, with ${overdue ?? "an unavailable number of"} overdue follow-up(s) against a limit of ${followups.overdueFollowupLimit} and ${returning ?? "an unavailable number of"} returning patient(s) today. The dormant base exceeds its limit while the recall list is within its own, so the two describe different people.`,
      data: {
        lapsedPatients: candidates,
        lapsedPatientLimit: patients.lapsedPatientLimit,
        overdueFollowUps: overdue,
        overdueFollowupLimit: followups.overdueFollowupLimit,
        returningToday: returning,
      },
    };

    const hypotheses: HypothesisSpec[] = [
      {
        slug: "dormant_patient_base",
        statement: DORMANT,
        status: "supported",
        supporting: [
          {
            slug: "lapsed-over-limit",
            description: `Patients with no visit for a full recall interval and nothing booked exceed the clinic's configured limit of ${patients.lapsedPatientLimit}, with no overdue recall backlog and no measured fall in returning volume to account for them.`,
            data: { lapsedPatients: candidates, limit: patients.lapsedPatientLimit },
          },
        ],
      },
    ];

    return emit(ctx, {
      pattern: DiagnosisPattern.DORMANT_PATIENT_BASE,
      category: SignalCategory.RETENTION,
      title: "Patients gone quiet with nothing on the recall list",
      summary: `Patients who have been seen before but not within a recall interval, and who have nothing booked, are above the clinic's configured limit — while the overdue recall list is within its own limit, so these are not the patients that list covers.`,
      contributing: [lapsed],
      requiredSignals: REQUIRED,
      optionalSignals: OPTIONAL,
      hypotheses,
      discriminators: [],
      evidence: [arithmetic],
    });
  },
};
