/**
 * Business Brain — Diagnosis Engine: discriminator resolvers
 *
 * One pure function per entity-level discriminator. Each takes the rows the
 * orchestrator fetched and reports what they show about the hypotheses the
 * matcher said this measurement would separate.
 *
 * Three rules hold throughout, and the specs enforce all three:
 *
 *   1. NO BARE NUMBERS. Every threshold arrives through config, exactly as in
 *      the signal evaluators.
 *   2. NO ADVICE. Descriptions state what was measured. `no-advice.spec.ts`
 *      scans every string this file can emit.
 *   3. DESCRIBE EVEN WHEN NOT CONCLUDING. A sample too small to settle anything
 *      still produces evidence saying so. "We looked and could not tell" is a
 *      different and more useful answer than silence.
 */

import type { Evidence } from "../../../types";
import { MetricUnit } from "../../../domain";
import { formatValue } from "../../signals/support/evidence";
import { round2 } from "../../signals/support/numbers";
import { DISCRIMINATORS } from "../support/discriminators";
import type {
  DiscriminatorResolver,
  ResolutionOutcome,
  ResolverInput,
} from "./types";

const SOURCE = "DiagnosisEngine/entity-context";

function evidence(input: ResolverInput, slug: string, description: string, data: unknown): Evidence {
  return {
    id: `${input.diagnosisId}#e.${slug}`,
    source: SOURCE,
    description,
    data,
    capturedAt: input.now,
  };
}

/** Only what a resolver observed — nothing settled. */
function observed(
  input: ResolverInput,
  slug: string,
  description: string,
  data: unknown,
): ResolutionOutcome {
  return { evidence: [evidence(input, slug, description, data)], supports: [], contradicts: [] };
}

/** Percentage of `part` in `whole`, to one decimal, safe at zero. */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : round2((part / whole) * 100);
}

/** Median of a non-empty numeric list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The largest bucket in a tally, and its share of the whole. */
function largestBucket(
  counts: Map<string, number>,
  total: number,
): { label: string; count: number; sharePct: number } | null {
  let best: { label: string; count: number } | null = null;
  // Ties broken by label so the output is byte-identical across runs, which the
  // determinism spec requires of everything this engine emits.
  for (const label of [...counts.keys()].sort()) {
    const count = counts.get(label) ?? 0;
    if (best === null || count > best.count) best = { label, count };
  }
  return best === null ? null : { ...best, sharePct: share(best.count, total) };
}

/** `separates[i]`, or undefined when the matcher named fewer hypotheses. */
function hypothesis(input: ResolverInput, index: number): string | undefined {
  return input.separates[index];
}

/** Drop undefined slugs so a resolver never claims to settle a hypothesis that was not declared. */
function slugs(...values: (string | undefined)[]): string[] {
  return values.filter((v): v is string => v !== undefined);
}

// ── Cancellations ────────────────────────────────────────────────────────────

/**
 * How much notice the lost appointments gave.
 *
 * Separates cancellations made early enough that the slot could in principle be
 * refilled from cancellations made too late for that. Appointments with no
 * recorded cancellation moment are excluded from the median rather than treated
 * as zero notice — the adapter deliberately leaves those null, and counting them
 * as last-minute would manufacture the finding.
 */
const cancellationTiming: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.cancellationEvents;
  if (rows == null) return null;

  const timed = rows.filter((r) => r.noticeHours !== null);
  if (timed.length === 0) {
    return rows.length === 0
      ? null
      : observed(
          input,
          "cancellation-timing",
          `${rows.length} lost appointment(s) in the window, none with a recorded cancellation moment, so notice could not be measured.`,
          { lost: rows.length, timed: 0 },
        );
  }

  const notices = timed.map((r) => r.noticeHours as number);
  const medianNotice = round2(median(notices));
  const { recoverableNoticeHours, minimumSample, majorityShare } = input.config;
  const recoverable = timed.filter((r) => (r.noticeHours as number) >= recoverableNoticeHours);
  const recoverableShare = share(recoverable.length, timed.length);

  const description =
    `${timed.length} of ${rows.length} lost appointment(s) carried a recorded cancellation moment. ` +
    `Median notice ${formatValue(medianNotice, MetricUnit.HOURS)}; ` +
    `${recoverable.length} (${formatValue(recoverableShare, MetricUnit.PERCENTAGE)}) gave at least ` +
    `${formatValue(recoverableNoticeHours, MetricUnit.HOURS)} of notice.`;
  const data = { lost: rows.length, timed: timed.length, medianNotice, recoverableShare };

  if (timed.length < minimumSample) {
    return observed(input, "cancellation-timing", `${description} Sample below the configured minimum of ${minimumSample}, so nothing is concluded from the distribution.`, data);
  }

  // First slug is the advance-cancellation explanation, second the alternative
  // the matcher paired it against.
  const advance = hypothesis(input, 0);
  const alternative = hypothesis(input, 1);
  const mostlyRecoverable = recoverableShare >= majorityShare * 100;

  return {
    evidence: [evidence(input, "cancellation-timing", description, data)],
    supports: mostlyRecoverable ? slugs(advance) : slugs(alternative),
    contradicts: mostlyRecoverable ? [] : slugs(advance),
  };
};

/**
 * Whether losses concentrate in particular times of day or treatment types.
 *
 * A day that loses six appointments spread evenly and a day that loses six all
 * at 09:00 are the same count and different problems.
 */
const cancellationSlotClustering: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.cancellationEvents;
  if (rows == null || rows.length === 0) return null;

  const byHour = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const r of rows) {
    // The clinic's hour, from the adapter. The ISO start's own digits are UTC.
    const hour = r.localHour;
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    if (r.treatmentType !== null) byType.set(r.treatmentType, (byType.get(r.treatmentType) ?? 0) + 1);
  }

  const typed = [...byType.values()].reduce((a, b) => a + b, 0);
  const topHour = largestBucket(byHour, rows.length);
  const topType = typed > 0 ? largestBucket(byType, typed) : null;

  const { minimumSample, concentrationShare } = input.config;
  const description =
    `${rows.length} lost appointment(s). ` +
    (topHour
      ? `Busiest hour ${topHour.label} with ${topHour.count} (${formatValue(topHour.sharePct, MetricUnit.PERCENTAGE)}). `
      : "") +
    (topType
      ? `Most affected treatment type "${topType.label}" with ${topType.count} of ${typed} typed (${formatValue(topType.sharePct, MetricUnit.PERCENTAGE)}).`
      : "No treatment type was recorded against the lost appointments.");
  const data = { lost: rows.length, topHour, topType };

  if (rows.length < minimumSample) {
    return observed(input, "cancellation-clustering", `${description} Sample below the configured minimum of ${minimumSample}, so concentration is not called.`, data);
  }

  const threshold = concentrationShare * 100;
  // Treatment type is recorded against few lost appointments (see
  // CancellationEvent.treatmentType). One typed row out of eight is 100% of the
  // typed set and says nothing about where losses concentrate, so a type share
  // only counts once the TYPED sample itself clears the minimum.
  const typeJudgeable = typed >= minimumSample;
  const concentrated =
    (topHour?.sharePct ?? 0) >= threshold ||
    (typeJudgeable && (topType?.sharePct ?? 0) >= threshold);
  const clustering = hypothesis(input, 0);
  const spread = hypothesis(input, 1);

  return {
    evidence: [evidence(input, "cancellation-clustering", description, data)],
    supports: concentrated ? slugs(clustering) : slugs(spread),
    contradicts: concentrated ? [] : slugs(clustering),
  };
};

/**
 * Whether the vacated capacity was recovered.
 *
 * A cancellation whose slot was rebooked cost the clinic nothing; one that stayed
 * empty cost a full appointment. The count alone cannot tell them apart.
 */
const slotRefillOutcome: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.cancellationEvents;
  if (rows == null || rows.length === 0) return null;

  const refilled = rows.filter((r) => r.slotRefilled);
  const refilledShare = share(refilled.length, rows.length);
  const description =
    `${refilled.length} of ${rows.length} vacated slot(s) were subsequently occupied ` +
    `(${formatValue(refilledShare, MetricUnit.PERCENTAGE)}); the remainder went unused.`;
  const data = { lost: rows.length, refilled: refilled.length, refilledShare };

  if (rows.length < input.config.minimumSample) {
    return observed(input, "slot-refill", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so nothing is concluded from the rate.`, data);
  }

  // Recovered capacity argues against lost capacity being the day's mechanism.
  const mostlyRecovered = refilledShare >= input.config.majorityShare * 100;
  return {
    evidence: [evidence(input, "slot-refill", description, data)],
    supports: [],
    contradicts: mostlyRecovered ? slugs(...input.separates) : [],
  };
};

/**
 * Whether the patients who failed to attend had failed before.
 *
 * Separates a clinic-wide process problem, which would hit first-timers and
 * regulars alike, from a concentration among a few repeat non-attenders.
 */
const noShowPatientHistory: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.noShowHistory;
  if (rows == null || rows.length === 0) return null;

  const repeat = rows.filter((r) => r.priorMissed > 0);
  const firstTime = rows.length - repeat.length;
  const repeatShare = share(repeat.length, rows.length);
  const description =
    `${rows.length} non-attendance(s) by ${new Set(rows.map((r) => r.patientId)).size} patient(s). ` +
    `${repeat.length} (${formatValue(repeatShare, MetricUnit.PERCENTAGE)}) were by patients who had missed an appointment before; ` +
    `${firstTime} were a first occurrence.`;
  const data = { total: rows.length, repeat: repeat.length, firstTime, repeatShare };

  if (rows.length < input.config.minimumSample) {
    return observed(input, "no-show-history", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so nothing is concluded from the split.`, data);
  }

  const patientLevel = hypothesis(input, 0);
  const processLevel = hypothesis(input, 1);
  const concentrated = repeatShare >= input.config.majorityShare * 100;

  return {
    evidence: [evidence(input, "no-show-history", description, data)],
    supports: concentrated ? slugs(patientLevel) : slugs(processLevel),
    contradicts: concentrated ? [] : slugs(patientLevel),
  };
};

// ── Pending work ─────────────────────────────────────────────────────────────

/**
 * How old the unbooked backlog is.
 *
 * Separates plans recorded today with no next visit yet — normal, and no problem
 * at all — from plans that have been sitting for weeks.
 */
const pendingTreatmentAge: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.pendingTreatments;
  if (rows == null || rows.length === 0) return null;

  const ages = rows.map((r) => r.ageDays);
  const medianAge = round2(median(ages));
  const aged = rows.filter((r) => r.ageDays >= input.config.agedDays);
  const agedShare = share(aged.length, rows.length);
  const description =
    `${rows.length} planned treatment(s) with no next visit booked. Median age ${formatValue(medianAge, MetricUnit.DAYS)}; ` +
    `${aged.length} (${formatValue(agedShare, MetricUnit.PERCENTAGE)}) have been waiting for at least ` +
    `${formatValue(input.config.agedDays, MetricUnit.DAYS)}.`;
  const data = { pending: rows.length, medianAge, aged: aged.length, agedShare };

  if (rows.length < input.config.minimumSample) {
    return observed(input, "pending-age", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so nothing is concluded from the distribution.`, data);
  }

  const standing = hypothesis(input, 0);
  const recent = hypothesis(input, 1);
  const mostlyAged = agedShare >= input.config.majorityShare * 100;

  return {
    evidence: [evidence(input, "pending-age", description, data)],
    supports: mostlyAged ? slugs(standing) : slugs(recent),
    contradicts: mostlyAged ? [] : slugs(standing),
  };
};

/**
 * What the unscheduled backlog is made of.
 *
 * Separates a backlog concentrated in long or high-value work from one spread
 * across routine work — the same count of pending plans, very different money.
 */
const pendingTreatmentComposition: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.pendingTreatments;
  if (rows == null || rows.length === 0) return null;

  const byValue = new Map<string, number>();
  let totalValue = 0;
  for (const r of rows) {
    byValue.set(r.treatmentType, (byValue.get(r.treatmentType) ?? 0) + r.quotedValue.value);
    totalValue += r.quotedValue.value;
  }
  const top = largestBucket(byValue, totalValue);
  const description =
    `${rows.length} unscheduled plan(s) worth ${formatValue(round2(totalValue), MetricUnit.CURRENCY)} in total across ` +
    `${byValue.size} treatment type(s).` +
    (top
      ? ` Largest by value: "${top.label}" at ${formatValue(round2(top.count), MetricUnit.CURRENCY)} (${formatValue(top.sharePct, MetricUnit.PERCENTAGE)}).`
      : "");
  const data = { pending: rows.length, totalValue: round2(totalValue), types: byValue.size, top };

  if (rows.length < input.config.minimumSample) {
    return observed(input, "pending-composition", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so concentration is not called.`, data);
  }

  const concentrated = (top?.sharePct ?? 0) >= input.config.concentrationShare * 100;
  const narrow = hypothesis(input, 0);
  const broad = hypothesis(input, 1);
  return {
    evidence: [evidence(input, "pending-composition", description, data)],
    supports: concentrated ? slugs(narrow) : slugs(broad),
    contradicts: concentrated ? [] : slugs(narrow),
  };
};

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * Whether the receivable book is today's uncollected work or long-unpaid
 * balances.
 *
 * Weighted by AMOUNT, not by count: one aged five-figure balance matters more
 * than twenty recent small ones, and counting rows would say the opposite.
 */
const outstandingInvoiceAgeing: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.outstandingBalances;
  if (rows == null || rows.length === 0) return null;

  const total = rows.reduce((sum, r) => sum + r.amountOutstanding.value, 0);
  const agedRows = rows.filter((r) => r.ageDays >= input.config.agedDays);
  const agedValue = agedRows.reduce((sum, r) => sum + r.amountOutstanding.value, 0);
  const agedShare = share(agedValue, total);
  const medianAge = round2(median(rows.map((r) => r.ageDays)));

  const description =
    `${rows.length} unpaid balance(s) totalling ${formatValue(round2(total), MetricUnit.CURRENCY)}. ` +
    `Median age ${formatValue(medianAge, MetricUnit.DAYS)}; ` +
    `${formatValue(round2(agedValue), MetricUnit.CURRENCY)} (${formatValue(agedShare, MetricUnit.PERCENTAGE)}) ` +
    `has been outstanding for at least ${formatValue(input.config.agedDays, MetricUnit.DAYS)}.`;
  const data = { balances: rows.length, total: round2(total), medianAge, agedValue: round2(agedValue), agedShare };

  if (rows.length < input.config.minimumSample) {
    return observed(input, "outstanding-ageing", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so nothing is concluded from the ageing.`, data);
  }

  const standing = hypothesis(input, 0);
  const recent = hypothesis(input, 1);
  const mostlyAged = agedShare >= input.config.majorityShare * 100;
  return {
    evidence: [evidence(input, "outstanding-ageing", description, data)],
    supports: mostlyAged ? slugs(standing) : slugs(recent),
    contradicts: mostlyAged ? [] : slugs(standing),
  };
};

/**
 * Whether low revenue came from cheaper work or from work that was not paid for.
 *
 * Two problems with opposite responses that are indistinguishable in a daily
 * revenue total, which is exactly why the discriminator exists.
 */
const completedTreatmentMix: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.completedTreatments;
  if (rows == null || rows.length === 0) return null;

  const billed = rows.reduce((sum, r) => sum + r.billedValue.value, 0);
  const collected = rows.reduce((sum, r) => sum + r.collectedValue.value, 0);
  const collectedShare = share(collected, billed);
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.treatmentType, (byType.get(r.treatmentType) ?? 0) + r.billedValue.value);
  const top = largestBucket(byType, billed);
  const averageCase = rows.length === 0 ? 0 : round2(billed / rows.length);

  const description =
    `${rows.length} treatment(s) completed, billing ${formatValue(round2(billed), MetricUnit.CURRENCY)} ` +
    `with ${formatValue(round2(collected), MetricUnit.CURRENCY)} collected against them ` +
    `(${formatValue(collectedShare, MetricUnit.PERCENTAGE)}). ` +
    `Average case ${formatValue(averageCase, MetricUnit.CURRENCY)} across ${byType.size} treatment type(s).` +
    (top ? ` Largest by value: "${top.label}" (${formatValue(top.sharePct, MetricUnit.PERCENTAGE)}).` : "");
  const data = { completed: rows.length, billed: round2(billed), collected: round2(collected), collectedShare, averageCase, top };

  if (rows.length < input.config.minimumSample) {
    return observed(input, "completed-mix", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so nothing is concluded from the mix.`, data);
  }

  // Work delivered but not collected points at collection, not at case mix.
  const collectionGap = collectedShare < input.config.majorityShare * 100;
  const uncollected = hypothesis(input, 0);
  const mix = hypothesis(input, 1);
  return {
    evidence: [evidence(input, "completed-mix", description, data)],
    supports: collectionGap ? slugs(uncollected) : slugs(mix),
    contradicts: collectionGap ? [] : slugs(uncollected),
  };
};

// ── Arrivals ─────────────────────────────────────────────────────────────────

/**
 * Whether queueing came from patients arriving together or from exhausted
 * capacity.
 *
 * Appointments with no recorded arrival are reported separately rather than
 * folded in: a front desk that did not use the queue and a patient who never
 * came look identical here, and averaging over them would invent punctuality
 * data.
 */
const appointmentArrivalTimes: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.appointmentArrivals;
  if (rows == null || rows.length === 0) return null;

  const arrived = rows.filter((r) => r.arrivalDeltaMinutes !== null);
  const missing = rows.length - arrived.length;
  if (arrived.length === 0) {
    return observed(
      input,
      "arrival-times",
      `${rows.length} appointment(s) in the window, none with a recorded arrival, so arrival timing could not be measured.`,
      { appointments: rows.length, arrivals: 0 },
    );
  }

  const deltas = arrived.map((r) => r.arrivalDeltaMinutes as number);
  const medianDelta = round2(median(deltas));
  const early = deltas.filter((d) => d < 0).length;
  const late = deltas.filter((d) => d > 0).length;
  const byHour = new Map<string, number>();
  for (const r of arrived) {
    const hour = r.arrivalLocalHour as string;
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }
  const top = largestBucket(byHour, arrived.length);

  const description =
    `${arrived.length} of ${rows.length} appointment(s) had a recorded arrival` +
    (missing > 0 ? `; ${missing} did not and are excluded from the timing` : "") +
    `. Median arrival ${formatValue(Math.abs(medianDelta), MetricUnit.MINUTES)} ` +
    `${medianDelta < 0 ? "before" : "after"} the scheduled start; ${early} early, ${late} late.` +
    (top ? ` Busiest arrival hour ${top.label} with ${top.count} (${formatValue(top.sharePct, MetricUnit.PERCENTAGE)}).` : "");
  const data = { appointments: rows.length, arrivals: arrived.length, missing, medianDelta, early, late, top };

  if (arrived.length < input.config.minimumSample) {
    return observed(input, "arrival-times", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so bunching is not called.`, data);
  }

  const bunched = (top?.sharePct ?? 0) >= input.config.concentrationShare * 100;
  const arrivalBunching = hypothesis(input, 0);
  const capacity = hypothesis(input, 1);
  return {
    evidence: [evidence(input, "arrival-times", description, data)],
    supports: bunched ? slugs(arrivalBunching) : slugs(capacity),
    contradicts: bunched ? [] : slugs(arrivalBunching),
  };
};

/**
 * Whether appointments ran over the time they were booked for.
 *
 * The counterpart to arrival timing, and the other half of "why is the clinic
 * running late". Both produce a queue; they call for opposite responses, and a
 * waiting-room photograph cannot tell them apart.
 *
 * Only appointments with BOTH ends recorded are measured. One still in the chair
 * has no duration yet, and one whose queue entry was never closed has none at
 * all — counting either as a fast appointment would drag the average down and
 * hide the overrun this exists to find.
 */
const serviceTimeDistribution: DiscriminatorResolver = (ctx, input) => {
  const rows = ctx.appointmentArrivals;
  if (rows == null || rows.length === 0) return null;

  const measured = rows.filter((r) => r.actualMinutes !== null && r.scheduledMinutes > 0);
  if (measured.length === 0) {
    return observed(
      input,
      "service-time",
      `${rows.length} appointment(s) in the window, none with both a start and an end recorded, so actual duration could not be measured.`,
      { appointments: rows.length, measured: 0 },
    );
  }

  const overruns = measured.map(
    (r) => (r.actualMinutes as number) - r.scheduledMinutes,
  );
  const medianOverrun = round2(median(overruns));
  const medianActual = round2(median(measured.map((r) => r.actualMinutes as number)));
  const medianScheduled = round2(median(measured.map((r) => r.scheduledMinutes)));
  const ranLong = measured.filter(
    (r) => (r.actualMinutes as number) > r.scheduledMinutes,
  );
  const ranLongShare = share(ranLong.length, measured.length);

  const description =
    `${measured.length} of ${rows.length} appointment(s) had both a start and an end recorded. ` +
    `Median booked ${formatValue(medianScheduled, MetricUnit.MINUTES)} against median actual ` +
    `${formatValue(medianActual, MetricUnit.MINUTES)}, a difference of ` +
    `${formatValue(Math.abs(medianOverrun), MetricUnit.MINUTES)} ` +
    `${medianOverrun > 0 ? "longer" : medianOverrun < 0 ? "shorter" : "either way"} than booked. ` +
    `${ranLong.length} (${formatValue(ranLongShare, MetricUnit.PERCENTAGE)}) ran past their booked length.`;
  const data = {
    appointments: rows.length,
    measured: measured.length,
    medianScheduled,
    medianActual,
    medianOverrun,
    ranLongShare,
  };

  if (measured.length < input.config.minimumSample) {
    return observed(input, "service-time", `${description} Sample below the configured minimum of ${input.config.minimumSample}, so overrunning is not called.`, data);
  }

  const overrunning = hypothesis(input, 0);
  const arrivalTiming = hypothesis(input, 1);
  const mostlyOverran = ranLongShare >= input.config.majorityShare * 100;

  return {
    evidence: [evidence(input, "service-time", description, data)],
    supports: mostlyOverran ? slugs(overrunning) : slugs(arrivalTiming),
    contradicts: mostlyOverran ? [] : slugs(overrunning),
  };
};

/**
 * Every entity-level discriminator this engine can resolve, keyed by catalogue
 * slug.
 *
 * `recall_contact_attempts` is deliberately ABSENT. OraMedha records no contact
 * attempts, the port returns null for it, and a resolver would have nothing to
 * read. Its hypotheses stay undetermined — the honest outcome, and the one the
 * discriminator's own description asks for.
 */
export const DISCRIMINATOR_RESOLVERS: Readonly<Record<string, DiscriminatorResolver>> = {
  [DISCRIMINATORS.CANCELLATION_TIMING.slug]: cancellationTiming,
  [DISCRIMINATORS.CANCELLATION_SLOT_CLUSTERING.slug]: cancellationSlotClustering,
  [DISCRIMINATORS.SLOT_REFILL_OUTCOME.slug]: slotRefillOutcome,
  [DISCRIMINATORS.NO_SHOW_PATIENT_HISTORY.slug]: noShowPatientHistory,
  [DISCRIMINATORS.PENDING_TREATMENT_AGE.slug]: pendingTreatmentAge,
  [DISCRIMINATORS.PENDING_TREATMENT_COMPOSITION.slug]: pendingTreatmentComposition,
  [DISCRIMINATORS.OUTSTANDING_INVOICE_AGEING.slug]: outstandingInvoiceAgeing,
  [DISCRIMINATORS.COMPLETED_TREATMENT_MIX.slug]: completedTreatmentMix,
  [DISCRIMINATORS.APPOINTMENT_ARRIVAL_TIMES.slug]: appointmentArrivalTimes,
  [DISCRIMINATORS.SERVICE_TIME_DISTRIBUTION.slug]: serviceTimeDistribution,
};
