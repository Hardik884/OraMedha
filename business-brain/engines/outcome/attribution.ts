/**
 * Business Brain — Outcome Engine: windowed attribution evidence
 *
 * The rungs above `observed_after`, and the explicit requirements that must ALL
 * hold before an outcome may use them.
 *
 * ## likely_contributed — one completion
 *
 *   window_closed                   the fixed horizon has passed
 *   metric_measured_at_horizon      a stored reading exists at the horizon (± tolerance, never later)
 *   baseline_established            14+ stored days before the completion describe normal variation
 *   beyond_normal_variation         the helpful change at the horizon exceeds that variation
 *   targets_sufficient              the result is recordable and 5+ targets are still live patients
 *   targets_confirmed               half or more of them show it within the horizon
 *   concentrated_in_targets         those confirmations account for half or more of the change
 *   competing_explanations_checked  the pre-completion trend and clinic activity could both be read
 *   no_competing_explanation        and neither, nor an overlapping action, could account for it
 *   data_complete                   nothing the evidence rests on was withheld or cut short
 *   evidence_point_in_time          every stored reading the evidence uses was measured
 *                                   at the time or reconstructed from state as known on
 *                                   its own day, and the targets' results were read as
 *                                   recorded by the moment of assessment — nothing
 *                                   learned later stands in for what was known then
 *
 * ## Which results count
 *
 * Only results on a record of the event itself — a payment row, a booking, a
 * follow-up closed alongside an attended visit — count toward `targets_confirmed`
 * and concentration. A follow-up closed on a staff member's say-so is reported
 * beside them, never added to them.
 *
 * ## strong_evidence — repetition at this clinic
 *
 * This completion is likely_contributed, AND 3+ EARLIER comparable completions
 * (same category, whose own windows had closed by this one's) were too, AND at
 * least 75% of the earlier assessable ones were, AND the likely ones fall in 3+
 * separate weeks. Only earlier completions count: an outcome is never
 * strengthened by what happened after it.
 *
 * ## What never raises a rung
 *
 * Time. The evidence is read at the horizon and the horizon only. A competing
 * explanation never assigns credit either: it caps the outcome where it was and
 * lowers the evidence confidence.
 *
 * Pure: readings, confirmations and completions in; evidence out.
 */

import type { ActionCompletionRecord, AttributionEvidence, AttributionRequirement, CompetingExplanation } from "../../domain";
import type { CompletionConfirmationFact, MetricReadingDay } from "../../ledger";
import { addDays, daysBetween } from "../../utils";
import { BaselineDirection, DEFAULT_BASELINE_CONFIG, deriveBaselines, type MetricBaseline } from "../baseline";
import { buildMetric, MetricKey } from "../metrics/metric-ids";
import { median } from "../metrics/support/windows";
import { OUTCOME_SPEC_BY_CATEGORY, type OutcomeSpec } from "./outcome-catalog";
import { EvidenceSource, EvidenceTiming } from "../../provenance/evidence-quality";
import { isPointInTimeSafe } from "../../provenance/metric-provenance";

export interface AttributionConfig {
  /** Days past the horizon a stored reading may fall and still stand for it. Never earlier. */
  readonly horizonToleranceDays: number;
  readonly baselineLookbackDays: number;
  readonly minBaselineDays: number;
  /** The pre-completion trend compares the two halves of this many days. */
  readonly trendLookbackDays: number;
  readonly minTrendDaysPerHalf: number;
  readonly minResolvableTargets: number;
  readonly minConfirmedShare: number;
  readonly minConcentrationShare: number;
  /** Clinic-wide activity read for a simultaneous shift. */
  readonly contextMetricKey: string;
  readonly minContextDaysAfter: number;
  /** Two completions sharing this share of targets overlap. */
  readonly overlapTargetShare: number;
  readonly strong: {
    readonly minPriorLikely: number;
    readonly minConsistency: number;
    readonly minDistinctWeeks: number;
  };
  readonly confidence: {
    readonly insufficient: number;
    readonly observed: number;
    readonly likely: number;
    readonly strong: number;
    readonly perCompeting: number;
    readonly undetermined: number;
    readonly floor: number;
  };
}

export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  horizonToleranceDays: 3,
  baselineLookbackDays: 28,
  minBaselineDays: 14,
  trendLookbackDays: 14,
  minTrendDaysPerHalf: 5,
  minResolvableTargets: 5,
  minConfirmedShare: 0.5,
  minConcentrationShare: 0.5,
  contextMetricKey: MetricKey.APPOINTMENTS_TOTAL_TODAY,
  minContextDaysAfter: 5,
  overlapTargetShare: 0.5,
  strong: { minPriorLikely: 3, minConsistency: 0.75, minDistinctWeeks: 3 },
  confidence: { insufficient: 0.05, observed: 0.5, likely: 0.75, strong: 0.9, perCompeting: 0.15, undetermined: 0.1, floor: 0.05 },
};

export interface OutcomeHistoryInput {
  readonly clinicId: string;
  readonly timezone: string;
  /** Stored readings of completed days, any order. */
  readonly metricDays: readonly MetricReadingDay[];
  /** Per completion, what followed. A completion absent here was not read. */
  readonly confirmations: ReadonlyMap<string, CompletionConfirmationFact>;
  /** History kinds withheld or truncated in the read. */
  readonly gaps?: readonly string[];
  readonly config?: Partial<AttributionConfig>;
}

export interface WindowedAssessment {
  readonly evidence: AttributionEvidence;
  readonly likely: boolean;
  readonly strong: boolean;
  /** Whether the completion had a fair chance to meet the standard at all. */
  readonly assessable: boolean;
  readonly localDate: string;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Clinic-local business date of an instant. */
export function localDate(iso: string, timezone: string): string {
  let f = formatters.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, f);
  }
  return f.format(new Date(iso));
}

/** Monday of the ISO week holding a date, as the week's key. */
function weekOf(date: string): string {
  const dow = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function mergeConfig(partial: Partial<AttributionConfig> | undefined): AttributionConfig {
  return {
    ...DEFAULT_ATTRIBUTION_CONFIG,
    ...(partial ?? {}),
    strong: { ...DEFAULT_ATTRIBUTION_CONFIG.strong, ...(partial?.strong ?? {}) },
    confidence: { ...DEFAULT_ATTRIBUTION_CONFIG.confidence, ...(partial?.confidence ?? {}) },
  };
}

class Readings {
  private readonly byDate = new Map<string, Readonly<Record<string, number>>>();
  private readonly provenanceByDate = new Map<string, Readonly<Record<string, string>>>();
  constructor(days: readonly MetricReadingDay[]) {
    for (const day of days) {
      this.byDate.set(day.date, day.values);
      this.provenanceByDate.set(day.date, day.provenance ?? {});
    }
  }
  /** Dates in from..to with a stored reading of `key` that is not point-in-time safe. */
  notPointInTime(key: string, from: string, to: string): string[] {
    return this.series(key, from, to)
      .filter((p) => !isPointInTimeSafe(this.provenanceByDate.get(p.date)?.[key]))
      .map((p) => p.date);
  }
  value(date: string, key: string): number | null {
    const v = this.byDate.get(date)?.[key];
    return v === undefined || !Number.isFinite(v) ? null : v;
  }
  /** Values of a key on dates from..to inclusive, in order, skipping unstored days. */
  series(key: string, from: string, to: string): { date: string; value: number }[] {
    const out: { date: string; value: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const v = this.value(d, key);
      if (v !== null) out.push({ date: d, value: v });
    }
    return out;
  }
  baseline(clinicId: string, key: string, from: string, to: string): MetricBaseline | null {
    const history = this.series(key, from, to).map((p) => ({
      date: p.date,
      metrics: [buildMetric(key as MetricKey, p.value, clinicId, p.date, `${p.date}T23:59:59.000Z`)],
    }));
    return deriveBaselines({ history, current: [] }).byKey.get(key) ?? null;
  }
}

/** Helpful-direction change from `before` to `after`. */
function helpful(before: number, after: number, direction: BaselineDirection): number {
  return direction === BaselineDirection.LOWER_IS_BETTER ? before - after : after - before;
}

/**
 * Windowed evidence for every completion that has a spec, keyed by completion id.
 * Completions of categories with no horizon get evidence saying so.
 */
export function assessWindowedEvidence(
  completions: readonly ActionCompletionRecord[],
  history: OutcomeHistoryInput,
  now: string,
): ReadonlyMap<string, WindowedAssessment> {
  const config = mergeConfig(history.config);
  const readings = new Readings(history.metricDays);
  const nowMs = Date.parse(now);
  const gaps = new Set(history.gaps ?? []);

  const first = new Map<string, Omit<WindowedAssessment, "strong">>();
  for (const completion of completions) {
    first.set(completion.id, assessOne(completion, completions, history, readings, config, nowMs, gaps));
  }

  // Strong evidence: repetition among EARLIER comparable completions only.
  const result = new Map<string, WindowedAssessment>();
  for (const completion of completions) {
    const own = first.get(completion.id) as Omit<WindowedAssessment, "strong">;
    const ends = own.evidence.windowEndsAt;
    const priors = completions
      .filter((o) => o.id !== completion.id && o.category === completion.category && Date.parse(o.completedAt) < Date.parse(completion.completedAt))
      .map((o) => first.get(o.id) as Omit<WindowedAssessment, "strong">)
      .filter((a) => ends !== null && a.evidence.windowEndsAt !== null && a.evidence.windowEndsAt <= ends && a.assessable);
    const priorLikely = priors.filter((a) => a.likely);
    const weeks = new Set([...priorLikely.map((a) => weekOf(a.localDate)), ...(own.likely ? [weekOf(own.localDate)] : [])]);
    const consistency = priors.length + 1 === 0 ? 0 : (priorLikely.length + (own.likely ? 1 : 0)) / (priors.length + 1);

    const strongRequirements: AttributionRequirement[] = [
      {
        key: "repeated_across_comparable_actions",
        met: priorLikely.length >= config.strong.minPriorLikely,
        detail: `${priorLikely.length} earlier comparable completion(s) met the likely-contributed standard; ${config.strong.minPriorLikely} are needed.`,
      },
      {
        key: "consistent_across_comparable_actions",
        met: consistency >= config.strong.minConsistency,
        detail: `${priorLikely.length + (own.likely ? 1 : 0)} of ${priors.length + 1} assessable comparable completions met it; ${Math.round(config.strong.minConsistency * 100)}% are needed.`,
      },
      {
        key: "spread_across_weeks",
        met: weeks.size >= config.strong.minDistinctWeeks,
        detail: `They fall in ${weeks.size} separate week(s); ${config.strong.minDistinctWeeks} are needed.`,
      },
    ];
    const strong = own.likely && strongRequirements.every((r) => r.met === true);
    const confidence = strong
      ? Math.max(config.confidence.floor, round2(own.evidence.confidence + (config.confidence.strong - config.confidence.likely)))
      : own.evidence.confidence;

    result.set(completion.id, {
      ...own,
      strong,
      evidence: {
        ...own.evidence,
        requirements: [...own.evidence.requirements, ...strongRequirements],
        comparable: { assessable: priors.length, likelyContributed: priorLikely.length, distinctWeeks: weeks.size },
        confidence,
      },
    });
  }
  return result;
}

function assessOne(
  completion: ActionCompletionRecord,
  all: readonly ActionCompletionRecord[],
  history: OutcomeHistoryInput,
  readings: Readings,
  config: AttributionConfig,
  nowMs: number,
  gaps: ReadonlySet<string>,
): Omit<WindowedAssessment, "strong"> {
  const spec = OUTCOME_SPEC_BY_CATEGORY.get(completion.category);
  const d0 = localDate(completion.completedAt, history.timezone);
  const horizon = spec?.horizonDays ?? null;

  if (spec === undefined || horizon === null) {
    return {
      localDate: d0,
      likely: false,
      assessable: false,
      evidence: {
        horizonDays: null,
        windowEndsAt: null,
        window: "not_applicable",
        metric: null,
        targets: null,
        competing: [],
        requirements: [
          { key: "window_closed", met: null, detail: "This category has nothing whose change could be read after the action." },
        ],
        comparable: { assessable: 0, likelyContributed: 0, distinctWeeks: 0 },
        confidence: config.confidence.insufficient,
      },
    };
  }

  const windowEndsMs = Date.parse(completion.completedAt) + horizon * DAY_MS;
  const closed = nowMs >= windowEndsMs;
  const requirements: AttributionRequirement[] = [];
  requirements.push({
    key: "window_closed",
    met: closed,
    detail: closed
      ? `The ${horizon}-day window after the completion has closed.`
      : `The ${horizon}-day window after the completion is still open; nothing above observed-after can be said before it closes.`,
  });

  // ── the metric at the horizon, against normal variation ────────────────────
  const metric = metricEvidence(completion, spec, d0, horizon, readings, history.clinicId, config, closed);
  requirements.push({
    key: "metric_measured_at_horizon",
    met: metric !== null && metric.atHorizon !== null,
    detail:
      metric === null
        ? "No headline reading was captured at the completion, or the category has no headline metric."
        : metric.atHorizon === null
          ? `No stored reading exists between ${addDays(d0, horizon)} and ${addDays(d0, horizon + config.horizonToleranceDays)}.`
          : `Read ${metric.atCompletion} at the completion and ${metric.atHorizon} on ${metric.horizonDate}.`,
  });
  requirements.push({
    key: "baseline_established",
    met: metric !== null && metric.normalVariation !== null && metric.baselineDays >= config.minBaselineDays,
    detail:
      metric === null
        ? "No headline metric to describe normal variation for."
        : `${metric.baselineDays} stored day(s) in the ${config.baselineLookbackDays} days before the completion; ${config.minBaselineDays} are needed.`,
  });
  const beyond =
    metric !== null && metric.improvement !== null && metric.normalVariation !== null && metric.baselineDays >= config.minBaselineDays
      ? metric.improvement > metric.normalVariation
      : null;
  requirements.push({
    key: "beyond_normal_variation",
    met: beyond,
    detail:
      beyond === null
        ? "The change at the horizon could not be compared with normal variation."
        : `The helpful change was ${metric?.improvement} against a normal variation of ${metric?.normalVariation}.`,
  });

  // ── the targets ────────────────────────────────────────────────────────────
  const confirmation = history.confirmations.get(completion.id);
  const within = (d: number) => d >= 0 && d <= horizon;
  const observedWithin = (confirmation?.results ?? []).filter((r) => r.source === EvidenceSource.OBJECTIVELY_OBSERVED && within(r.delayDays)).map((r) => r.delayDays);
  const targets =
    confirmation === undefined
      ? null
      : {
          verifiable: confirmation.verifiable,
          resolvable: confirmation.resolvable,
          confirmedWithinWindow: observedWithin.length,
          declaredWithinWindow: (confirmation.results ?? []).filter((r) => r.source !== EvidenceSource.OBJECTIVELY_OBSERVED && within(r.delayDays)).length,
          medianDaysToResult: observedWithin.length === 0 ? null : round2(median(observedWithin)),
          daysToResult: observedWithin.map(round2).sort((a, b) => a - b),
        };
  // Before the window closes, a partial count would be judged against a full denominator.
  const countable = targets !== null && closed;
  requirements.push({
    key: "targets_sufficient",
    met: targets === null ? null : targets.verifiable && targets.resolvable >= config.minResolvableTargets,
    detail:
      targets === null
        ? "What followed for the targeted patients was not read."
        : !targets.verifiable
          ? "The intended result of this category is not recorded anywhere, so no target can confirm it."
          : `${targets.resolvable} targeted patient(s) are still live records; ${config.minResolvableTargets} are needed.`,
  });
  const share = targets !== null && targets.resolvable > 0 ? targets.confirmedWithinWindow / targets.resolvable : null;
  requirements.push({
    key: "targets_confirmed",
    met: !countable || share === null ? null : targets.verifiable && share >= config.minConfirmedShare,
    detail:
      share === null || targets === null
        ? "No confirmable targets."
        : `${targets.confirmedWithinWindow} of ${targets.resolvable} showed the intended result on a record of the event within ${horizon} days${closed ? "" : " so far"}${targets.declaredWithinWindow > 0 ? `; ${targets.declaredWithinWindow} more on a staff record alone, which does not count` : ""}.`,
  });
  const concentrated =
    spec.currency
      ? null
      : !countable || metric === null || metric.improvement === null || metric.improvement <= 0
        ? null
        : targets.confirmedWithinWindow >= config.minConcentrationShare * metric.improvement;
  requirements.push({
    key: "concentrated_in_targets",
    met: concentrated,
    detail: spec.currency
      ? "The headline measurement is money, and how much of a change the targets account for cannot be read in patients."
      : concentrated === null
        ? "There was no helpful change to account for, or nothing to account for it with."
        : `${targets?.confirmedWithinWindow} confirmed target(s) against a change of ${metric?.improvement}.`,
  });

  // ── competing explanations ─────────────────────────────────────────────────
  const competing: CompetingExplanation[] = [];
  const trend = preExistingTrend(spec, d0, readings, config, metric?.normalVariation ?? null);
  if (trend.found) competing.push({ kind: "pre_existing_trend", detail: trend.detail });
  const shift = simultaneousShift(d0, horizon, readings, history.clinicId, config, closed);
  if (shift.found) competing.push({ kind: "simultaneous_shift", detail: shift.detail });
  for (const detail of overlapping(completion, all, spec, horizon, config, history.timezone)) competing.push({ kind: "overlapping_action", detail });

  requirements.push({
    key: "competing_explanations_checked",
    met: trend.checked && shift.checked,
    detail: `${trend.checked ? "The trend before the completion was read" : "The trend before the completion could not be read"}; ${shift.checked ? "clinic activity during the window was read" : "clinic activity during the window could not be read"}.`,
  });
  requirements.push({
    key: "no_competing_explanation",
    met: competing.length === 0,
    detail: competing.length === 0 ? "No competing explanation was found in the records." : competing.map((c) => c.detail).join(" "),
  });
  const missing = ["action_completion", "action_completion_truncated", "completion_confirmation", "metric_history"].filter((k) => gaps.has(k));
  requirements.push({
    key: "data_complete",
    met: missing.length === 0,
    detail: missing.length === 0 ? "Nothing the evidence rests on was withheld or cut short." : `Withheld or cut short: ${missing.join(", ").replace(/_/g, " ")}.`,
  });

  // ── what the evidence could have known ─────────────────────────────────────
  const notPointInTime = [
    ...new Set([
      ...(spec.metricKey === null ? [] : readings.notPointInTime(spec.metricKey, addDays(d0, -config.baselineLookbackDays), addDays(d0, horizon + config.horizonToleranceDays))),
      ...readings.notPointInTime(config.contextMetricKey, addDays(d0, -config.baselineLookbackDays), addDays(d0, horizon)),
    ]),
  ].sort();
  const resultsTiming = confirmation?.timing ?? EvidenceTiming.UNKNOWN;
  const pointInTime = notPointInTime.length === 0 && resultsTiming === EvidenceTiming.POINT_IN_TIME;
  requirements.push({
    key: "evidence_point_in_time",
    met: pointInTime,
    detail: pointInTime
      ? "Every reading and result was on record by the moment it stands for."
      : [
          notPointInTime.length > 0
            ? `${notPointInTime.length} stored reading day(s) were recomputed later or are of unknown provenance, from ${notPointInTime[0]}.`
            : "",
          resultsTiming === EvidenceTiming.POINT_IN_TIME
            ? ""
            : resultsTiming === EvidenceTiming.CURRENT_STATE
              ? "The targets' results were read from records as they stand now, not as they stood."
              : "How the targets' results were read is not known.",
        ]
          .filter((x) => x !== "")
          .join(" "),
  });

  const likely = requirements.every((r) => r.met === true);
  const assessable =
    closed &&
    pointInTime &&
    metric?.atHorizon != null &&
    (metric?.baselineDays ?? 0) >= config.minBaselineDays &&
    targets !== null &&
    targets.verifiable &&
    targets.resolvable >= config.minResolvableTargets;

  const base = likely ? config.confidence.likely : metric?.atHorizon != null ? config.confidence.observed : config.confidence.insufficient;
  const undetermined = requirements.some((r) => r.met === null) ? config.confidence.undetermined : 0;
  const confidence = Math.max(config.confidence.floor, round2(base - competing.length * config.confidence.perCompeting - undetermined));

  return {
    localDate: d0,
    likely,
    assessable,
    evidence: {
      horizonDays: horizon,
      windowEndsAt: new Date(windowEndsMs).toISOString(),
      window: closed ? "closed" : "open",
      metric,
      targets,
      competing,
      requirements,
      comparable: { assessable: 0, likelyContributed: 0, distinctWeeks: 0 },
      confidence,
    },
  };
}

function metricEvidence(
  completion: ActionCompletionRecord,
  spec: OutcomeSpec,
  d0: string,
  horizon: number,
  readings: Readings,
  clinicId: string,
  config: AttributionConfig,
  closed: boolean,
): AttributionEvidence["metric"] {
  if (
    spec.metricKey === null ||
    spec.direction === null ||
    completion.metricKey !== spec.metricKey ||
    completion.metricValueAtCompletion === undefined ||
    !Number.isFinite(completion.metricValueAtCompletion)
  ) {
    return null;
  }
  const key = spec.metricKey;
  const before = completion.metricValueAtCompletion;
  let atHorizon: number | null = null;
  let horizonDate: string | null = null;
  if (closed) {
    for (let offset = horizon; offset <= horizon + config.horizonToleranceDays; offset += 1) {
      const date = addDays(d0, offset);
      const v = readings.value(date, key);
      if (v !== null) {
        atHorizon = v;
        horizonDate = date;
        break;
      }
    }
  }
  const band = readings.baseline(clinicId, key, addDays(d0, -config.baselineLookbackDays), addDays(d0, -1));
  return {
    key,
    atCompletion: round2(before),
    atHorizon: atHorizon === null ? null : round2(atHorizon),
    horizonDate,
    improvement: atHorizon === null ? null : round2(helpful(before, atHorizon, spec.direction)),
    normalVariation: band === null ? null : round2(band.deviation * DEFAULT_BASELINE_CONFIG.bandMads),
    baselineDays: band?.observations ?? 0,
  };
}

/** Was the metric already moving the helpful way, by more than normal variation, before the completion? */
function preExistingTrend(
  spec: OutcomeSpec,
  d0: string,
  readings: Readings,
  config: AttributionConfig,
  normalVariation: number | null,
): { checked: boolean; found: boolean; detail: string } {
  if (spec.metricKey === null || spec.direction === null || normalVariation === null) {
    return { checked: false, found: false, detail: "" };
  }
  const half = Math.floor(config.trendLookbackDays / 2);
  const earlier = readings.series(spec.metricKey, addDays(d0, -config.trendLookbackDays), addDays(d0, -half - 1)).map((p) => p.value);
  const later = readings.series(spec.metricKey, addDays(d0, -half), addDays(d0, -1)).map((p) => p.value);
  if (earlier.length < config.minTrendDaysPerHalf || later.length < config.minTrendDaysPerHalf) {
    return { checked: false, found: false, detail: "" };
  }
  const change = round2(helpful(median(earlier), median(later), spec.direction));
  return {
    checked: true,
    found: change > normalVariation,
    detail: `The measurement was already improving before the action: by ${change} across the ${config.trendLookbackDays} days before it, against a normal variation of ${normalVariation}.`,
  };
}

/** Did clinic-wide activity move beyond its normal variation during the window? */
function simultaneousShift(
  d0: string,
  horizon: number,
  readings: Readings,
  clinicId: string,
  config: AttributionConfig,
  closed: boolean,
): { checked: boolean; found: boolean; detail: string } {
  if (!closed) return { checked: false, found: false, detail: "" };
  const key = config.contextMetricKey;
  const band = readings.baseline(clinicId, key, addDays(d0, -config.baselineLookbackDays), addDays(d0, -1));
  const after = readings.series(key, addDays(d0, 1), addDays(d0, horizon)).map((p) => p.value);
  if (band === null || band.observations < config.minBaselineDays || after.length < config.minContextDaysAfter) {
    return { checked: false, found: false, detail: "" };
  }
  const variation = band.deviation * DEFAULT_BASELINE_CONFIG.bandMads;
  const moved = round2(median(after) - band.median);
  return {
    checked: true,
    found: Math.abs(moved) > variation,
    detail: `Clinic activity changed at the same time: a median of ${round2(median(after))} appointments a day during the window against ${band.median} before it.`,
  };
}

/** Other completions whose windows overlap this one and that could account for the same change. */
function overlapping(
  completion: ActionCompletionRecord,
  all: readonly ActionCompletionRecord[],
  spec: OutcomeSpec,
  horizon: number,
  config: AttributionConfig,
  timezone: string,
): string[] {
  const at = Date.parse(completion.completedAt);
  const mine = new Set(completion.targetPatientIds);
  const out: string[] = [];
  for (const other of [...all].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || (a.id < b.id ? -1 : 1))) {
    if (other.id === completion.id) continue;
    if (Math.abs(Date.parse(other.completedAt) - at) >= horizon * DAY_MS) continue;
    const otherSpec = OUTCOME_SPEC_BY_CATEGORY.get(other.category);
    const sameMetric = other.category !== completion.category && otherSpec?.metricKey != null && otherSpec.metricKey === spec.metricKey;
    const shared = other.targetPatientIds.filter((id) => mine.has(id)).length;
    const smaller = Math.min(mine.size, new Set(other.targetPatientIds).size);
    const sharedTargets = smaller > 0 && shared / smaller >= config.overlapTargetShare;
    if (sameMetric || sharedTargets) {
      // Clinic-local dates: two actions an evening apart in UTC may be the same clinic day.
      const days = Math.round(Math.abs(daysBetween(localDate(completion.completedAt, timezone), localDate(other.completedAt, timezone))));
      out.push(
        sameMetric
          ? `Another action moving the same measurement was completed ${days} day(s) apart.`
          : `Another action covering largely the same patients was completed ${days} day(s) apart.`,
      );
    }
  }
  return out;
}
