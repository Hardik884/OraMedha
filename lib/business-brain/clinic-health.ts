/**
 * lib/business-brain/clinic-health.ts
 *
 * The Clinic Health Score — a single 0–100 read of how the clinic is doing today.
 *
 * A NOTE ON WHY THIS EXISTS, given dashboard-view.ts once argued against it.
 * --------------------------------------------------------------------------
 * The Morning Briefing deliberately avoided a numeric score for a long time, on
 * a real principle: "a composite over inputs that have not been individually
 * validated produces a number nobody can explain, and the first time it
 * disagrees with what the dentist sees the whole dashboard loses credibility."
 *
 * That objection is correct, and this module is built to satisfy it rather than
 * ignore it. Every point this score removes is:
 *
 *   1. Measured directly from a live clinic fact — an actual count of overdue
 *      recalls, the actual rupees outstanding — not inferred from a statistical
 *      pattern. A dentist can read "-9: 3 patients overdue for a recall" and
 *      check it against reality in ten seconds.
 *   2. Itemised. The score is never a lone number; it always ships with the
 *      list of deductions that produced it, so it is explainable by construction.
 *   3. Un-gameable. Because each factor is a live measurement, ticking a
 *      checkbox on screen changes nothing. Only genuinely doing the work — the
 *      payment recorded, the visit booked, the recall completed — moves the
 *      underlying number, and therefore the score, on the next page load.
 *   4. Recomputed, never stored. The score is a pure function of the metrics
 *      already fetched for the page, so it can never drift from live data. There
 *      is no write here and nothing to keep in sync.
 *
 * ## What v2 changed, and what it deliberately did not
 *
 * Three additions, none of which touch the four properties above:
 *
 *   - **Two-sided.** Credits, from this clinic's own baselines, sit beside the
 *     deductions. The arithmetic is still a ledger: score = 100 − debits +
 *     credits, with the credit total capped so a clinic can never credit its way
 *     out of a real problem. With no baselines supplied the result is identical
 *     to v1, which is why this was additive rather than a rewrite.
 *   - **Six dimensions.** A grouping of the same itemised lines, not a second
 *     rubric. Each factor already declared the problem category it speaks about;
 *     the dimension is derived from that, so there is no second table able to
 *     drift. Acquisition is NOT a dimension: one noisy daily count is not a
 *     dimension, and dignifying it with one would imply a measurement the data
 *     does not support.
 *   - **A delta.** Derived, never stored: the score is a pure function of metrics
 *     that `metric_history` already records daily, so an earlier day's score is
 *     recomputed from an earlier day's metrics. No new table, no write, and the
 *     "recomputed, never stored" property survives intact.
 *
 * And one thing deliberately not changed: **completing an action still moves
 * nothing directly.** Credits come from measured metrics exactly as deductions
 * do, so ticking something on screen changes no number. The work moves the data,
 * and the data moves the score.
 *
 * The score does NOT read the pipeline's diagnosed "problems" (constraints).
 * That is deliberate: a diagnosed problem only appears once a pattern trips,
 * whereas a clinic can have three overdue recalls and nothing else wrong. The
 * score measures the concrete facts underneath the problems, so it is always
 * present and never double-counts a fact against the pattern built from it.
 */

import { ClinicDimension, type Metric } from "@/business-brain";
import {
  BaselineDirection,
  isImprovement,
  isJudgeable,
  type MetricBaseline,
} from "@/business-brain/engines/baseline";

export type HealthBand = "excellent" | "good" | "attention" | "urgent";

/**
 * Which dimension each problem category belongs to.
 *
 * Derived from the category every factor already declares, rather than a second
 * factor→dimension table: one source of truth, and a factor cannot end up in a
 * dimension its category contradicts.
 *
 * `acquisition` maps to nothing on purpose. It has one metric behind it —
 * patients registered today — and a single noisy daily count is not a dimension.
 * A line in that category still costs points and still appears in the breakdown;
 * it simply is not rolled into a dimension score that would imply more
 * measurement than exists.
 */
const DIMENSION_BY_CATEGORY: Readonly<Record<string, ClinicDimension>> = {
  capacity: ClinicDimension.SCHEDULE_HEALTH,
  forward_schedule: ClinicDimension.SCHEDULE_HEALTH,
  schedule_accuracy: ClinicDimension.SCHEDULE_HEALTH,
  scheduling: ClinicDimension.ATTENDANCE,
  patient_flow: ClinicDimension.PATIENT_FLOW,
  revenue_leakage: ClinicDimension.FINANCIAL_HEALTH,
  treatment_acceptance: ClinicDimension.TREATMENT_PIPELINE,
  retention: ClinicDimension.RETENTION_RECALL,
  reactivation: ClinicDimension.RETENTION_RECALL,
};

/** The six dimensions, in the order a clinic reads them. */
export const SCORE_DIMENSIONS: readonly ClinicDimension[] = [
  ClinicDimension.SCHEDULE_HEALTH,
  ClinicDimension.ATTENDANCE,
  ClinicDimension.PATIENT_FLOW,
  ClinicDimension.FINANCIAL_HEALTH,
  ClinicDimension.TREATMENT_PIPELINE,
  ClinicDimension.RETENTION_RECALL,
];

export const DIMENSION_LABEL: Readonly<Record<ClinicDimension, string>> = {
  [ClinicDimension.SCHEDULE_HEALTH]: "Schedule health",
  [ClinicDimension.ATTENDANCE]: "Attendance",
  [ClinicDimension.PATIENT_FLOW]: "Patient flow",
  [ClinicDimension.FINANCIAL_HEALTH]: "Financial health",
  [ClinicDimension.TREATMENT_PIPELINE]: "Treatment pipeline",
  [ClinicDimension.RETENTION_RECALL]: "Retention & recall",
};

export interface HealthDeduction {
  /** Stable id for the factor, for keys and testing. */
  readonly factor: string;
  /** What was found, in the words a clinic would use. */
  readonly detail: string;
  /** Points removed (a positive number; the score subtracts it). */
  readonly points: number;
  /**
   * The problem category this factor speaks about — a `ConstraintCategory`
   * value, declared here beside the factor that measures it rather than in a
   * lookup table somewhere else.
   *
   * It exists so the briefing can tell a dentist WHICH deductions have a
   * matching problem card below and which do not. The score and the cards are
   * deliberately two different rulebooks (see the header): a fact can be real
   * enough to cost points and still sit under the clinic's calibrated threshold
   * for raising a signal. That is correct, and it looks like a contradiction on
   * screen unless the page says so — which it cannot do without knowing what
   * each line refers to.
   *
   * Colocated deliberately: a separate factor→category table would be a second
   * source of truth able to drift from the factor it describes.
   */
  readonly category: string;
}

/**
 * One point ADDED, and what earned it.
 *
 * Same shape as a deduction because it is the same kind of claim in the other
 * direction: a live measurement, itemised, checkable in ten seconds. A credit is
 * never awarded for an absence of problems — it requires the clinic to be
 * measurably outside its own normal range in the good direction, which is a
 * fact, not the lack of one.
 */
export interface HealthCredit {
  readonly factor: string;
  readonly detail: string;
  /** Points added (a positive number). */
  readonly points: number;
  readonly dimension: ClinicDimension;
}

/** One dimension's standing, and the lines that produced it. */
export interface HealthDimension {
  readonly dimension: ClinicDimension;
  readonly label: string;
  /** 0–100 for this dimension alone. */
  readonly score: number;
  readonly debits: number;
  readonly credits: number;
  /**
   * False when nothing in this dimension could be measured today.
   *
   * A dimension with no measurable input is NOT a dimension scoring 100. The
   * distinction is the same one the metrics keep: withheld is not zero, and an
   * unmeasured dimension reported as perfect would be the most flattering
   * possible lie.
   */
  readonly measured: boolean;
}

/** What moved the score, and by how much, since a comparison day. */
export interface HealthDelta {
  /** Signed points. Positive means the score improved. */
  readonly points: number;
  /** Business date the comparison is against. */
  readonly since: string;
  /** Whole days back that date is. */
  readonly daysAgo: number;
  /** The score on that day, recomputed from its stored metrics. */
  readonly previousScore: number;
  /** Per-dimension movement, largest absolute change first. */
  readonly contributors: readonly HealthDeltaContributor[];
}

export interface HealthDeltaContributor {
  readonly dimension: ClinicDimension;
  readonly label: string;
  /** Signed points this dimension contributed to the overall movement. */
  readonly points: number;
}

export interface ClinicHealth {
  /** 0–100, higher is healthier. */
  readonly score: number;
  readonly band: HealthBand;
  /** "Excellent" / "Good" / "Needs Attention" / "Urgent". */
  readonly bandLabel: string;
  /** Every point removed, itemised, worst first. Empty means a perfect day. */
  readonly deductions: readonly HealthDeduction[];
  /** Every point added, itemised, largest first. Empty is the common case. */
  readonly credits: readonly HealthCredit[];
  /** The six dimensions, always all six, each marked measured or not. */
  readonly dimensions: readonly HealthDimension[];
  /** Set only when the caller supplied a comparison day. */
  readonly delta?: HealthDelta;
}

/**
 * Distinct-patient counts for the two factors that speak of "patients". The
 * underlying metrics count treatment/follow-up ROWS, so a patient with several
 * planned treatments or overdue recalls would be counted more than once. When the
 * page can supply the deduped patient count (from the reminder summaries), the
 * breakdown uses it, so "N patients" here means the same N the problem cards and
 * the "Patients to contact" list show — never an inflated row count.
 */
export interface HealthContext {
  readonly patientCounts?: {
    /** Distinct patients with planned treatment and no next visit. */
    readonly noNextVisit?: number | null;
    /** Distinct patients with an overdue recall follow-up. */
    readonly overdueFollowups?: number | null;
  };
  /**
   * This clinic's own normal range per metric, for the credit side of the ledger.
   *
   * OPTIONAL, and its absence is not a zero: without baselines the score is
   * exactly the v1 deduction ledger, which is the correct behaviour for a clinic
   * with too little history to have a normal range yet. A credit is never awarded
   * from a thin baseline — see `isJudgeable`.
   */
  readonly baselines?: ReadonlyMap<string, MetricBaseline>;
}

// ── Reading a metric value ────────────────────────────────────────────────────

/**
 * Metric ids are "<key>:<clinicId>:<date>", so we match on the key prefix — the
 * same lookup the headline metrics already use. A withheld metric (one the
 * engine could not measure) is simply absent from the array, and returns null
 * here, which every factor treats as "nothing to deduct" rather than "zero".
 */
function metricValue(metrics: readonly Metric[], key: string): number | null {
  const m = metrics.find((x) => x.id.startsWith(`${key}:`));
  return m ? m.value : null;
}

// ── The rubric ────────────────────────────────────────────────────────────────
//
// Each factor reads one live fact and returns how many points to remove, capped
// so no single category can sink the whole score on its own. Weights reflect
// business impact: uncollected cash and lost patients hurt most; a quiet chair
// or a slow queue on one day hurts least. The caps below sum to 74, so a clinic
// where everything is wrong still floors around 26 rather than 0 — a health
// score of zero would be as uninformative as one of a hundred.

interface HealthFactor {
  readonly id: string;
  /** Returns the deduction for this factor, or null if there is nothing to remove. */
  readonly evaluate: (metrics: readonly Metric[], ctx: HealthContext) => HealthDeduction | null;
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

const FACTORS: readonly HealthFactor[] = [
  // Money already earned but not collected. The single highest-impact factor:
  // it is cash the clinic is owed today, and it drops the moment a payment is
  // recorded. Banded rather than per-rupee so a small balance is a nudge and a
  // large one is a real dent, without a linear rule making every clinic look bad.
  {
    id: "outstanding_balance",
    evaluate: (m) => {
      const total = metricValue(m, "revenue.outstanding");
      if (total === null || total <= 0) return null;
      // Netted against whatever is already on an agreed payment plan (see
      // revenue.outstanding_on_payment_plan) before the score judges it — a
      // balance being collected on schedule should not cost points meant for
      // money nobody is chasing. Metric absent (no repository support):
      // behaves exactly as before. Floored: a data-lag moment must never
      // read as negative unmanaged debt.
      const onPlan = metricValue(m, "revenue.outstanding_on_payment_plan");
      const v = onPlan === null ? total : Math.max(0, total - onPlan);
      if (v <= 0) return null;
      const points = v >= 50000 ? 18 : v >= 25000 ? 12 : v >= 10000 ? 6 : 2;
      const planNote = onPlan !== null && onPlan > 0 ? ` (${rupees(onPlan)} on a payment plan)` : "";
      return {
        factor: "Unpaid balances",
        detail: `${rupees(v)} owed for completed work${planNote}`,
        points,
        category: "revenue_leakage",
      };
    },
  },

  // Patients who finished or started treatment but have no next visit booked.
  // Each one is a patient who may never come back unless someone calls. Drops
  // as soon as a visit is booked for them.
  {
    id: "no_next_visit",
    evaluate: (m, ctx) => {
      // Prefer the distinct-patient count when the page supplies it; the raw
      // metric counts treatment rows, which would read as more "patients" than
      // there are and disagree with the action list.
      const override = ctx.patientCounts?.noNextVisit;
      const v = override != null ? override : metricValue(m, "treatment.accepted_pending_scheduling");
      if (v === null || v <= 0) return null;
      const n = Math.round(v);
      const points = Math.min(15, n * 3);
      return {
        factor: "No next visit booked",
        detail: `${n} patient${n === 1 ? "" : "s"} have planned treatment but no next appointment`,
        points,
        category: "treatment_acceptance",
      };
    },
  },

  // Recalls that are past due. Retention is the cheapest revenue in dentistry,
  // and an overdue recall is a patient quietly slipping away. Drops as each
  // recall is completed or the patient is rebooked.
  {
    id: "overdue_followups",
    evaluate: (m, ctx) => {
      // Distinct patients when available; the metric counts follow-up rows.
      const override = ctx.patientCounts?.overdueFollowups;
      const v = override != null ? override : metricValue(m, "followups.overdue");
      if (v === null || v <= 0) return null;
      const n = Math.round(v);
      const points = Math.min(15, n * 3);
      return {
        factor: "Overdue recalls",
        detail: `${n} patient${n === 1 ? "" : "s"} overdue for a check-up reminder`,
        points,
        category: "retention",
      };
    },
  },

  // How often booked patients simply do not turn up, over the last month. A
  // 30-day rate rather than today's count, so it reflects a habit rather than
  // one bad morning — which also means it improves gradually, not instantly.
  {
    id: "no_show_rate",
    evaluate: (m) => {
      const v = metricValue(m, "scheduling.no_show_rate_30d");
      if (v === null || v <= 10) return null;
      const points = v > 30 ? 12 : v > 20 ? 8 : 4;
      return {
        factor: "No-shows",
        detail: `${Math.round(v)}% of appointments were no-shows this month`,
        points,
        category: "scheduling",
      };
    },
  },

  // How much of today's chair time actually got used. Lightly weighted because
  // a single day swings a lot; a genuinely quiet day should register, not
  // dominate.
  {
    id: "chair_utilization",
    evaluate: (m) => {
      const v = metricValue(m, "capacity.chair_utilization");
      if (v === null || v >= 70) return null;
      const points = v < 30 ? 8 : v < 50 ? 5 : 2;
      return {
        factor: "Empty chair time",
        detail: `Chairs were only ${Math.round(v)}% used today`,
        points,
        category: "capacity",
      };
    },
  },

  // How long patients are sitting in the waiting room today. A live
  // patient-experience harm that clears itself as the queue moves.
  {
    id: "waiting_time",
    evaluate: (m) => {
      const v = metricValue(m, "queue.average_waiting_time");
      if (v === null || v <= 30) return null;
      const points = v > 45 ? 6 : 3;
      return {
        factor: "Long waits",
        detail: `Patients waited ${Math.round(v)} minutes on average today`,
        points,
        category: "capacity",
      };
    },
  },
];

// ── The credit side ───────────────────────────────────────────────────────────
//
// Deliberately much smaller than the debit side, and deliberately capped. The
// asymmetry is the point: a clinic with ₹60,000 uncollected and three overdue
// recalls has real problems, and a score that let a good month of attendance
// cancel them out would be a worse instrument than one that only ever subtracts.
//
// Every credit requires the metric to be measurably outside THIS CLINIC's own
// normal range in the helping direction, on a baseline solid enough to judge
// against. Being inside the normal range earns nothing — that is what normal
// means.

/** Total credits allowed, however many factors qualify. */
const CREDIT_CAP = 12;

interface CreditFactor {
  readonly id: string;
  readonly metricKey: string;
  readonly dimension: ClinicDimension;
  readonly direction: BaselineDirection;
  readonly points: number;
  /** What was measured, in the clinic's words. */
  readonly detail: (current: number, baseline: number) => string;
  readonly factor: string;
}

const CREDIT_FACTORS: readonly CreditFactor[] = [
  {
    id: "attendance_better_than_usual",
    metricKey: "scheduling.no_show_rate_30d",
    dimension: ClinicDimension.ATTENDANCE,
    direction: BaselineDirection.LOWER_IS_BETTER,
    points: 4,
    factor: "Attendance better than usual",
    detail: (current, baseline) =>
      `No-shows at ${Math.round(current)}% against your usual ${Math.round(baseline)}%`,
  },
  {
    id: "collection_better_than_usual",
    metricKey: "revenue.collection_rate_30d",
    dimension: ClinicDimension.FINANCIAL_HEALTH,
    direction: BaselineDirection.HIGHER_IS_BETTER,
    points: 4,
    factor: "Collecting more than usual",
    detail: (current, baseline) =>
      `Collected ${Math.round(current)}% of what you delivered against your usual ${Math.round(baseline)}%`,
  },
  {
    id: "utilization_better_than_usual",
    metricKey: "capacity.chair_utilization_30d",
    dimension: ClinicDimension.SCHEDULE_HEALTH,
    direction: BaselineDirection.HIGHER_IS_BETTER,
    points: 3,
    factor: "Chair time used better than usual",
    detail: (current, baseline) =>
      `${Math.round(current)}% of offered chair time booked against your usual ${Math.round(baseline)}%`,
  },
  {
    id: "recall_list_smaller_than_usual",
    metricKey: "followups.overdue",
    dimension: ClinicDimension.RETENTION_RECALL,
    direction: BaselineDirection.LOWER_IS_BETTER,
    points: 3,
    factor: "Recall list shorter than usual",
    detail: (current, baseline) =>
      `${Math.round(current)} overdue against your usual ${Math.round(baseline)}`,
  },
  {
    id: "waits_shorter_than_usual",
    metricKey: "queue.average_waiting_time",
    dimension: ClinicDimension.PATIENT_FLOW,
    direction: BaselineDirection.LOWER_IS_BETTER,
    points: 2,
    factor: "Shorter waits than usual",
    detail: (current, baseline) =>
      `${Math.round(current)} min average against your usual ${Math.round(baseline)} min`,
  },
  {
    id: "pipeline_cleaner_than_usual",
    metricKey: "treatment.accepted_pending_scheduling",
    dimension: ClinicDimension.TREATMENT_PIPELINE,
    direction: BaselineDirection.LOWER_IS_BETTER,
    points: 2,
    factor: "Fewer unbooked treatment plans than usual",
    detail: (current, baseline) =>
      `${Math.round(current)} waiting against your usual ${Math.round(baseline)}`,
  },
];

/**
 * Credits earned from this clinic's own baselines.
 *
 * Returns an empty list when no baselines were supplied, which makes the score
 * identical to v1 rather than penalising a clinic for having no history.
 */
function creditsFrom(
  baselines: ReadonlyMap<string, MetricBaseline> | undefined,
): HealthCredit[] {
  if (baselines === undefined) return [];

  const earned: HealthCredit[] = [];
  for (const factor of CREDIT_FACTORS) {
    const baseline = baselines.get(factor.metricKey);
    if (baseline === undefined) continue;
    // A thin baseline cannot establish what normal is, so it cannot establish
    // that today beat it.
    if (!isJudgeable(baseline)) continue;
    if (baseline.current === null) continue;
    if (!isImprovement(baseline, factor.direction)) continue;

    earned.push({
      factor: factor.factor,
      detail: factor.detail(baseline.current, baseline.median),
      points: factor.points,
      dimension: factor.dimension,
    });
  }

  // Largest first, then by factor name so the output is stable across runs.
  earned.sort((a, b) => (b.points - a.points) || a.factor.localeCompare(b.factor));

  // Trim to the cap by dropping the smallest credits, never by scaling them:
  // a scaled credit no longer matches the points its own line claims.
  const capped: HealthCredit[] = [];
  let total = 0;
  for (const credit of earned) {
    if (total + credit.points > CREDIT_CAP) continue;
    capped.push(credit);
    total += credit.points;
  }
  return capped;
}

// ── Bands ─────────────────────────────────────────────────────────────────────

function bandFor(score: number): { band: HealthBand; label: string } {
  if (score >= 85) return { band: "excellent", label: "Excellent" };
  if (score >= 70) return { band: "good", label: "Good" };
  if (score >= 55) return { band: "attention", label: "Needs Attention" };
  return { band: "urgent", label: "Urgent" };
}

/**
 * Compute the clinic's health from the day's already-fetched metrics.
 *
 * Pure and deterministic: the same metrics always produce the same score and the
 * same itemised breakdown. No I/O, no clock, no writes.
 */
export function computeClinicHealth(
  metrics: readonly Metric[],
  ctx: HealthContext = {},
): ClinicHealth {
  const deductions = FACTORS.map((f) => f.evaluate(metrics, ctx))
    .filter((d): d is HealthDeduction => d !== null)
    .sort((a, b) => b.points - a.points);

  const credits = creditsFrom(ctx.baselines);

  const removed = deductions.reduce((sum, d) => sum + d.points, 0);
  const added = credits.reduce((sum, c) => sum + c.points, 0);
  const score = Math.max(0, Math.min(100, 100 - removed + added));
  const { band, label } = bandFor(score);

  return {
    score,
    band,
    bandLabel: label,
    deductions,
    credits,
    dimensions: rollUpDimensions(deductions, credits, metrics, ctx),
  };
}

/**
 * Roll the itemised lines up into the six dimensions.
 *
 * A grouping of the same ledger, not a second rubric — so a dimension score can
 * never disagree with the lines shown beneath it.
 *
 * `measured` is the load-bearing field. A dimension with no line and no readable
 * metric is not a dimension scoring 100: it is one nobody measured today, and
 * reporting it as perfect would be the most flattering possible misreading.
 */
function rollUpDimensions(
  deductions: readonly HealthDeduction[],
  credits: readonly HealthCredit[],
  metrics: readonly Metric[],
  ctx: HealthContext,
): readonly HealthDimension[] {
  return SCORE_DIMENSIONS.map((dimension) => {
    const debits = deductions
      .filter((d) => DIMENSION_BY_CATEGORY[d.category] === dimension)
      .reduce((sum, d) => sum + d.points, 0);
    const earned = credits
      .filter((c) => c.dimension === dimension)
      .reduce((sum, c) => sum + c.points, 0);

    // A dimension counts as measured when any line lands in it, or when any of
    // the metrics it reads produced a value today. Both routes matter: a clinic
    // with nothing wrong in a dimension has no lines, and still measured it.
    const measured =
      debits > 0 ||
      earned > 0 ||
      DIMENSION_METRICS[dimension].some((key) => metricValue(metrics, key) !== null) ||
      creditMetricsFor(dimension).some((key) => ctx.baselines?.get(key)?.current != null);

    return {
      dimension,
      label: DIMENSION_LABEL[dimension],
      score: Math.max(0, Math.min(100, 100 - debits + earned)),
      debits,
      credits: earned,
      measured,
    };
  });
}

/**
 * The metrics each dimension can be measured from.
 *
 * Used only to decide whether a dimension was MEASURED, never to score it —
 * scoring stays with the factors, so this list cannot introduce a second rubric.
 */
const DIMENSION_METRICS: Readonly<Record<ClinicDimension, readonly string[]>> = {
  [ClinicDimension.SCHEDULE_HEALTH]: [
    "capacity.chair_utilization",
    "capacity.chair_utilization_30d",
    "capacity.booked_next_7d",
  ],
  [ClinicDimension.ATTENDANCE]: [
    "scheduling.no_show_rate_30d",
    "scheduling.cancellation_rate_30d",
  ],
  [ClinicDimension.PATIENT_FLOW]: ["queue.average_waiting_time", "queue.patients_waiting"],
  [ClinicDimension.FINANCIAL_HEALTH]: [
    "revenue.outstanding",
    "revenue.collection_rate_30d",
  ],
  [ClinicDimension.TREATMENT_PIPELINE]: [
    "treatment.accepted_pending_scheduling",
    "revenue.pending_treatment_value",
  ],
  [ClinicDimension.RETENTION_RECALL]: [
    "followups.overdue",
    "patients.reactivation_candidates",
  ],
};

function creditMetricsFor(dimension: ClinicDimension): readonly string[] {
  return CREDIT_FACTORS.filter((f) => f.dimension === dimension).map((f) => f.metricKey);
}

/**
 * Compare two scores into a movement, with the dimensions that produced it.
 *
 * Both arguments are ordinary {@link ClinicHealth} results: the caller recomputes
 * the earlier one from the earlier day's stored metrics. That is the whole
 * mechanism — there is no score history table, because the score is a pure
 * function of metrics that are already recorded daily, and storing a derived
 * number would only create something able to drift from the data it came from.
 *
 * Contributors are per-dimension differences. They sum to the dimension-explained
 * part of the movement; a line in a category with no dimension (acquisition) can
 * move the overall score without appearing here, which is why the UI states the
 * overall figure from `points` rather than from the contributor sum.
 */
export function compareClinicHealth(
  current: ClinicHealth,
  previous: ClinicHealth,
  since: { readonly date: string; readonly daysAgo: number },
): HealthDelta {
  const previousByDimension = new Map(previous.dimensions.map((d) => [d.dimension, d]));

  const contributors: HealthDeltaContributor[] = [];
  for (const dimension of current.dimensions) {
    const before = previousByDimension.get(dimension.dimension);
    // A dimension unmeasured on either side yields no contributor. Treating an
    // unmeasured day as 100 would manufacture a swing from a data gap.
    if (before === undefined || !before.measured || !dimension.measured) continue;
    const points = dimension.score - before.score;
    if (points === 0) continue;
    contributors.push({
      dimension: dimension.dimension,
      label: dimension.label,
      points,
    });
  }

  contributors.sort(
    (a, b) => Math.abs(b.points) - Math.abs(a.points) || a.label.localeCompare(b.label),
  );

  return {
    points: current.score - previous.score,
    since: since.date,
    daysAgo: since.daysAgo,
    previousScore: previous.score,
    contributors,
  };
}

/**
 * Attach a movement to a score.
 *
 * Kept separate from {@link computeClinicHealth} so the score itself stays a pure
 * function of one day's metrics — the property that makes it impossible to drift
 * from live data. A caller with a comparison day layers the delta on afterwards.
 */
export function withDelta(health: ClinicHealth, delta: HealthDelta): ClinicHealth {
  return { ...health, delta };
}
