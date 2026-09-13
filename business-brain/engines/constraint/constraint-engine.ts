/**
 * Business Brain — Constraint Engine
 *
 * Collapses a day's diagnoses into the bottlenecks limiting the clinic.
 *
 * The Diagnosis Engine produces overlapping VIEWS, not a partition: one signal
 * legitimately feeds several patterns, so a bad day can surface six diagnoses
 * describing three problems. That is correct for diagnosis — each pattern is a
 * different lens — and useless for deciding what to do, because six items with
 * no ordering is the same as no guidance at all.
 *
 * A constraint is what several diagnoses are pointing at. Grouping by category
 * means "idle chairs" and "a thin appointment book" become one capacity
 * constraint rather than two competing headlines.
 *
 * ## Still no advice here
 *
 * A constraint NAMES a bottleneck. It does not say what to do about it — that is
 * the Strategy Engine, which is the first component in the whole pipeline
 * allowed to advise. `no-advice.spec.ts` covers this engine's output too.
 *
 * ## Pure
 *
 * Diagnoses in, constraints out. No clock, no I/O, no randomness; `now` is
 * supplied by the caller like everywhere else in this module.
 */

import {
  ConstraintCategory,
  DiagnosisPattern,
  type Constraint,
  type Diagnosis,
} from "../../domain";
import { Severity } from "../../types";

/**
 * Which bottleneck each diagnosis pattern points at.
 *
 * Deliberately many-to-one. `demand_supply_mismatch` and `capacity_ceiling` are
 * opposite readings of the same resource — one says the chairs are empty, the
 * other says they are full — and both are constraints ON CAPACITY. Keeping them
 * in one bucket is what stops the clinic being handed two contradictory
 * headlines on a day when both fire.
 *
 * `unclustered_signal` maps to nothing on purpose: it exists to report a signal
 * that correlated with no pattern, and promoting that to a bottleneck would
 * dress up "we noticed one odd number" as a business problem.
 */
const CATEGORY_BY_PATTERN: Readonly<Record<string, ConstraintCategory>> = {
  [DiagnosisPattern.DEMAND_SUPPLY_MISMATCH]: ConstraintCategory.CAPACITY,
  [DiagnosisPattern.CAPACITY_CEILING]: ConstraintCategory.CAPACITY,
  // NOT capacity. Congestion is the opposite finding about the same resource:
  // routed into CAPACITY it inherited "your chair was empty today" as its wording
  // and today's unbooked minutes as its figure, so a clinic whose patients waited
  // fifty minutes read a card saying its chair sat idle. See
  // ConstraintCategory.PATIENT_FLOW.
  [DiagnosisPattern.THROUGHPUT_CONGESTION]: ConstraintCategory.PATIENT_FLOW,
  // Alongside demand_supply_mismatch on purpose, with no guard in the matcher:
  // one card carrying a date-level and a window-level reading of the same
  // bottleneck, at the worse severity, is the whole point of this engine.
  [DiagnosisPattern.SUSTAINED_IDLE_CAPACITY]: ConstraintCategory.CAPACITY,
  [DiagnosisPattern.SCHEDULE_ATTRITION]: ConstraintCategory.SCHEDULING,
  [DiagnosisPattern.COLLECTION_GAP]: ConstraintCategory.REVENUE_LEAKAGE,
  [DiagnosisPattern.REVENUE_SHORTFALL]: ConstraintCategory.REVENUE_LEAKAGE,
  // The window-level reading of the same bottleneck the day-level collection_gap
  // describes. One revenue card, two findings.
  [DiagnosisPattern.PRODUCTION_COLLECTION_GAP]: ConstraintCategory.REVENUE_LEAKAGE,
  [DiagnosisPattern.PIPELINE_CONVERSION_FAILURE]: ConstraintCategory.TREATMENT_ACCEPTANCE,
  [DiagnosisPattern.PATIENT_BASE_EROSION]: ConstraintCategory.RETENTION,
  [DiagnosisPattern.RECALL_PROCESS_FAILURE]: ConstraintCategory.RETENTION,
  // Standalone single-signal readings (see diagnosis.ts): each names one real,
  // actionable fact that would otherwise be dropped as an unclustered signal.
  [DiagnosisPattern.OUTSTANDING_RECEIVABLES]: ConstraintCategory.REVENUE_LEAKAGE,
  [DiagnosisPattern.RECALL_BACKLOG]: ConstraintCategory.RETENTION,
  [DiagnosisPattern.ACQUISITION_SHORTFALL]: ConstraintCategory.ACQUISITION,
  // Its own bottleneck rather than CAPACITY: same resource, different tense.
  // See the note on ConstraintCategory.FORWARD_SCHEDULE.
  [DiagnosisPattern.FORWARD_SCHEDULE_GAP]: ConstraintCategory.FORWARD_SCHEDULE,
  // Alongside schedule_attrition on purpose: both describe appointments booked
  // and then lost, so they belong to one bottleneck rather than two headlines.
  [DiagnosisPattern.REPEAT_NON_ATTENDANCE]: ConstraintCategory.SCHEDULING,
  // Patients nobody ever put on a recall list. A different population from
  // RETENTION's, needing a different list and different words — see
  // ConstraintCategory.REACTIVATION.
  [DiagnosisPattern.DORMANT_PATIENT_BASE]: ConstraintCategory.REACTIVATION,
  // Its own bottleneck rather than SCHEDULING: schedule_attrition is about
  // appointments the clinic lost, this is about the lengths it books them for.
  [DiagnosisPattern.CHRONIC_APPOINTMENT_OVERRUN]: ConstraintCategory.SCHEDULE_ACCURACY,
};

/** Human-readable name per bottleneck. Factual: names the limit, not a remedy. */
const CONSTRAINT_NAMES: Readonly<Record<ConstraintCategory, string>> = {
  [ConstraintCategory.CAPACITY]: "Chair capacity and how much of it was used",
  [ConstraintCategory.SCHEDULING]: "Appointments booked and then lost",
  [ConstraintCategory.REVENUE_LEAKAGE]: "Work delivered against money received",
  [ConstraintCategory.TREATMENT_ACCEPTANCE]: "Planned treatment with no next visit booked",
  [ConstraintCategory.RETENTION]: "Patients returning, and being brought back",
  [ConstraintCategory.ACQUISITION]: "New patients reaching the clinic",
  [ConstraintCategory.FORWARD_SCHEDULE]: "Chair time in the week ahead, and how much is sold",
  [ConstraintCategory.PATIENT_FLOW]: "Time patients spend waiting once they arrive",
  [ConstraintCategory.REACTIVATION]: "Patients gone quiet, and whether anyone is bringing them back",
  [ConstraintCategory.SCHEDULE_ACCURACY]: "Time booked for appointments against time they take",
};

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  [Severity.INFO]: 0,
  [Severity.LOW]: 1,
  [Severity.MEDIUM]: 2,
  [Severity.HIGH]: 3,
  [Severity.CRITICAL]: 4,
};

export interface ConstraintResult {
  readonly constraints: readonly Constraint[];
}

/**
 * Derive the clinic's bottlenecks from its diagnoses.
 *
 * Severity is the MAXIMUM across contributing diagnoses, never an average.
 * Averaging would let two mild observations dilute a critical one into
 * something that reads as routine, and a bottleneck is as serious as its worst
 * component.
 *
 * Output is sorted by severity and then by category name — never by how many
 * diagnoses contributed. Count measures how many lenses happened to catch a
 * problem, which is a property of the catalogue rather than of the clinic; a
 * single critical finding outranks three low ones.
 */
export function deriveConstraints(
  diagnoses: readonly Diagnosis[],
  clinicId: string,
  date: string,
  now: string,
): ConstraintResult {
  const byCategory = new Map<ConstraintCategory, Diagnosis[]>();

  for (const diagnosis of diagnoses) {
    const category = CATEGORY_BY_PATTERN[diagnosis.pattern];
    if (category === undefined) continue;
    const list = byCategory.get(category) ?? [];
    list.push(diagnosis);
    byCategory.set(category, list);
  }

  const constraints: Constraint[] = [];

  // Iterated in a fixed order so the output is byte-identical across runs; Map
  // insertion order would otherwise follow whatever order diagnoses arrived in.
  for (const category of Object.values(ConstraintCategory).sort()) {
    const contributing = byCategory.get(category);
    if (contributing === undefined || contributing.length === 0) continue;

    const severity = contributing.reduce<string>(
      (worst, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[worst] ? d.severity : worst),
      Severity.INFO,
    );

    // Sorted so the description reads the same way every time, and so the id
    // list a caller stores does not churn between runs over identical data.
    const ids = contributing.map((d) => d.id).sort();
    const titles = contributing
      .map((d) => d.title)
      .sort()
      .join("; ");

    constraints.push({
      id: `constraint.${category}:${clinicId}:${date}`,
      name: CONSTRAINT_NAMES[category],
      description:
        contributing.length === 1
          ? `One finding points here: ${titles}.`
          : `${contributing.length} findings point here: ${titles}.`,
      category,
      severity: severity as Constraint["severity"],
      relatedDiagnosisIds: ids,
      identifiedAt: now,
    });
  }

  constraints.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return bySeverity !== 0 ? bySeverity : a.category.localeCompare(b.category);
  });

  return { constraints };
}
