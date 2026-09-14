/**
 * Business Brain — Root-Cause Engine
 *
 * For a problem the Brain has already detected, asks whether the clinic's own
 * ledger shows WHERE it is concentrated — and answers "insufficient evidence"
 * whenever it cannot say so reliably.
 *
 * ## What it looks at
 *
 * One population per question, taken from the trailing window of the
 * appointment book the service already reads through the Clinic Ledger:
 *
 *   attrition      appointments whose time has passed with a recorded outcome;
 *                  the event is lost (or cancelled, or missed)
 *   overrun        attended visits with both call-in and finish recorded; the
 *                  measurement is minutes over the booked length
 *   waiting        queue visits that were called in; the measurement is minutes
 *                  from check-in to call-in
 *   idle capacity  open dates (and date-sessions); the measurement is the share
 *                  of chair time booked
 *
 * Each population is split by ONE dimension at a time, and each group is compared
 * with everyone else in the same population — never with an overall figure that
 * includes the group itself.
 *
 * ## What it never does
 *
 * - Name a cause. Statements say "concentrated in" and "associated with".
 * - Pick one explanation. Every association that passes is kept, and overlapping
 *   ones are flagged rather than resolved.
 * - Compute a rate for a group too small to have one (it is reported as null).
 * - Read, rank or target a patient, or use any demographic attribute.
 * - Rank findings or propose actions. The prioritiser and the action catalogue own those.
 *
 * Pure: ledger graphs and capacity facts in, analyses out. `now` and the clinic
 * timezone are inputs; `Intl` is used only to express instants in that timezone.
 */

import {
  ConstraintCategory,
  RootCauseDimension,
  RootCauseQuestion,
  type Finding,
  type RootCauseAnalysis,
  type RootCauseAssociation,
  type RootCauseDimensionResult,
  type RootCauseGroupStat,
} from "../../domain";
import type { AppointmentFact, CapacityWindowFact, ClinicLedgerGraph, TreatmentFact } from "../../ledger";
import { LedgerFactKind, groupableTreatmentType, isUnresolvedVisit } from "../../ledger";
import { addDays } from "../../utils";
import { MetricKey } from "../metrics/metric-ids";
import { DEFAULT_ROOT_CAUSE_CONFIG, type RootCauseConfig } from "./root-cause-config";
import { fisherGreater, median, perComparisonAlpha, quantile, rankSumGreater, round1, round2 } from "./stats";

/** The per-comparison threshold an analysis judges each group against, and how many comparisons share it. */
interface Family {
  readonly alpha: number;
  readonly comparisons: number;
}

function familyFor(familyAlpha: number, comparisons: number): Family {
  return { alpha: perComparisonAlpha(familyAlpha, comparisons), comparisons };
}

/** Comparisons an analysis will make: every sized group, in every analysable dimension. */
function comparisonsIn(units: readonly Unit[], dimensions: readonly RootCauseDimension[], minGroup: number, minRest: number, minCoverage: number): number {
  let count = 0;
  for (const dimension of dimensions) {
    const { recorded, coverage, groups } = partition(units, dimension);
    if (coverage < minCoverage || groups.length < 2) continue;
    for (const g of groups) if (g.members.length >= minGroup && recorded.length - g.members.length >= minRest) count += 1;
  }
  return count;
}

const formatP = (p: number) => (p < 0.001 ? "below 0.001" : p.toFixed(3));

function testedLine(test: string, p: number, family: Family): string {
  return `${test}: p = ${formatP(p)}, under the ${formatP(family.alpha)} threshold that shares a 5% chance of any false concentration across the ${family.comparisons} comparisons made.`;
}

export interface RootCauseSubject {
  readonly parentFindingId: string;
  readonly category: ConstraintCategory;
  /** For attrition: which lost appointments the parent is about. */
  readonly focus: "lost" | "cancelled" | "no_show";
}

export interface RootCauseInput {
  readonly clinicId: string;
  readonly date: string;
  /** ISO-8601 moment of the run. Appointments at or after it have no outcome yet. */
  readonly now: string;
  /** Clinic IANA timezone, for day of week and session. */
  readonly timezone: string;
  readonly subjects: readonly RootCauseSubject[];
  /** Appointment-window graph for `date − windowDays + 1 … date`, or null when unread. */
  readonly schedule: ClinicLedgerGraph | null;
  /** Published capacity for the same window, or null when unread. */
  readonly capacity: CapacityWindowFact | null;
  /** Why the ledger could not be read, when it could not. */
  readonly unavailableReason?: string | null;
  readonly config?: Partial<RootCauseConfig>;
}

export class RootCauseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootCauseIntegrityError";
  }
}

const QUESTION_FOR: Partial<Record<ConstraintCategory, RootCauseQuestion>> = {
  [ConstraintCategory.SCHEDULING]: RootCauseQuestion.ATTRITION,
  [ConstraintCategory.SCHEDULE_ACCURACY]: RootCauseQuestion.OVERRUN,
  [ConstraintCategory.PATIENT_FLOW]: RootCauseQuestion.WAITING,
  [ConstraintCategory.CAPACITY]: RootCauseQuestion.IDLE_CAPACITY,
};

/**
 * The findings a root cause can be investigated for: negative findings in a
 * category with a question. One subject per finding, and one finding per
 * category already exists — the normaliser guarantees it.
 */
export function rootCauseSubjects(findings: readonly Finding[]): readonly RootCauseSubject[] {
  return findings
    .filter((f) => f.polarity === "negative" && f.category !== null && QUESTION_FOR[f.category as ConstraintCategory] !== undefined)
    .map((f) => {
      const keys = f.evidence.trajectories.map((t) => t.metricKey);
      const cancellations = keys.includes(MetricKey.SCHEDULING_CANCELLATION_RATE_30D);
      const noShows = keys.includes(MetricKey.SCHEDULING_NO_SHOW_RATE_30D);
      const focus: RootCauseSubject["focus"] =
        f.source.producer === "trajectory" && cancellations !== noShows ? (cancellations ? "cancelled" : "no_show") : "lost";
      return { parentFindingId: f.id, category: f.category as ConstraintCategory, focus };
    })
    .sort((a, b) => (a.parentFindingId < b.parentFindingId ? -1 : 1));
}

/** One analysis per subject, in subject order. */
export function deriveRootCauses(input: RootCauseInput): readonly RootCauseAnalysis[] {
  const config: RootCauseConfig = {
    ...DEFAULT_ROOT_CAUSE_CONFIG,
    ...(input.config ?? {}),
    proportion: { ...DEFAULT_ROOT_CAUSE_CONFIG.proportion, ...(input.config?.proportion ?? {}) },
    measurement: { ...DEFAULT_ROOT_CAUSE_CONFIG.measurement, ...(input.config?.measurement ?? {}) },
    capacity: { ...DEFAULT_ROOT_CAUSE_CONFIG.capacity, ...(input.config?.capacity ?? {}) },
    penalties: { ...DEFAULT_ROOT_CAUSE_CONFIG.penalties, ...(input.config?.penalties ?? {}) },
  };
  if (input.schedule !== null && input.schedule.slice.clinicId !== input.clinicId) {
    throw new RootCauseIntegrityError(`Schedule belongs to clinic ${input.schedule.slice.clinicId}, not ${input.clinicId}.`);
  }
  if (input.capacity !== null && input.capacity.clinicId !== input.clinicId) {
    throw new RootCauseIntegrityError(`Capacity belongs to clinic ${input.capacity.clinicId}, not ${input.clinicId}.`);
  }

  return input.subjects.map((subject) => {
    const question = QUESTION_FOR[subject.category] as RootCauseQuestion;
    const ctx = new Context(input, subject, question, config);
    switch (question) {
      case RootCauseQuestion.ATTRITION:
        return attrition(ctx);
      case RootCauseQuestion.OVERRUN:
        return overrun(ctx);
      case RootCauseQuestion.WAITING:
        return waiting(ctx);
      default:
        return idleCapacity(ctx);
    }
  });
}

// ── shared machinery ────────────────────────────────────────────────────────

interface DimensionValue {
  /** Sortable key. */
  readonly key: string;
  readonly label: string;
  /** Phrase for a statement: "Monday appointments". */
  readonly phrase: string;
}

interface Unit {
  readonly id: string;
  /** undefined: not asked; null: not recorded for this unit. */
  readonly dims: Partial<Record<RootCauseDimension, DimensionValue | null>>;
  readonly event?: boolean;
  readonly value?: number;
}

class Context {
  readonly from: string;
  readonly to: string;
  readonly nowMs: number;
  constructor(
    readonly input: RootCauseInput,
    readonly subject: RootCauseSubject,
    readonly question: RootCauseQuestion,
    readonly config: RootCauseConfig,
  ) {
    this.from = addDays(input.date, -(config.windowDays - 1));
    this.to = input.date;
    this.nowMs = Date.parse(input.now);
  }

  get id(): string {
    return `rootcause.${this.question}:${this.subject.parentFindingId}`;
  }

  /** Why the schedule cannot be analysed, or null when it can. */
  scheduleProblem(needs: readonly LedgerFactKind[] = []): string | null {
    const schedule = this.input.schedule;
    if (schedule === null) return this.input.unavailableReason ?? "the appointment book for the window was not read";
    for (const kind of [LedgerFactKind.APPOINTMENT, ...needs]) {
      const noun = kind.replace(/_/g, " ");
      // Withheld stays withheld: an analysis never runs on what it was not shown.
      if (schedule.slice.withheld.includes(kind)) return `${noun} records were withheld from this run`;
      if (schedule.slice.truncated.includes(kind)) {
        return `the ${noun} read hit its row limit, and a partial record would distort every comparison`;
      }
    }
    return null;
  }

  base(): Pick<RootCauseAnalysis, "id" | "parentFindingId" | "clinicId" | "date" | "question"> {
    return {
      id: this.id,
      parentFindingId: this.subject.parentFindingId,
      clinicId: this.input.clinicId,
      date: this.input.date,
      question: this.question,
    };
  }
}

/** Minute-of-day bounds of morning, afternoon and evening. */
const SESSION_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 12 * 60],
  [12 * 60, 17 * 60],
  [17 * 60, 24 * 60],
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INDEX: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

/** An instant expressed in the clinic's timezone. */
function local(iso: string, timezone: string): { weekday: number; minuteOfDay: number; date: string } {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function dayOfWeek(weekday: number, noun: string): DimensionValue {
  return { key: String((weekday + 6) % 7), label: DAY_NAMES[weekday], phrase: `${DAY_NAMES[weekday]} ${noun}` };
}

function session(minuteOfDay: number, noun: string): DimensionValue {
  if (minuteOfDay < 12 * 60) return { key: "0", label: "Morning (before 12:00)", phrase: `morning ${noun} (before 12:00)` };
  if (minuteOfDay < 17 * 60) return { key: "1", label: "Afternoon (12:00–16:59)", phrase: `afternoon ${noun} (12:00–16:59)` };
  return { key: "2", label: "Evening (17:00 onwards)", phrase: `evening ${noun} (17:00 onwards)` };
}

function bookedDuration(minutes: number, noun: string): DimensionValue {
  if (minutes <= 20) return { key: "0", label: "Booked up to 20 min", phrase: `${noun} booked for up to 20 minutes` };
  if (minutes <= 40) return { key: "1", label: "Booked 21–40 min", phrase: `${noun} booked for 21–40 minutes` };
  if (minutes <= 60) return { key: "2", label: "Booked 41–60 min", phrase: `${noun} booked for 41–60 minutes` };
  return { key: "3", label: "Booked over 60 min", phrase: `${noun} booked for more than 60 minutes` };
}

function leadTime(a: AppointmentFact): DimensionValue | null {
  const days = (Date.parse(a.scheduledAt) - Date.parse(a.bookedAt)) / 86_400_000;
  // Recorded after it happened (a back-dated entry): the lead time is not a
  // booking behaviour, so it is not recorded rather than negative.
  if (days < 0) return null;
  if (days < 1) return { key: "0", label: "Booked the same day", phrase: "appointments booked the same day" };
  if (days <= 7) return { key: "1", label: "Booked 1–7 days ahead", phrase: "appointments booked 1–7 days ahead" };
  if (days <= 21) return { key: "2", label: "Booked 8–21 days ahead", phrase: "appointments booked 8–21 days ahead" };
  return { key: "3", label: "Booked more than 21 days ahead", phrase: "appointments booked more than 21 days ahead" };
}

function origin(a: AppointmentFact): DimensionValue {
  return a.originFollowUpId === null
    ? { key: "1", label: "Booked another way", phrase: "appointments not booked through the follow-up flow" }
    : { key: "0", label: "Booked through the follow-up flow", phrase: "appointments booked through the follow-up flow" };
}

const ATTENDED = new Set(["completed", "checked_in", "in_progress"]);
const LOST = new Set(["cancelled", "no_show"]);
const OCCUPYING = new Set(["scheduled", "checked_in", "in_progress", "completed"]);

/** Split units by one dimension, with coverage and the groups' members. */
function partition(units: readonly Unit[], dimension: RootCauseDimension) {
  const applicable = units.filter((u) => u.dims[dimension] !== undefined);
  const recorded = applicable.filter((u) => u.dims[dimension] !== null);
  const groups = new Map<string, { value: DimensionValue; members: Unit[] }>();
  for (const unit of recorded) {
    const value = unit.dims[dimension] as DimensionValue;
    const entry = groups.get(value.key) ?? { value, members: [] };
    entry.members.push(unit);
    groups.set(value.key, entry);
  }
  return {
    recorded,
    coverage: applicable.length === 0 ? 0 : recorded.length / applicable.length,
    groups: [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g),
  };
}

interface Candidate {
  readonly association: Omit<RootCauseAssociation, "overlapsWith" | "confidence">;
  readonly members: ReadonlySet<string>;
  readonly nearMinimum: boolean;
  readonly coverage: number;
}

/** Finalise candidates: overlap flags, confidence, deterministic order. */
function finalise(candidates: readonly Candidate[], config: RootCauseConfig): RootCauseAssociation[] {
  const withOverlap = candidates.map((c) => {
    const overlapsWith = candidates
      .filter((other) => other !== c && other.association.dimension !== c.association.dimension)
      .map((other) => {
        let shared = 0;
        for (const m of c.members) if (other.members.has(m)) shared += 1;
        return { associationId: other.association.id, sharedShare: round2(shared / Math.max(1, Math.min(c.members.size, other.members.size))) };
      })
      .filter((o) => o.sharedShare >= config.overlapShare);
    let confidence = 0.9;
    if (c.nearMinimum) confidence -= config.penalties.nearMinimum;
    if (c.coverage < 0.95) confidence -= config.penalties.partialCoverage;
    if (overlapsWith.length > 0) confidence -= config.penalties.overlapping;
    return { ...c.association, overlapsWith, confidence: round2(Math.max(config.confidenceFloor, confidence)) };
  });
  return withOverlap.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      Math.abs(b.gap) - Math.abs(a.gap) ||
      (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0) ||
      (a.group.label < b.group.label ? -1 : 1),
  );
}

function summarise(
  ctx: Context,
  population: RootCauseAnalysis["population"],
  associations: readonly RootCauseAssociation[],
  dimensions: readonly RootCauseDimensionResult[],
  limitations: readonly string[],
): RootCauseAnalysis {
  const competing = new Set(associations.map((a) => a.dimension)).size > 1;
  if (associations.length === 0) {
    const allSized = dimensions.every((d) => d.status === "no_meaningful_difference" || d.status === "no_variation");
    const investigated = dimensions.filter((d) => d.status !== "not_recorded").length;
    return {
      ...ctx.base(),
      outcome: "no_concentration",
      population,
      associations: [],
      competing: false,
      dimensions,
      // Confidence that nothing stands out is moderate at best: one dimension at
      // a time cannot rule out a concentration across two.
      confidence: allSized ? 0.6 : 0.4,
      statement: `No concentration stands out: none of the ${investigated} dimension${investigated === 1 ? "" : "s"} investigated shows a meaningful, reliable difference.`,
      limitations,
    };
  }
  const statement =
    associations.length === 1
      ? associations[0].statement
      : `More than one concentration fits the data, and each is kept: ${associations.map((a) => lowerFirst(a.statement.replace(/\.$/, ""))).join("; ")}.`;
  return {
    ...ctx.base(),
    outcome: "explained",
    population,
    associations,
    competing,
    dimensions,
    confidence: Math.max(...associations.map((a) => a.confidence)),
    statement,
    limitations: competing
      ? [...limitations, "More than one dimension shows a concentration; the data cannot say which description fits best."]
      : limitations,
  };
}

function insufficient(ctx: Context, reason: string, population: RootCauseAnalysis["population"], limitations: readonly string[]): RootCauseAnalysis {
  return {
    ...ctx.base(),
    outcome: "insufficient_evidence",
    population,
    associations: [],
    competing: false,
    dimensions: [],
    confidence: ctx.config.confidenceFloor,
    statement: `Insufficient evidence to explain where this is concentrated: ${reason}.`,
    limitations,
  };
}

const COMMON_LIMITATIONS = [
  "These are associations in the clinic's own records, not causes: groups can differ in ways the ledger does not capture.",
  "Each dimension is examined on its own; overlapping concentrations are flagged, not separated.",
];

// ── proportions ─────────────────────────────────────────────────────────────

function proportionDimension(
  ctx: Context,
  units: readonly Unit[],
  dimension: RootCauseDimension,
  eventNoun: string,
  unitNoun: "appointments",
  family: Family,
): { result: RootCauseDimensionResult; candidates: Candidate[] } {
  const cfg = ctx.config.proportion;
  const { recorded, coverage, groups } = partition(units, dimension);
  const stat = (label: string, members: readonly Unit[]): RootCauseGroupStat => {
    const events = members.filter((u) => u.event).length;
    const sized = members.length >= cfg.minGroupSize;
    return {
      label,
      n: members.length,
      unit: unitNoun,
      events,
      // No percentage for a denominator too small to carry one.
      rate: sized ? round1((events / members.length) * 100) : null,
      median: null,
      lowerQuartile: null,
      upperQuartile: null,
    };
  };
  const stats = groups.map((g) => stat(g.value.label, g.members));

  if (coverage < ctx.config.minCoverage) {
    return { result: { dimension, status: "not_recorded", coverage: round2(coverage), groups: stats, reason: `recorded for only ${Math.round(coverage * 100)}% of ${unitNoun}` }, candidates: [] };
  }
  if (groups.length < 2) {
    return { result: { dimension, status: "no_variation", coverage: round2(coverage), groups: stats, reason: "every unit falls in the same group" }, candidates: [] };
  }

  const candidates: Candidate[] = [];
  let sizedGroups = 0;
  const totalEvents = recorded.filter((u) => u.event).length;
  for (const group of groups) {
    const rest = recorded.filter((u) => u.dims[dimension]?.key !== group.value.key);
    if (group.members.length < cfg.minGroupSize || rest.length < cfg.minComparisonSize) continue;
    sizedGroups += 1;
    const e = group.members.filter((u) => u.event).length;
    const er = rest.filter((u) => u.event).length;
    const rate = e / group.members.length;
    const restRate = er / rest.length;
    const gap = (rate - restRate) * 100;
    const ratio = restRate > 0 ? rate / restRate : null;
    if (e < cfg.minGroupEvents || gap < cfg.minGapPoints || (ratio !== null && ratio < cfg.minRatio)) continue;
    // More than chance, allowing for how many groups were compared: without this,
    // noise alone produced a "concentration" for about one clinic in six.
    const p = fisherGreater(e, group.members.length, er, rest.length);
    if (p >= family.alpha) continue;

    const id = `${ctx.id}#${dimension}:${group.value.key}`;
    const g = stat(group.value.label, group.members);
    const r = stat("All other appointments", rest);
    candidates.push({
      association: {
        id,
        dimension,
        group: g,
        comparison: r,
        gap: round1(gap),
        gapUnit: "percentage_points",
        ratio: ratio === null ? null : round2(ratio),
        shareOfEvents: totalEvents === 0 ? null : round1((e / totalEvents) * 100),
        shareOfPopulation: round1((group.members.length / recorded.length) * 100),
        statement: `${capitalise(eventNoun)} are concentrated in ${group.value.phrase}: ${round1(rate * 100)}% (${e} of ${group.members.length}) versus ${round1(restRate * 100)}% (${er} of ${rest.length}) across all other appointments in the last ${ctx.config.windowDays} days.`,
        evidence: [
          `${e} of ${group.members.length} ${group.value.label.toLowerCase()} appointments were ${eventNoun.replace(/ appointments$/, "")}; ${er} of ${rest.length} others were.`,
          `The group holds ${round1((e / Math.max(1, totalEvents)) * 100)}% of these events from ${round1((group.members.length / recorded.length) * 100)}% of the appointments.`,
          testedLine("One-sided Fisher exact test", p, family),
        ],
      },
      members: new Set(group.members.filter((u) => u.event).map((u) => u.id)),
      nearMinimum: group.members.length < cfg.minGroupSize * 2 || rest.length < cfg.minComparisonSize * 2,
      coverage,
    });
  }

  const status = candidates.length > 0 ? "association_found" : sizedGroups === 0 ? "insufficient_sample" : "no_meaningful_difference";
  const reason =
    status === "association_found"
      ? `${candidates.length} group${candidates.length === 1 ? "" : "s"} passed every rule`
      : status === "insufficient_sample"
        ? `no group reached ${cfg.minGroupSize} ${unitNoun} with ${cfg.minComparisonSize} left to compare against`
        : `no group differed by at least ${cfg.minGapPoints} points, ${cfg.minRatio}× and ${cfg.minGroupEvents} events by more than chance across the comparisons made`;
  return { result: { dimension, status, coverage: round2(coverage), groups: stats, reason }, candidates };
}

function attrition(ctx: Context): RootCauseAnalysis {
  const focus = ctx.subject.focus;
  const eventNoun = focus === "cancelled" ? "cancelled appointments" : focus === "no_show" ? "missed appointments" : "lost appointments";
  const limitations = [
    ...COMMON_LIMITATIONS,
    "Booking origin undercounts recalls: a recall booked by hand from the appointment book carries no follow-up link.",
    "Appointments still marked scheduled after their time have no recorded outcome and are left out.",
    "The treatment an appointment was booked for is not recorded, so lost appointments cannot be split by treatment type.",
  ];
  const emptyPopulation = { description: `Appointments with a recorded outcome, ${ctx.from} to ${ctx.to}`, from: ctx.from, to: ctx.to, n: 0, events: null, excluded: [] };
  const problem = ctx.scheduleProblem();
  if (problem !== null) return insufficient(ctx, problem, emptyPopulation, limitations);

  const tz = ctx.input.timezone;
  const today = local(ctx.input.now, tz).date;
  let notYet = 0;
  let noOutcome = 0;
  let unresolved = 0;
  const units: Unit[] = [];
  for (const a of (ctx.input.schedule as ClinicLedgerGraph).slice.appointments) {
    if (Date.parse(a.scheduledAt) >= ctx.nowMs) {
      notYet += 1;
      continue;
    }
    if (!ATTENDED.has(a.status) && !LOST.has(a.status)) {
      noOutcome += 1;
      continue;
    }
    // Still checked in or in progress after its day ended: the patient arrived,
    // but nobody recorded how the visit ended. Neither attended nor lost.
    if (isUnresolvedVisit(a.status, local(a.scheduledAt, tz).date, today)) {
      unresolved += 1;
      continue;
    }
    const at = local(a.scheduledAt, tz);
    units.push({
      id: a.id,
      event: focus === "lost" ? LOST.has(a.status) : a.status === focus,
      dims: {
        [RootCauseDimension.DAY_OF_WEEK]: dayOfWeek(at.weekday, "appointments"),
        [RootCauseDimension.SESSION]: session(at.minuteOfDay, "appointments"),
        [RootCauseDimension.BOOKED_DURATION]: a.durationMinutes > 0 ? bookedDuration(a.durationMinutes, "appointments") : null,
        [RootCauseDimension.BOOKING_LEAD_TIME]: leadTime(a),
        [RootCauseDimension.BOOKING_ORIGIN]: origin(a),
      },
    });
  }
  const events = units.filter((u) => u.event).length;
  const population = {
    ...emptyPopulation,
    n: units.length,
    events,
    excluded: [
      { reason: "not yet happened", count: notYet },
      { reason: "outcome not recorded (still marked scheduled)", count: noOutcome },
      { reason: "outcome not recorded (still checked in or in progress after its day)", count: unresolved },
    ].filter((e) => e.count > 0),
  };
  const cfg = ctx.config.proportion;
  if (units.length < cfg.minPopulation) {
    return insufficient(ctx, `only ${units.length} appointments with a recorded outcome in the last ${ctx.config.windowDays} days (at least ${cfg.minPopulation} are needed)`, population, limitations);
  }
  if (events < cfg.minTotalEvents) {
    return insufficient(ctx, `only ${events} ${eventNoun} in the last ${ctx.config.windowDays} days (at least ${cfg.minTotalEvents} are needed to locate them)`, population, limitations);
  }

  const dims = [
    RootCauseDimension.DAY_OF_WEEK,
    RootCauseDimension.SESSION,
    RootCauseDimension.BOOKED_DURATION,
    RootCauseDimension.BOOKING_LEAD_TIME,
    RootCauseDimension.BOOKING_ORIGIN,
  ];
  const family = familyFor(ctx.config.familyAlpha, comparisonsIn(units, dims, cfg.minGroupSize, cfg.minComparisonSize, ctx.config.minCoverage));
  const results = dims.map((d) => proportionDimension(ctx, units, d, eventNoun, "appointments", family));
  return summarise(ctx, population, finalise(results.flatMap((r) => r.candidates), ctx.config), results.map((r) => r.result), limitations);
}

// ── measurements ────────────────────────────────────────────────────────────

function measurementDimension(
  ctx: Context,
  units: readonly Unit[],
  dimension: RootCauseDimension,
  sentence: (phrase: string, g: RootCauseGroupStat, r: RootCauseGroupStat) => string,
  family: Family,
): { result: RootCauseDimensionResult; candidates: Candidate[] } {
  const cfg = ctx.config.measurement;
  const { recorded, coverage, groups } = partition(units, dimension);
  const stat = (label: string, members: readonly Unit[]): RootCauseGroupStat => {
    const values = members.map((u) => u.value as number);
    const sized = members.length >= cfg.minGroupSize;
    return {
      label,
      n: members.length,
      unit: "visits",
      events: null,
      rate: null,
      median: sized ? round1(median(values)) : null,
      lowerQuartile: sized ? round1(quantile(values, 0.25)) : null,
      upperQuartile: sized ? round1(quantile(values, 0.75)) : null,
    };
  };
  const stats = groups.map((g) => stat(g.value.label, g.members));
  if (coverage < ctx.config.minCoverage) {
    return { result: { dimension, status: "not_recorded", coverage: round2(coverage), groups: stats, reason: `recorded for only ${Math.round(coverage * 100)}% of visits` }, candidates: [] };
  }
  if (groups.length < 2) {
    return { result: { dimension, status: "no_variation", coverage: round2(coverage), groups: stats, reason: "every visit falls in the same group" }, candidates: [] };
  }

  const candidates: Candidate[] = [];
  let sizedGroups = 0;
  for (const group of groups) {
    const rest = recorded.filter((u) => u.dims[dimension]?.key !== group.value.key);
    if (group.members.length < cfg.minGroupSize || rest.length < cfg.minComparisonSize) continue;
    sizedGroups += 1;
    const values = group.members.map((u) => u.value as number);
    const restValues = rest.map((u) => u.value as number);
    const gap = median(values) - median(restValues);
    // Most of the group, not just its middle, must sit strictly above what is
    // typical for everyone else — a few very long visits cannot carry the claim.
    const broad = quantile(values, 0.25) > median(restValues);
    if (gap < cfg.minGapMinutes || !broad) continue;
    // More than chance across the comparisons made. The median rules alone let
    // noise through for a quarter to a third of simulated clinics.
    const p = rankSumGreater(values, restValues);
    if (p >= family.alpha) continue;

    const g = stat(group.value.label, group.members);
    const r = stat("All other visits", rest);
    candidates.push({
      association: {
        id: `${ctx.id}#${dimension}:${group.value.key}`,
        dimension,
        group: g,
        comparison: r,
        gap: round1(gap),
        gapUnit: "minutes",
        ratio: null,
        shareOfEvents: null,
        shareOfPopulation: round1((group.members.length / recorded.length) * 100),
        statement: sentence(group.value.phrase, g, r),
        evidence: [
          `Median ${g.median} min across ${g.n} visits (middle half ${g.lowerQuartile}–${g.upperQuartile}) against ${r.median} min across ${r.n} other visits.`,
          `At least three quarters of the group are above the others' median.`,
          testedLine("One-sided rank-sum test", p, family),
        ],
      },
      members: new Set(group.members.map((u) => u.id)),
      nearMinimum: group.members.length < cfg.minGroupSize * 2 || rest.length < cfg.minComparisonSize * 2,
      coverage,
    });
  }
  const status = candidates.length > 0 ? "association_found" : sizedGroups === 0 ? "insufficient_sample" : "no_meaningful_difference";
  const reason =
    status === "association_found"
      ? `${candidates.length} group${candidates.length === 1 ? "" : "s"} passed every rule`
      : status === "insufficient_sample"
        ? `no group reached ${cfg.minGroupSize} visits with ${cfg.minComparisonSize} left to compare against`
        : `no group's median was at least ${cfg.minGapMinutes} minutes higher with three quarters of the group above the others' median`;
  return { result: { dimension, status, coverage: round2(coverage), groups: stats, reason }, candidates };
}

function overrun(ctx: Context): RootCauseAnalysis {
  const limitations = [
    ...COMMON_LIMITATIONS,
    "Only visits with both a call-in and a finish time are measured; clinics that do not close queue entries are under-sampled.",
    "Treatment type is what was recorded at the visit. Custom 'Other' entries are grouped only when spelled the same, and visits with several treatment types are left out of that dimension.",
  ];
  const emptyPopulation = { description: `Attended visits with call-in and finish recorded, ${ctx.from} to ${ctx.to}`, from: ctx.from, to: ctx.to, n: 0, events: null, excluded: [] };
  const problem = ctx.scheduleProblem([LedgerFactKind.QUEUE_VISIT]);
  if (problem !== null) return insufficient(ctx, problem, emptyPopulation, limitations);

  const graph = ctx.input.schedule as ClinicLedgerGraph;
  const tz = ctx.input.timezone;
  // Treatments withheld or cut short: the treatment-type dimension is not
  // recorded for anyone, rather than "no treatment" for everyone.
  const treatmentsReadable =
    !graph.slice.withheld.includes(LedgerFactKind.TREATMENT) && !graph.slice.truncated.includes(LedgerFactKind.TREATMENT);
  let unmeasured = 0;
  const units: Unit[] = [];
  for (const a of graph.slice.appointments) {
    if (!ATTENDED.has(a.status) || Date.parse(a.scheduledAt) >= ctx.nowMs) continue;
    const visit = graph.queueVisitForAppointment(a.id);
    if (visit.status !== "known" || visit.value === null || visit.value.calledAt === null || visit.value.completedAt === null) {
      unmeasured += 1;
      continue;
    }
    const actual = (Date.parse(visit.value.completedAt) - Date.parse(visit.value.calledAt)) / 60_000;
    if (actual < 0 || a.durationMinutes <= 0) {
      unmeasured += 1;
      continue;
    }
    const traversal = graph.treatmentsRecordedAtAppointment(a.id);
    const recordedTreatments: readonly TreatmentFact[] = traversal.status === "known" ? traversal.value : [];
    // One canonical spelling per type; a consultation (OPD) charge names no
    // treatment, so it neither makes a visit typed nor makes it multi-typed.
    const types = [
      ...new Set(recordedTreatments.map((t) => groupableTreatmentType(t.treatmentType)).filter((t): t is string => t !== null)),
    ].sort();
    const labelFor = (type: string): string => type;
    const at = local(a.scheduledAt, tz);
    units.push({
      id: a.id,
      value: Math.round(actual - a.durationMinutes),
      dims: {
        // One recorded type, or not recorded: zero types means nothing was written
        // down, several means the visit cannot be attributed to one.
        [RootCauseDimension.TREATMENT_TYPE]:
          treatmentsReadable && types.length === 1
            ? { key: types[0], label: labelFor(types[0]), phrase: `${labelFor(types[0]).toLowerCase()} visits` }
            : null,
        [RootCauseDimension.BOOKED_DURATION]: bookedDuration(a.durationMinutes, "visits"),
        [RootCauseDimension.DAY_OF_WEEK]: dayOfWeek(at.weekday, "visits"),
        [RootCauseDimension.SESSION]: session(at.minuteOfDay, "visits"),
      },
    });
  }
  const population = {
    ...emptyPopulation,
    n: units.length,
    events: null,
    excluded: unmeasured > 0 ? [{ reason: "attended but call-in or finish not recorded", count: unmeasured }] : [],
  };
  if (units.length < ctx.config.measurement.minPopulation) {
    return insufficient(ctx, `only ${units.length} measured visits in the last ${ctx.config.windowDays} days (at least ${ctx.config.measurement.minPopulation} are needed)`, population, limitations);
  }
  const sentence = (phrase: string, g: RootCauseGroupStat, r: RootCauseGroupStat) =>
    `Overruns are concentrated in ${phrase}: a median of ${g.median} minutes over the booked time (${g.n} visits) versus ${r.median} minutes (${r.n} other visits).`;
  const dims = [RootCauseDimension.TREATMENT_TYPE, RootCauseDimension.BOOKED_DURATION, RootCauseDimension.DAY_OF_WEEK, RootCauseDimension.SESSION];
  const family = familyFor(
    ctx.config.familyAlpha,
    comparisonsIn(units, dims, ctx.config.measurement.minGroupSize, ctx.config.measurement.minComparisonSize, ctx.config.minCoverage),
  );
  const results = dims.map((d) => measurementDimension(ctx, units, d, sentence, family));
  return summarise(ctx, population, finalise(results.flatMap((r) => r.candidates), ctx.config), results.map((r) => r.result), limitations);
}

function waiting(ctx: Context): RootCauseAnalysis {
  const limitations = [
    ...COMMON_LIMITATIONS,
    "Only visits that went through the queue and were called in are measured.",
    "Day density counts booked appointments; walk-ins who were never booked are not in it.",
  ];
  const emptyPopulation = { description: `Queue visits called in, ${ctx.from} to ${ctx.to}`, from: ctx.from, to: ctx.to, n: 0, events: null, excluded: [] };
  const problem = ctx.scheduleProblem([LedgerFactKind.QUEUE_VISIT]);
  if (problem !== null) return insufficient(ctx, problem, emptyPopulation, limitations);

  const graph = ctx.input.schedule as ClinicLedgerGraph;
  const tz = ctx.input.timezone;
  const perDate = new Map<string, number>();
  for (const a of graph.slice.appointments) {
    if (!OCCUPYING.has(a.status)) continue;
    const d = local(a.scheduledAt, tz).date;
    perDate.set(d, (perDate.get(d) ?? 0) + 1);
  }

  let notCalled = 0;
  const raw: { a: AppointmentFact; wait: number; checkedInAt: string; lateMinutes: number; date: string }[] = [];
  for (const a of graph.slice.appointments) {
    const visit = graph.queueVisitForAppointment(a.id);
    if (visit.status !== "known" || visit.value === null) continue;
    if (visit.value.calledAt === null) {
      notCalled += 1;
      continue;
    }
    const wait = (Date.parse(visit.value.calledAt) - Date.parse(visit.value.checkedInAt)) / 60_000;
    if (wait < 0) {
      notCalled += 1;
      continue;
    }
    raw.push({
      a,
      wait: Math.round(wait),
      checkedInAt: visit.value.checkedInAt,
      lateMinutes: (Date.parse(visit.value.checkedInAt) - Date.parse(a.scheduledAt)) / 60_000,
      date: local(visit.value.checkedInAt, tz).date,
    });
  }
  const population = {
    ...emptyPopulation,
    n: raw.length,
    events: null,
    excluded: notCalled > 0 ? [{ reason: "checked in but not called, or timings inconsistent", count: notCalled }] : [],
  };
  if (raw.length < ctx.config.measurement.minPopulation) {
    return insufficient(ctx, `only ${raw.length} measured waits in the last ${ctx.config.windowDays} days (at least ${ctx.config.measurement.minPopulation} are needed)`, population, limitations);
  }

  // Busier days: above the median booked-appointment count across the days that
  // had measured waits. Stated with the threshold, so the split is checkable.
  const threshold = Math.floor(median([...new Set(raw.map((r) => r.date))].map((d) => perDate.get(d) ?? 0)));
  const units: Unit[] = raw.map((r) => {
    const at = local(r.checkedInAt, tz);
    const count = perDate.get(r.date) ?? 0;
    return {
      id: r.a.id,
      value: r.wait,
      dims: {
        [RootCauseDimension.DAY_DENSITY]:
          count > threshold
            ? { key: "1", label: `Days with more than ${threshold} booked appointments`, phrase: `days with more than ${threshold} booked appointments` }
            : { key: "0", label: `Days with ${threshold} or fewer booked appointments`, phrase: `days with ${threshold} or fewer booked appointments` },
        [RootCauseDimension.ARRIVAL_PUNCTUALITY]:
          r.lateMinutes > 10
            ? { key: "2", label: "Arrived more than 10 min late", phrase: "patients who arrived more than 10 minutes late" }
            : r.lateMinutes < -10
              ? { key: "0", label: "Arrived more than 10 min early", phrase: "patients who arrived more than 10 minutes early" }
              : { key: "1", label: "Arrived within 10 min of the booked time", phrase: "patients who arrived within 10 minutes of their booked time" },
        [RootCauseDimension.DAY_OF_WEEK]: dayOfWeek(at.weekday, "arrivals"),
        [RootCauseDimension.SESSION]: session(at.minuteOfDay, "arrivals"),
      },
    };
  });
  const sentence = (phrase: string, g: RootCauseGroupStat, r: RootCauseGroupStat) =>
    `Longer waits are associated with ${phrase}: a median wait of ${g.median} minutes (${g.n} visits) versus ${r.median} minutes (${r.n} other visits).`;
  const dims = [RootCauseDimension.DAY_DENSITY, RootCauseDimension.ARRIVAL_PUNCTUALITY, RootCauseDimension.DAY_OF_WEEK, RootCauseDimension.SESSION];
  const family = familyFor(
    ctx.config.familyAlpha,
    comparisonsIn(units, dims, ctx.config.measurement.minGroupSize, ctx.config.measurement.minComparisonSize, ctx.config.minCoverage),
  );
  const results = dims.map((d) => measurementDimension(ctx, units, d, sentence, family));
  return summarise(ctx, population, finalise(results.flatMap((r) => r.candidates), ctx.config), results.map((r) => r.result), limitations);
}

// ── capacity ────────────────────────────────────────────────────────────────

function idleCapacity(ctx: Context): RootCauseAnalysis {
  const limitations = [
    ...COMMON_LIMITATIONS,
    "Open time is the clinic-wide published hours; whether every chair was staffed is not recorded.",
    "Today is left out: its bookings are still changing.",
  ];
  const lastFullDay = addDays(ctx.to, -1);
  const emptyPopulation = { description: `Open days and sessions, ${ctx.from} to ${lastFullDay}`, from: ctx.from, to: lastFullDay, n: 0, events: null, excluded: [] };
  const problem = ctx.scheduleProblem();
  if (problem !== null) return insufficient(ctx, problem, emptyPopulation, limitations);
  const capacity = ctx.input.capacity;
  if (capacity === null) return insufficient(ctx, ctx.input.unavailableReason ?? "published capacity for the window was not read", emptyPopulation, limitations);
  if (!capacity.availabilityConfigured) return insufficient(ctx, "the clinic has no active availability rules", emptyPopulation, limitations);

  const tz = ctx.input.timezone;
  const chairs = Math.max(1, capacity.chairCount);
  const appointments = (ctx.input.schedule as ClinicLedgerGraph).slice.appointments.filter((a) => OCCUPYING.has(a.status));

  interface Occurrence { id: string; utilization: number; weekday: number; session: number | null }
  const days: Occurrence[] = [];
  const sessions: Occurrence[] = [];
  for (const day of capacity.days) {
    if (day.date < ctx.from || day.date > lastFullDay || day.openMinutesPerChair <= 0) continue;
    const weekday = local(`${day.date}T12:00:00.000Z`, "UTC").weekday;
    const openBySession = [0, 0, 0];
    for (const span of day.openSpans) {
      const start = local(span.start, tz).minuteOfDay;
      const end = start + Math.round((Date.parse(span.end) - Date.parse(span.start)) / 60_000);
      for (let s = 0; s < 3; s += 1) {
        const [lo, hi] = SESSION_BOUNDS[s];
        openBySession[s] += Math.max(0, Math.min(end, hi) - Math.max(start, lo));
      }
    }
    // Booked minutes land in the session they overlap, so a visit running past
    // noon is not counted as wholly a morning one.
    const bookedBySession = [0, 0, 0];
    for (const a of appointments) {
      const at = local(a.scheduledAt, tz);
      if (at.date !== day.date) continue;
      const end = at.minuteOfDay + Math.max(0, a.durationMinutes);
      for (let s = 0; s < 3; s += 1) {
        const [lo, hi] = SESSION_BOUNDS[s];
        bookedBySession[s] += Math.max(0, Math.min(end, hi) - Math.max(at.minuteOfDay, lo));
      }
    }
    const open = openBySession.reduce((x, y) => x + y, 0) * chairs;
    const booked = bookedBySession.reduce((x, y) => x + y, 0);
    days.push({ id: day.date, utilization: Math.min(100, (booked / open) * 100), weekday, session: null });
    for (let s = 0; s < 3; s += 1) {
      if (openBySession[s] <= 0) continue;
      sessions.push({ id: `${day.date}#${s}`, utilization: Math.min(100, (bookedBySession[s] / (openBySession[s] * chairs)) * 100), weekday, session: s });
    }
  }
  const population = { ...emptyPopulation, n: days.length, events: null, excluded: [] };
  const cfg = ctx.config.capacity;
  if (days.length < cfg.minOccurrences + cfg.minComparisonOccurrences) {
    return insufficient(ctx, `only ${days.length} open days in the window (at least ${cfg.minOccurrences + cfg.minComparisonOccurrences} are needed)`, population, limitations);
  }

  const analyse = (
    dimension: RootCauseDimension,
    occurrences: readonly Occurrence[],
    keyOf: (o: Occurrence) => { key: string; label: string; phrase: string },
    unit: "days" | "sessions",
    family: Family,
  ): { result: RootCauseDimensionResult; candidates: Candidate[] } => {
    const groups = new Map<string, { value: { key: string; label: string; phrase: string }; members: Occurrence[] }>();
    for (const o of occurrences) {
      const value = keyOf(o);
      const entry = groups.get(value.key) ?? { value, members: [] };
      entry.members.push(o);
      groups.set(value.key, entry);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, g]) => g);
    const stat = (label: string, members: readonly Occurrence[]): RootCauseGroupStat => {
      const values = members.map((m) => m.utilization);
      const sized = members.length >= cfg.minOccurrences;
      return {
        label,
        n: members.length,
        unit,
        events: null,
        rate: null,
        median: sized ? round1(median(values)) : null,
        lowerQuartile: sized ? round1(quantile(values, 0.25)) : null,
        upperQuartile: sized ? round1(quantile(values, 0.75)) : null,
      };
    };
    const stats = ordered.map((g) => stat(g.value.label, g.members));
    if (ordered.length < 2) {
      return { result: { dimension, status: "no_variation", coverage: 1, groups: stats, reason: `every ${unit.slice(0, -1)} falls in the same group` }, candidates: [] };
    }
    const candidates: Candidate[] = [];
    let sized = 0;
    for (const group of ordered) {
      const rest = occurrences.filter((o) => keyOf(o).key !== group.value.key);
      if (group.members.length < cfg.minOccurrences || rest.length < cfg.minComparisonOccurrences) continue;
      sized += 1;
      const restMedian = median(rest.map((o) => o.utilization));
      const groupMedian = median(group.members.map((o) => o.utilization));
      const gap = restMedian - groupMedian;
      const consistent = group.members.filter((o) => o.utilization < restMedian).length / group.members.length >= cfg.consistency;
      if (gap < cfg.minGapPoints || !consistent) continue;
      // Lower than chance allows, across every day and session compared: day-to-day
      // swings alone passed the median rules for most simulated clinics.
      const p = rankSumGreater(
        group.members.map((o) => -o.utilization),
        rest.map((o) => -o.utilization),
      );
      if (p >= family.alpha) continue;
      const g = stat(group.value.label, group.members);
      const r = stat(`All other ${unit}`, rest);
      candidates.push({
        association: {
          id: `${ctx.id}#${dimension}:${group.value.key}`,
          dimension,
          group: g,
          comparison: r,
          gap: round1(-gap),
          gapUnit: "percentage_points",
          ratio: null,
          shareOfEvents: null,
          shareOfPopulation: round1((group.members.length / occurrences.length) * 100),
          statement: `Unused chair time is concentrated in ${group.value.phrase}: a median of ${g.median}% of chair time booked across ${g.n} ${unit} versus ${r.median}% across ${r.n} other ${unit}.`,
          evidence: [
            `Per-${unit.slice(0, -1)} booked share for the group: ${group.members.map((o) => `${round1(o.utilization)}%`).join(", ")}.`,
            `${Math.round(cfg.consistency * 100)}% or more of the group's ${unit} sit below the others' median of ${round1(restMedian)}%.`,
            testedLine("One-sided rank-sum test", p, family),
          ],
        },
        members: new Set(group.members.map((o) => o.id.split("#")[0])),
        nearMinimum: group.members.length < cfg.minOccurrences * 2 || rest.length < cfg.minComparisonOccurrences * 2,
        coverage: 1,
      });
    }
    const status = candidates.length > 0 ? "association_found" : sized === 0 ? "insufficient_sample" : "no_meaningful_difference";
    const reason =
      status === "association_found"
        ? `${candidates.length} group${candidates.length === 1 ? "" : "s"} passed every rule`
        : status === "insufficient_sample"
          ? `no group had ${cfg.minOccurrences} ${unit} with ${cfg.minComparisonOccurrences} others to compare against`
          : `no group's median booked share was ${cfg.minGapPoints} points lower, with most of its ${unit} below the others, by more than chance`;
    return { result: { dimension, status, coverage: 1, groups: stats, reason }, candidates };
  };

  const dayKey = (o: Occurrence) => ({ key: String((o.weekday + 6) % 7), label: DAY_NAMES[o.weekday], phrase: `${DAY_NAMES[o.weekday]}s` });
  const sessionKey = (o: Occurrence) => {
    const s = session([0, 720, 1020][o.session ?? 0], "sessions");
    return { key: s.key, label: s.label, phrase: s.phrase };
  };
  const sizedGroups = (occurrences: readonly Occurrence[], keyOf: (o: Occurrence) => { key: string }) => {
    const counts = new Map<string, number>();
    for (const o of occurrences) counts.set(keyOf(o).key, (counts.get(keyOf(o).key) ?? 0) + 1);
    if (counts.size < 2) return 0;
    return [...counts.values()].filter((n) => n >= cfg.minOccurrences && occurrences.length - n >= cfg.minComparisonOccurrences).length;
  };
  const family = familyFor(ctx.config.familyAlpha, sizedGroups(days, dayKey) + sizedGroups(sessions, sessionKey));
  const results = [
    analyse(RootCauseDimension.DAY_OF_WEEK, days, dayKey, "days", family),
    analyse(RootCauseDimension.SESSION, sessions, sessionKey, "sessions", family),
  ];
  return summarise(ctx, population, finalise(results.flatMap((r) => r.candidates), ctx.config), results.map((r) => r.result), limitations);
}

const capitalise = (s: string) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));
const lowerFirst = (s: string) => (s.length === 0 ? s : s[0].toLowerCase() + s.slice(1));
