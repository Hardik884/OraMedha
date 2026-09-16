/**
 * Business Brain — Diagnosis Engine: diagnosis assembly
 *
 * One place that turns "these signals form this pattern" into a fully formed
 * Diagnosis: stable id, persistence, severity, confidence, hypotheses,
 * discriminators, and the evidence that makes every one of those auditable.
 *
 * Ids are deterministic (`diagnosis.<pattern>:<clinicId>:<date>`) so re-running a
 * day overwrites rather than duplicates.
 *
 * Evidence records measurements and logic. It never records advice.
 */

import {
  EntityType,
  SignalType,
  type Diagnosis,
  type DiagnosisPattern,
  type Discriminator,
  type Signal,
  type SignalCategory,
} from "../../../domain";
import type { Evidence } from "../../../types";
import type { DiagnosisConfig } from "../config/diagnosis-config";
import { computeDiagnosisConfidence } from "./diagnosis-confidence";
import { assessDiagnosisSeverity } from "./diagnosis-severity";
import { DISCRIMINATORS, type DiscriminatorKey } from "./discriminators";
import {
  buildHypotheses,
  diagnosisEvidence,
  type EvidenceNote,
  type HypothesisSpec,
} from "./hypothesis-builder";
import { classifyPersistence, type HistoryWindow } from "./persistence";
import { breachMagnitudeOf, signalTypeOf, type SignalIndex } from "./signal-index";
import { round2 } from "../../signals/support/numbers";

/** A discriminator a matcher attaches, bound to the hypotheses it separates. */
export interface DiscriminatorDeclaration {
  readonly key: DiscriminatorKey;
  /** Hypothesis slugs (not ids) this measurement would separate. */
  readonly separates: readonly string[];
}

/** Everything a matcher must supply to raise a diagnosis. */
export interface DiagnosisDraft {
  readonly pattern: DiagnosisPattern;
  readonly category: SignalCategory;
  readonly title: string;
  /** Factual restatement of the correlated observations. Never advice. */
  readonly summary: string;
  /** The signals that actually contributed, in canonical order. */
  readonly contributing: readonly Signal[];
  /** Signal types the pattern declares as required. */
  readonly requiredSignals: readonly SignalType[];
  /** Signal types the pattern declares as optional. */
  readonly optionalSignals: readonly SignalType[];
  readonly hypotheses: readonly HypothesisSpec[];
  readonly discriminators: readonly DiscriminatorDeclaration[];
  /** Discrimination arithmetic and any other measurement notes. */
  readonly evidence?: readonly EvidenceNote[];
  /**
   * Extra id segment for patterns that legitimately emit more than one diagnosis
   * per clinic-day. Only `unclustered_signal` uses it.
   */
  readonly idQualifier?: string;
}

/** Shared context every matcher and the builder receive. */
export interface BuilderContext {
  readonly clinicId: string;
  readonly date: string;
  readonly now: string;
  readonly signals: SignalIndex;
  readonly window: HistoryWindow;
  readonly config: DiagnosisConfig;
}

export type BuildOutcome =
  | { readonly kind: "diagnosis"; readonly diagnosis: Diagnosis }
  | { readonly kind: "suppressed"; readonly reason: string };

/** Deterministic id for a diagnosis of a given pattern on a clinic-day. */
export function diagnosisId(
  pattern: DiagnosisPattern,
  clinicId: string,
  date: string,
  qualifier?: string,
): string {
  const head = qualifier ? `${pattern}.${qualifier}` : pattern;
  return `diagnosis.${head}:${clinicId}:${date}`;
}

/**
 * Signal pairs that describe states which cannot both hold for a whole day.
 * They are never silently dropped: co-occurrence usually means the two metrics
 * describe different parts of the same day, and that is worth recording.
 */
const CONTRADICTORY_PAIRS: readonly (readonly [SignalType, SignalType])[] = [
  [
    SignalType.OPERATIONAL_NEAR_FULL_CAPACITY,
    SignalType.OPERATIONAL_LOW_CHAIR_UTILIZATION,
  ],
];

function conflictNotes(
  contributingTypes: readonly SignalType[],
  index: SignalIndex,
): EvidenceNote[] {
  const notes: EvidenceNote[] = [];
  for (const [a, b] of CONTRADICTORY_PAIRS) {
    if (!index.has(a) || !index.has(b)) continue;
    if (!contributingTypes.includes(a) && !contributingTypes.includes(b)) continue;
    notes.push({
      slug: "signal-conflict",
      description: `${a} and ${b} were both emitted for this day. The two states cannot hold simultaneously for a whole day, so the metrics describe different parts of it. Both patterns are reported rather than either being discarded.`,
      data: { conflicting: [a, b] },
    });
  }
  return notes;
}

/** Mean breach magnitude of the contributing signals in the current run. */
function currentBreach(contributing: readonly Signal[]): number | null {
  const values = contributing
    .map(breachMagnitudeOf)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** Assemble a diagnosis, or report it as suppressed for low confidence. */
export function buildDiagnosis(
  ctx: BuilderContext,
  draft: DiagnosisDraft,
): BuildOutcome {
  const id = diagnosisId(draft.pattern, ctx.clinicId, ctx.date, draft.idQualifier);
  const contributingTypes = draft.contributing.map(signalTypeOf);

  const persistence = classifyPersistence({
    window: ctx.window,
    currentDate: ctx.date,
    contributingTypes,
    todayBreach: currentBreach(draft.contributing),
    config: ctx.config,
  });

  const severity = assessDiagnosisSeverity({
    contributing: draft.contributing.map((signal) => signal.severity),
    persistence: persistence.persistence,
    pattern: draft.pattern,
    config: ctx.config,
  });

  const optionalPresent = draft.optionalSignals.filter((type) =>
    ctx.signals.has(type),
  );
  const absentRequired = draft.requiredSignals.filter(
    (type) => !ctx.signals.has(type),
  );
  const skippedRequired = absentRequired.filter(
    (type) => !ctx.signals.absence(type).informative,
  );

  const confidence = computeDiagnosisConfidence({
    config: ctx.config,
    optionalDeclared: draft.optionalSignals.length,
    optionalPresent: optionalPresent.length,
    contributingConfidences: draft.contributing.map((signal) => signal.confidence),
    persistence: persistence.persistence,
    unknownHistoryDays: persistence.unknownDates.length,
    skippedRequiredEvaluators: skippedRequired.length,
  });

  if (confidence.confidence < ctx.config.confidence.minimumToEmit) {
    return {
      kind: "suppressed",
      reason: `suppressed: confidence ${confidence.confidence} below minimum ${ctx.config.confidence.minimumToEmit} (${confidence.deductions.join("; ")}).`,
    };
  }

  const hypotheses = buildHypotheses({
    diagnosisId: id,
    specs: draft.hypotheses,
    diagnosisConfidence: confidence.confidence,
    now: ctx.now,
    config: ctx.config,
  });

  const hypothesisIdBySlug = new Map(
    draft.hypotheses.map((spec, index) => [spec.slug, hypotheses[index].id] as const),
  );
  const discriminators: Discriminator[] = draft.discriminators.map((declaration) => {
    const spec = DISCRIMINATORS[declaration.key];
    return {
      id: `${id}#d.${spec.slug}`,
      description: spec.description,
      wouldSeparate: declaration.separates.map((slug) => {
        const hypothesisId = hypothesisIdBySlug.get(slug);
        if (!hypothesisId) {
          throw new Error(
            `Discriminator ${spec.slug} on ${id} names unknown hypothesis slug "${slug}".`,
          );
        }
        return hypothesisId;
      }),
      availability: spec.availability,
    };
  });

  // Invariant: an entirely undetermined diagnosis is valid and expected, but it
  // must say what would separate the possibilities. Otherwise it is a shrug.
  const allUndetermined = hypotheses.every((h) => h.status === "undetermined");
  if (allUndetermined && discriminators.length === 0) {
    throw new Error(
      `Diagnosis ${id} has no settled hypothesis and no discriminator. An undetermined diagnosis must state what measurement would separate the possibilities.`,
    );
  }

  const evidence: Evidence[] = [];
  const note = (item: EvidenceNote) =>
    evidence.push(
      diagnosisEvidence({
        ownerId: id,
        slug: item.slug,
        description: item.description,
        capturedAt: ctx.now,
        data: item.data,
      }),
    );

  note({
    slug: "matched-signals",
    description: `Pattern matched on ${draft.contributing.length} signal(s): ${contributingTypes.join(", ")}.`,
    data: {
      contributing: contributingTypes,
      signalIds: draft.contributing.map((signal) => signal.id),
      requiredDeclared: draft.requiredSignals,
      optionalDeclared: draft.optionalSignals,
    },
  });

  for (const type of [...draft.requiredSignals, ...draft.optionalSignals]) {
    if (ctx.signals.has(type)) continue;
    const absence = ctx.signals.absence(type);
    const role = draft.requiredSignals.includes(type) ? "required" : "optional";
    const meaning =
      absence.kind === "no_signal"
        ? "the evaluator ran and the condition genuinely did not hold, which is positive evidence of absence"
        : absence.kind === "skipped"
          ? "the evaluator could not run for missing metrics, so this is missing information rather than evidence of absence"
          : absence.kind === "suppressed"
            ? "the evaluator produced a signal that was withheld for low data completeness, so this is missing information rather than evidence of absence"
            : "no trace entry exists for this evaluator, so its state is unknown";
    note({
      slug: `absent.${type}`,
      description: `Declared ${role} signal ${type} is absent: ${meaning}. Trace reasoning: "${absence.reason}"`,
      data: { type, role, absence: absence.kind, informative: absence.informative },
    });
  }

  for (const item of conflictNotes(contributingTypes, ctx.signals)) note(item);
  for (const item of draft.evidence ?? []) note(item);

  note({
    slug: "persistence",
    description: `Persistence classified as ${persistence.persistence}. ${persistence.reasoning} Fired on [${persistence.firedDates.join(", ") || "no prior day"}]; unknown on [${persistence.unknownDates.join(", ") || "none"}]; measurably quiet on [${persistence.notFiredDates.join(", ") || "none"}].`,
    data: {
      persistence: persistence.persistence,
      suppliedDays: persistence.suppliedDays,
      firedDates: persistence.firedDates,
      unknownDates: persistence.unknownDates,
      notFiredDates: persistence.notFiredDates,
      consecutiveDays: persistence.consecutiveDays,
      trend: persistence.trend,
      cappedByUnknown: persistence.cappedByUnknown,
    },
  });

  note({
    slug: "severity",
    description: severity.reasoning,
    data: {
      base: severity.base,
      shift: severity.shift,
      adjusted: severity.adjusted,
      severity: severity.severity,
      clamped: severity.clamped,
    },
  });

  note({
    slug: "confidence",
    description: confidence.reasoning,
    data: {
      confidence: confidence.confidence,
      deductions: confidence.deductions,
      signalCap: confidence.signalCap,
      optionalDeclared: draft.optionalSignals.length,
      optionalPresent: optionalPresent.length,
      skippedRequiredEvaluators: skippedRequired.length,
    },
  });

  const metricIds = [
    ...new Set(draft.contributing.flatMap((signal) => signal.metricIds ?? [])),
  ].sort();

  return {
    kind: "diagnosis",
    diagnosis: {
      id,
      pattern: draft.pattern,
      title: draft.title,
      summary: draft.summary,
      category: draft.category,
      severity: severity.severity,
      confidence: confidence.confidence,
      persistence: persistence.persistence,
      // Copied, not recomputed: classifyPersistence above already derived every
      // one of these. Carried as a typed field so a projection can say "third
      // day running" without reaching into the persistence evidence note's
      // untyped `data` bag to find the number.
      persistenceDetail: {
        consecutiveDays: persistence.consecutiveDays,
        priorFiredDays: persistence.firedDates.length,
        unknownDays: persistence.unknownDates.length,
        historyDaysSupplied: persistence.suppliedDays,
        cappedByUnknown: persistence.cappedByUnknown,
      },
      signalIds: draft.contributing.map((signal) => signal.id),
      metricIds,
      hypotheses,
      discriminators,
      relatedEntities: [{ type: EntityType.CLINIC, id: ctx.clinicId }],
      evidence,
      generatedAt: ctx.now,
    },
  };
}
