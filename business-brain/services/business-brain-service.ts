/**
 * Business Brain — Pipeline orchestration
 *
 * Composes the three deterministic engines into a single run for one clinic-day:
 *
 *   repository -> Metrics Engine -> Signal Engine -> Diagnosis Engine
 *
 * This file contains NO business logic. It resolves dependencies, threads one
 * `ExecutionContext` through every stage, converts each engine's `EngineResult`
 * into a recorded stage outcome, and assembles the result. Every threshold,
 * every rule and every judgement stays inside the engine that owns it.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * The only external call is `MetricsDataRepository.getClinicSnapshot`, whose
 * contract is a read. The engines are pure functions over their inputs. There
 * is no write path here — no persistence, no notifications, no task creation,
 * no automation trigger, and no LLM call. `business-brain/` imports no database
 * client at all, so this cannot change by accident.
 *
 * DETERMINISM
 * -----------
 * Given the same data, two runs produce identical metrics, signals and
 * diagnoses. The engines never read a clock: `now` comes from
 * `context.startedAt`, which the caller may inject. Only the timing fields in
 * the execution metadata vary between runs, and they are deliberately kept out
 * of the payload so a caller can compare results directly.
 */

import type { Constraint, Diagnosis, Metric, Signal, Value } from "../domain";
import type {
  Confidence,
  DecisionTrace,
  EngineError,
  ExecutionContext,
} from "../types";
import type { MetricHistoryStore, MetricsDataRepository } from "../repositories";
import { logger, type Logger } from "../utils";
import { DentGrowMetricsEngine } from "../engines/metrics";
import { deriveConstraints } from "../engines/constraint";
import { deriveValues } from "../engines/value";
import { proposeStrategies, type ReasonedStrategy } from "../engines/strategy";
import { generateWorkflows } from "../engines/workflow";
import { generateActions } from "../engines/action";
import type { ActionPlan, Workflow } from "../domain";
import { MetricKey, buildMetric } from "../engines/metrics/metric-ids";
import { DentGrowSignalEngine } from "../engines/signals";
import {
  applyEntityResolution,
  portMethodsFor,
  DentGrowDiagnosisEngine,
  addDays,
  daysBetween,
  isIsoDate,
  type DeepPartial as DiagnosisDeepPartial,
  type DiagnosisConfig,
} from "../engines/diagnosis";
import type { MetricsOnlyDay } from "../engines/diagnosis-engine";
import type { DiagnosisContextPort, EntityWindow } from "../engines/diagnosis";
import { deriveOpportunities } from "../engines/opportunity";
import { normalizeFindings, prioritizeFindings, type FindingSources } from "../engines/findings";
import { deriveRootCauses, rootCauseSubjects, DEFAULT_ROOT_CAUSE_CONFIG } from "../engines/root-cause";
import type { ClinicMemory, RootCauseAnalysis } from "../domain";
import { ClinicMemoryReader } from "../memory";
import { deriveTrajectories } from "../engines/trajectory";
import type { MetricTrajectory } from "../domain";
import type { PrioritizedFindings } from "../domain";
import { ConstraintCategory, OpportunityType, type Opportunity, type OpportunityAssessment } from "../domain";
import {
  buildLedgerGraph,
  type AppointmentWindowScope,
  type ClinicLedgerGraph,
  type ClinicLedgerPort,
  type PatientLedgerScope,
} from "../ledger";

/**
 * How far back entity context reaches, and how many rows it may return.
 *
 * A month gives cancellation timing and pending-plan ageing something to be a
 * distribution over; a single day would make every resolver fall below its
 * minimum sample. The row cap is a guard: a window with more rows than it is
 * refused by the adapter rather than answered from part of the window, which
 * leaves the discriminator undetermined. Sized for about 66 visits a day.
 */
const ENTITY_WINDOW_DAYS = 30;
const ENTITY_ROW_LIMIT = 2000;

/**
 * Opportunity reads. The forward window matches the engine's default and
 * `capacity.booked_next_7d`. The schedule limit is generous because a cut
 * appointment book is refused outright (it would overstate free time). Open work
 * is capped by patients, and a cut population is reported as a lower bound.
 */
const OPPORTUNITY_FORWARD_DAYS = 7;
const OPPORTUNITY_SCHEDULE_LIMIT = 2000;
const OPPORTUNITY_MAX_PATIENTS = 1000;
const OPPORTUNITY_ROW_LIMIT = 5000;

/**
 * Root-cause reads: the trailing appointment book (and published capacity, only
 * when an idle-capacity finding asks) over the engine's own window. A cut book is
 * refused by the engine rather than analysed, so the limit is generous.
 */
const ROOT_CAUSE_SCHEDULE_LIMIT = 5000;
import { deriveBaselines, type MetricBaseline } from "../engines/baseline";
import { deriveAchievements } from "../engines/achievement";
import type { Achievement } from "../domain";
import {
  calibrateThresholds,
  mergeOverrides,
  DEFAULT_SIGNAL_THRESHOLDS,
  type DeepPartial,
  type SignalThresholdConfig,
  type ThresholdCalibration,
} from "../engines/signals";

/**
 * Contract version of the pipeline this service runs.
 *
 * Phases completed: Metrics (3), Signal (4), Diagnosis (5), Constraint/Value/
 * Strategy/Workflow, Action (6). Bump it when the shape of a stage's output
 * changes, so a stored or cached result can be told apart from one produced by a
 * later pipeline.
 */
export const BUSINESS_BRAIN_VERSION = "0.6.0";

/** The stages a run passes through, in order. */
export const BusinessBrainStageName = {
  METRICS: "metrics",
  SIGNALS: "signals",
  DIAGNOSIS: "diagnosis",
  STRATEGY: "strategy",
  /** Prepared actions. Mechanical, advisory, and last. */
  ACTIONS: "actions",
} as const;
export type BusinessBrainStageName =
  (typeof BusinessBrainStageName)[keyof typeof BusinessBrainStageName];

/**
 * Whether a run's output may be presented as a reading of the clinic.
 *
 * `runBusinessBrain` never throws: a failed stage is recorded and the run stops
 * or degrades. That is right for auditability and wrong for presentation — a
 * metrics stage that could not read the clinic yields no metrics, no signals and
 * no findings, and a briefing drawn from that is a healthy clinic with nothing to
 * do. Every presentation, and every record of what was shown, must ask this
 * first.
 *
 * A run is healthy only when every stage executed and succeeded. Derived outputs
 * (opportunities, root causes, trajectories, memory) degrade on their own terms
 * and say so; they do not make a run unhealthy.
 */
export interface RunHealth {
  readonly healthy: boolean;
  /** Stages that did not execute or did not succeed, in pipeline order. */
  readonly failedStages: readonly BusinessBrainStageName[];
  /** The first recorded error code, when there is one. Never patient data. */
  readonly errorCode: string | null;
}

export function assessRunHealth(result: Pick<BusinessBrainResult, "ok" | "error" | "execution">): RunHealth {
  const required = Object.values(BusinessBrainStageName);
  const failedStages = required.filter((name) => {
    const stage = result.execution.stages.find((s) => s.stage === name);
    return stage === undefined || !stage.executed || !stage.ok;
  });
  return {
    healthy: result.ok && failedStages.length === 0,
    failedStages,
    errorCode: result.error?.code ?? null,
  };
}

/** What happened in one stage. Recorded whether it succeeded or not. */
export interface BusinessBrainStage {
  readonly stage: BusinessBrainStageName;
  /** False when the engine rejected its input; the run stops after this stage. */
  readonly ok: boolean;
  /** Whether the stage ran at all — false when an earlier stage failed. */
  readonly executed: boolean;
  /** Number of items produced (metrics, signals, diagnoses). */
  readonly outputCount: number;
  readonly durationMs: number;
  /** The engine's own confidence in its output, where it reports one. */
  readonly confidence?: Confidence;
  readonly error?: EngineError;
}

/** Non-deterministic metadata about a run. Never part of the compared payload. */
export interface BusinessBrainExecution {
  readonly clinicId: string;
  readonly date: string;
  readonly correlationId: string;
  /** Logical run time — the `now` every engine reasoned against. */
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly version: string;
  /** Prior days requested for persistence analysis. */
  readonly historyDaysRequested: number;
  /** Prior days actually loaded; fewer means some could not be read. */
  readonly historyDaysLoaded: number;
  /**
   * Thresholds sized from this clinic's data instead of the global defaults.
   * Empty when calibration was off or nothing could be derived. Recorded so a
   * tailored threshold is never applied silently.
   */
  readonly calibration: readonly ThresholdCalibration[];
  readonly stages: readonly BusinessBrainStage[];
}

/** The complete output of one pipeline run. */
export interface BusinessBrainResult {
  readonly clinicId: string;
  readonly date: string;
  /** True when every stage completed. Partial results are still returned. */
  readonly ok: boolean;
  readonly metrics: readonly Metric[];
  readonly signals: readonly Signal[];
  readonly diagnoses: readonly Diagnosis[];
  /** Combined decision trace from the Signal and Diagnosis engines. */
  readonly trace: readonly DecisionTrace[];
  readonly execution: BusinessBrainExecution;
  /**
   * History days this run had to RECOMPUTE because the store did not have them,
   * with the metrics it measured. Empty when history was fully stored, when no
   * store was supplied, or when no history was requested.
   *
   * Returned rather than written, so the run stays read-only: a caller decides
   * whether to record them, and can do it after the response rather than during
   * a render. Carrying the metrics costs nothing — they are already in memory —
   * and saves the caller measuring the same days a second time.
   */
  readonly recomputedHistory: readonly MetricsOnlyDay[];
  /**
   * The bottlenecks the day's diagnoses point at, worst first.
   *
   * Several diagnoses commonly describe one problem — the patterns are
   * overlapping views rather than a partition — so this is what turns six
   * findings into the two or three things actually limiting the clinic.
   */
  readonly constraints: readonly Constraint[];
  /**
   * What to do about them. The only advisory output the pipeline produces.
   *
   * A strategy is either CORRECTIVE, acting on a cause the engine settled, or
   * INVESTIGATIVE, proposing the measurement that would settle it. Nothing is
   * ever recommended against an undetermined cause.
   */
  readonly strategies: readonly ReasonedStrategy[];
  /**
   * What is measurably at stake in each bottleneck, keyed by constraint id.
   *
   * Present size, never projected gain: how much of it acting would recover is a
   * fact about the future that nothing here measures. A constraint absent from
   * this map could not be sized from the metrics available.
   */
  readonly valueAtStake: ReadonlyMap<string, readonly Value[]>;
  /**
   * Execution plans derived from the strategies. Each workflow answers: what
   * needs doing, why, who, when, how much effort, and what the expected outcome
   * is. Deterministic: same strategies always produce the same workflows.
   */
  readonly workflows: readonly Workflow[];
  /**
   * What DentGrow can prepare so each workflow takes less effort — one plan per
   * workflow, each a short ordered list of screens to open already filtered,
   * drafts to reuse, and forms to fill.
   *
   * Prepared, never performed: nothing here sends, writes or schedules anything.
   * Deterministic like every stage above it.
   */
  readonly actionPlans: readonly ActionPlan[];
  /**
   * What is NORMAL for this clinic, per metric, from its own measured history.
   *
   * A derived output rather than a pipeline stage: nothing downstream of Metrics
   * consumes it, so it changes no stage's contract. Empty when no history was
   * loaded, and a metric with too few observations is absent rather than given a
   * fabricated range.
   */
  readonly baselines: readonly MetricBaseline[];
  /**
   * Measured improvements against this clinic's own normal — the positive
   * reading of the same evidence, and a sibling of {@link constraints} rather
   * than a stage after them.
   *
   * Capped at three by the Achievement Engine. Empty is the common and correct
   * answer: a clinic running inside its usual range has no wins to report, and
   * saying so anyway would be the praise this layer refuses to invent.
   */
  readonly achievements: readonly Achievement[];
  /**
   * The metric set from an earlier day, for callers that want to show a movement
   * rather than a level — a score delta, for instance.
   *
   * Absent when history does not reach back far enough. Supplied from the history
   * this run already loaded, so a caller never pays for a second read, and never
   * needs its own notion of which day to compare against.
   */
  readonly comparison?: BusinessBrainComparison;
  /**
   * Measured surplus paired with measured demand, from the clinic ledger.
   *
   * Empty unless the run was asked for opportunities (`options.opportunities`)
   * AND has a ledger port. A derived output, not a stage: nothing downstream
   * consumes it, and a ledger failure costs the dentist nothing but this list.
   */
  readonly opportunities: readonly Opportunity[];
  /**
   * Why each opportunity type was or was not emitted. Empty when opportunities
   * were not requested; `insufficient_data` for every type when they were
   * requested and could not be measured — never an empty list that reads as
   * "nothing to act on".
   */
  readonly opportunityAssessments: readonly OpportunityAssessment[];
  /**
   * Every producer's output — constraints, opportunities, achievements — as one
   * prioritised list: the single most important finding, the next few, what
   * supports them, the wins, and what needs no action. Each placement carries its
   * measured reason. Computed from this result alone, so it adds no read and can
   * never disagree with the objects it normalises.
   */
  readonly findings: PrioritizedFindings;
  /**
   * How each tracked metric has been moving over the history this run already
   * loaded — no additional read. One per catalogued metric, insufficient ones
   * included, so "could not judge" is visible rather than absent. Empty when no
   * history was requested, since there is then nothing to be a trajectory of.
   */
  readonly trajectories: readonly MetricTrajectory[];
  /**
   * Where each explainable finding is concentrated in the ledger — or why that
   * could not be said. Also attached to the findings they belong to. Empty unless
   * the run asked (`options.rootCauses`) and at least one finding qualified.
   */
  readonly rootCauses: readonly RootCauseAnalysis[];
  /** Set when a stage rejected its input; identifies the first failure. */
  readonly error?: EngineError;
}

/** An earlier measured day, offered as the comparison point for a movement. */
export interface BusinessBrainComparison {
  /** Business date the metrics describe. */
  readonly date: string;
  /** Whole days between that date and the run date. */
  readonly daysAgo: number;
  readonly metrics: readonly Metric[];
  /**
   * Baselines positioned for THAT day, not for today.
   *
   * Supplied because a caller comparing two scores has to compute both sides the
   * same way, and a score that reads baselines would otherwise judge the earlier
   * day against today's readings — giving the earlier day today's credits, which
   * makes the "previous score" it reports simply untrue.
   *
   * The medians come from the same history; only the current value and therefore
   * the band position differ. The comparison day is excluded from its own history
   * for the same reason today is excluded from today's: a day folded into the
   * band it is judged against is being compared with itself.
   */
  readonly baselines: readonly MetricBaseline[];
}

/** Construction dependencies. The repository is the only external collaborator. */
export interface BusinessBrainDependencies {
  readonly repository: MetricsDataRepository;
  /**
   * Where measured metrics are stored and read back from.
   *
   * OPTIONAL. Without it the run still works — history is recomputed from the
   * live database exactly as before — so no caller is forced to provide storage
   * to get a result. With it, days already measured are read rather than
   * recomputed, which is both faster and more faithful: a measurement recorded
   * on the day needs no reconstruction, and reconstruction cannot recover facts
   * the schema does not version.
   */
  readonly historyStore?: MetricHistoryStore;
  /**
   * Entity-level context for resolving discriminators.
   *
   * OPTIONAL. Without it the run behaves exactly as before: the matchers still
   * attach discriminators, and the hypotheses they would separate stay
   * `undetermined` — which is the correct answer when the measurement was never
   * taken. With it, the measurements the schema can supply are taken, and the
   * hypotheses they settle are settled.
   */
  readonly contextPort?: DiagnosisContextPort;
  /**
   * Relational access to the clinic's ledgers.
   *
   * OPTIONAL, and a strict superset of `contextPort`: a ledger port also serves
   * the Diagnosis Engine's entity questions, so supplying one is enough. When
   * both are given, `contextPort` wins for diagnosis — an explicit narrower port
   * is a deliberate choice and must not be silently replaced.
   *
   * Nothing in the daily run reads the ledger yet. It is exposed through
   * {@link BusinessBrain.readPatientLedger} and
   * {@link BusinessBrain.readAppointmentWindow} so an intelligence feature can
   * walk entities without another flattened metric.
   */
  readonly ledgerPort?: ClinicLedgerPort;
  readonly logger?: Logger;
  /** Threshold overrides forwarded to the Signal Engine. */
  readonly signalConfig?: DeepPartial<SignalThresholdConfig>;
  /** Configuration overrides forwarded to the Diagnosis Engine. */
  readonly diagnosisConfig?: DiagnosisDeepPartial<DiagnosisConfig>;
  /**
   * Monotonic millisecond source for stage timing. Injectable so tests can make
   * timing deterministic; it never influences engine output.
   */
  readonly clock?: () => number;
}

/** Per-run options. */
export interface RunBusinessBrainOptions {
  /** Ties every stage's logs together. Generated when omitted. */
  readonly correlationId?: string;
  /**
   * Logical run time (ISO-8601) used as `now` by the Signal and Diagnosis
   * engines. Inject it to make a run exactly reproducible.
   */
  readonly startedAt?: string;
  /**
   * How many prior days to load as metrics-only history, so the Diagnosis
   * Engine can classify persistence (is this transient, sustained, worsening?).
   *
   * Defaults to 0 — a single day. With no history every diagnosis is correctly
   * reported as `insufficient_history`. The Diagnosis Engine's
   * `minimumHistoryDays` is 3, so 7 is a sensible production value.
   */
  readonly historyDays?: number;
  /**
   * Most missing history days this run may RECOMPUTE from the live database.
   *
   * Unlimited when omitted, which is the behaviour every existing caller had.
   * It exists because `historyDays` and the cost of `historyDays` are not the
   * same thing: a day already in the store is one row of a range read, while a
   * day the store lacks is a full clinic snapshot. Asking for five weeks of
   * history against a cold store therefore means five weeks of snapshots on a
   * page render.
   *
   * When the cap bites, the NEWEST missing days are recomputed and older ones are
   * left out entirely. That ordering is deliberate: persistence reasons over the
   * recent consecutive run, and dropping the oldest days keeps the supplied
   * window contiguous at the end that matters instead of punching a hole in it.
   * Baselines tolerate the sparser history honestly — that is what
   * `baselineQuality` is for — and the store fills in behind the run.
   */
  readonly maxRecomputedHistoryDays?: number;
  /**
   * Size clinic-dependent thresholds from this clinic's own measured facts
   * rather than the global defaults. Defaults to true.
   *
   * Off means every clinic is judged against the same constants, which is what
   * produces daily false alarms at a small clinic and silence at a large one.
   */
  readonly calibrateThresholds?: boolean;
  /**
   * Detect opportunities, as of `now`.
   *
   * Opt-in because an opportunity is about the time still ahead: it is only
   * meaningful for a run describing TODAY, and only the caller knows that the
   * date it passed is today. History runs, back-fills and tests leave it unset
   * and get exactly the result they always did.
   */
  readonly opportunities?: { readonly now: string };
  /**
   * Investigate where this run's problems are concentrated, as of `now`, reading
   * clinic-local days and sessions in `timezone`.
   *
   * Opt-in, and reads only when a finding qualifies: one bounded appointment
   * window over the trailing month, plus published capacity when an idle-capacity
   * finding asks. A run with nothing to explain reads nothing.
   */
  readonly rootCauses?: { readonly now: string; readonly timezone: string };
  /**
   * This clinic's most recent memory build, read by the caller in one bounded
   * read. Explanations may cite it; no ranking factor reads it. A build for
   * another clinic is refused.
   */
  readonly memory?: ClinicMemory | null;
  readonly requestedBy?: string;
  readonly role?: string;
}

function stage(
  name: BusinessBrainStageName,
  fields: Partial<BusinessBrainStage> = {},
): BusinessBrainStage {
  return {
    stage: name,
    ok: false,
    executed: false,
    outputCount: 0,
    durationMs: 0,
    ...fields,
  };
}

/**
 * Runs the deterministic Business Brain pipeline for a clinic-day.
 *
 * Construct once with a repository, then call {@link runBusinessBrain} per
 * clinic-day. The service holds no per-run state.
 */
export class BusinessBrain {
  private readonly repository: MetricsDataRepository;
  private readonly historyStore?: MetricHistoryStore;
  private readonly contextPort?: DiagnosisContextPort;
  private readonly ledgerPort?: ClinicLedgerPort;
  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly metricsEngine: DentGrowMetricsEngine;
  private readonly signalConfig?: DeepPartial<SignalThresholdConfig>;
  private readonly diagnosisEngine: DentGrowDiagnosisEngine;

  constructor(deps: BusinessBrainDependencies) {
    this.repository = deps.repository;
    this.historyStore = deps.historyStore;
    this.contextPort = deps.contextPort ?? deps.ledgerPort;
    this.ledgerPort = deps.ledgerPort;
    this.log = deps.logger ?? logger;
    this.clock = deps.clock ?? (() => Date.now());
    this.metricsEngine = new DentGrowMetricsEngine(deps.repository, { logger: this.log });
    // The Signal Engine is built per run: its thresholds may be sized from the
    // metrics of the clinic-day being analysed, which are not known until then.
    this.signalConfig = deps.signalConfig;
    this.diagnosisEngine = new DentGrowDiagnosisEngine({
      logger: this.log,
      config: deps.diagnosisConfig,
    });
  }

  /**
   * Execute the full pipeline for one clinic-day.
   *
   * Never throws for a stage failure: a rejected stage is recorded, the run
   * stops there, and everything already produced is still returned. A caller
   * rendering a dashboard can show the metrics it has even when diagnosis could
   * not run.
   */
  async runBusinessBrain(
    clinicId: string,
    date: string,
    options: RunBusinessBrainOptions = {},
  ): Promise<BusinessBrainResult> {
    const startedAtMs = this.clock();
    const startedAt = options.startedAt ?? new Date(startedAtMs).toISOString();
    const correlationId = options.correlationId ?? `bb_${clinicId}_${date}_${startedAtMs}`;
    const historyDays = Math.max(0, options.historyDays ?? 0);

    const context: ExecutionContext = {
      clinicId,
      correlationId,
      startedAt,
      requestedBy: options.requestedBy,
      role: options.role,
    };

    const stages: BusinessBrainStage[] = [];
    // History days this run had to measure itself. Local to the run: the service
    // deliberately holds no per-run state, so two concurrent runs cannot mix.
    let recomputedHistory: readonly MetricsOnlyDay[] = [];
    let constraints: readonly Constraint[] = [];
    let strategies: readonly ReasonedStrategy[] = [];
    let workflows: readonly Workflow[] = [];
    let actionPlans: readonly ActionPlan[] = [];
    let valueAtStake: ReadonlyMap<string, readonly Value[]> = new Map();
    // Derived outputs, not stages: computed from the metrics and the history this
    // run already has, and consumed by nothing downstream.
    let baselines: readonly MetricBaseline[] = [];
    let achievements: readonly Achievement[] = [];
    // Assigned once, below — but read by `finish`, which the failure paths call
    // before that line runs, so it cannot be a const.
    // eslint-disable-next-line prefer-const
    let comparison: BusinessBrainComparison | undefined;
    let trajectories: readonly MetricTrajectory[] = [];
    let opportunities: readonly Opportunity[] = [];
    let opportunityAssessments: readonly OpportunityAssessment[] = [];
    let rootCauses: readonly RootCauseAnalysis[] = [];
    // Memory is supporting evidence: one that fails its tenant check is refused and
    // logged, and the run continues without it rather than failing.
    let memoryReader: ClinicMemoryReader | undefined;
    if (options.memory !== undefined) {
      try {
        memoryReader = ClinicMemoryReader.for(clinicId, options.memory);
      } catch (error) {
        this.log.warn("Business Brain refused a clinic memory", {
          clinicId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const finish = (
      fields: Pick<BusinessBrainResult, "metrics" | "signals" | "diagnoses" | "trace"> & {
        error?: EngineError;
        historyDaysLoaded: number;
        calibration?: readonly ThresholdCalibration[];
      },
    ): BusinessBrainResult => {
      const completedMs = this.clock();
      const findings = prioritizeFindings({
        sources: {
          clinicId,
          date,
          constraints,
          diagnoses: fields.diagnoses,
          valueAtStake,
          workflows,
          actionPlans,
          opportunities,
          achievements,
          trajectories,
          rootCauses,
          ...(memoryReader === undefined ? {} : { memory: memoryReader }),
        },
        // The run's logical moment, so the same run always ranks the same way.
        now: startedAt,
        opportunityAssessments,
      });
      return {
        clinicId,
        date,
        ok: fields.error === undefined,
        metrics: fields.metrics,
        signals: fields.signals,
        diagnoses: fields.diagnoses,
        trace: fields.trace,
        error: fields.error,
        recomputedHistory,
        baselines,
        achievements,
        comparison,
        opportunities,
        opportunityAssessments,
        findings,
        trajectories,
        rootCauses,
        constraints,
        strategies,
        valueAtStake,
        workflows,
        actionPlans,
        execution: {
          clinicId,
          date,
          correlationId,
          startedAt,
          completedAt: new Date(completedMs).toISOString(),
          durationMs: completedMs - startedAtMs,
          version: BUSINESS_BRAIN_VERSION,
          historyDaysRequested: historyDays,
          historyDaysLoaded: fields.historyDaysLoaded,
          calibration: fields.calibration ?? [],
          stages,
        },
      };
    };

    // Reject a malformed date here rather than letting three engines each
    // discover it separately.
    if (!isIsoDate(date)) {
      const error: EngineError = {
        code: "BUSINESS_BRAIN_INVALID_DATE",
        message: `Not a valid calendar date: "${date}".`,
      };
      stages.push(stage(BusinessBrainStageName.METRICS, { error }));
      stages.push(stage(BusinessBrainStageName.SIGNALS));
      stages.push(stage(BusinessBrainStageName.DIAGNOSIS));
      return finish({ metrics: [], signals: [], diagnoses: [], trace: [], error, historyDaysLoaded: 0 });
    }

    // ── Stage 1: Metrics ─────────────────────────────────────────────────────
    const metricsStart = this.clock();
    const metricsResult = await this.metricsEngine.execute({ date }, context);
    stages.push(
      stage(BusinessBrainStageName.METRICS, {
        ok: metricsResult.ok,
        executed: true,
        outputCount: metricsResult.data?.length ?? 0,
        durationMs: this.clock() - metricsStart,
        confidence: metricsResult.confidence,
        error: metricsResult.error,
      }),
    );

    if (!metricsResult.ok || !metricsResult.data) {
      stages.push(stage(BusinessBrainStageName.SIGNALS));
      stages.push(stage(BusinessBrainStageName.DIAGNOSIS));
      return finish({
        metrics: [],
        signals: [],
        diagnoses: [],
        trace: [],
        error: metricsResult.error,
        historyDaysLoaded: 0,
      });
    }
    const metrics = metricsResult.data;

    // History is optional context for persistence classification. A day that
    // cannot be read is skipped rather than failing the run — the Diagnosis
    // Engine treats a gap as `unknown`, which is the correct outcome.
    const loadedHistory =
      historyDays > 0
        ? await this.loadHistory(
            clinicId,
            date,
            historyDays,
            options.maxRecomputedHistoryDays,
          )
        : { days: [] as MetricsOnlyDay[], recomputed: [] as MetricsOnlyDay[] };
    const history = loadedHistory.days;
    recomputedHistory = loadedHistory.recomputed;

    // ── Derived: baselines, achievements, comparison ──────────────────────────
    //
    // Placed here rather than at the end because everything below can fail, and a
    // clinic whose signal run breaks should still be told what is normal for it
    // and what has improved. None of the three is read by any stage that follows,
    // which is what makes them derived outputs rather than a new stage.
    //
    // `history` deliberately excludes `date` itself, so today is never folded
    // into the band it is being judged against.
    const baselineResult = deriveBaselines({ history, current: metrics });
    baselines = baselineResult.baselines;
    achievements = deriveAchievements({
      baselines: baselineResult.byKey,
      clinicId,
      date,
      now: startedAt,
    }).achievements;
    comparison = pickComparisonDay(history, date, baselineResult.baselines.length > 0);

    // Trajectories from the same history — no read of their own. Guarded because a
    // derived output must never cost the run: a history that fails the engine's
    // tenant check yields no trajectories, and the refusal is logged.
    if (historyDays > 0) {
      try {
        trajectories = deriveTrajectories({ clinicId, date, current: metrics, history }).trajectories;
      } catch (error) {
        this.log.warn("Business Brain could not derive trajectories", {
          clinicId,
          date,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ── Stage 2: Signals ─────────────────────────────────────────────────────
    // Thresholds are sized from this clinic's own facts before evaluation. An
    // explicitly supplied config still wins: a deliberate override must not be
    // silently replaced by an automatic one.
    const calibration =
      options.calibrateThresholds === false
        ? { overrides: {}, applied: [] as readonly ThresholdCalibration[] }
        : calibrateThresholds(metrics);

    const signalEngine = new DentGrowSignalEngine({
      logger: this.log,
      config: this.signalConfig
        ? mergeOverrides(
            mergeOverrides(DEFAULT_SIGNAL_THRESHOLDS, calibration.overrides),
            this.signalConfig,
          )
        : calibration.overrides,
    });

    const signalsStart = this.clock();
    // Immediately-prior day's metrics, if history covers it, so the trend
    // evaluators (returning-volume-dropping, outstanding-increasing,
    // queue-building-up) can run in production instead of skipping for "no prior
    // period". Matched by exact date — `days` is gap-filtered, so a missing
    // yesterday must stay undefined rather than silently shift to an older day.
    const previousDay = history.find((d) => d.date === addDays(date, -1));
    const signalResult = signalEngine.run(
      { metrics, date, previousMetrics: previousDay?.metrics },
      context,
    );
    stages.push(
      stage(BusinessBrainStageName.SIGNALS, {
        ok: signalResult.ok,
        executed: true,
        outputCount: signalResult.data?.length ?? 0,
        durationMs: this.clock() - signalsStart,
        confidence: signalResult.confidence,
        error: signalResult.error,
      }),
    );

    const signalTrace = signalResult.trace ?? [];
    if (!signalResult.ok || !signalResult.data) {
      stages.push(stage(BusinessBrainStageName.DIAGNOSIS));
      return finish({
        metrics,
        signals: [],
        diagnoses: [],
        trace: signalTrace,
        error: signalResult.error,
        historyDaysLoaded: history.length,
        calibration: calibration.applied,
      });
    }
    const signals = signalResult.data;

    // ── Stage 3: Diagnosis ───────────────────────────────────────────────────
    // The Signal Engine's trace is passed through deliberately: without it the
    // Diagnosis Engine cannot tell a signal that measured nothing from one that
    // could not run, and those two absences lead to different diagnoses.
    const diagnosisStart = this.clock();
    const diagnosisResult = this.diagnosisEngine.run(
      {
        current: { date, signals, metrics, trace: signalTrace },
        historyMetricsOnly: history,
      },
      context,
    );
    stages.push(
      stage(BusinessBrainStageName.DIAGNOSIS, {
        ok: diagnosisResult.ok,
        executed: true,
        outputCount: diagnosisResult.data?.length ?? 0,
        durationMs: this.clock() - diagnosisStart,
        confidence: diagnosisResult.confidence,
        error: diagnosisResult.error,
      }),
    );

    // ── Stage 4: Entity-level resolution ─────────────────────────────────────
    // The matchers have said which measurements would separate their competing
    // explanations. Where the schema can supply one, take it.
    //
    // Fetching happens HERE and not in the engine: the resolvers are pure by
    // design, and the eslint boundary over engines/diagnosis/** forbids them a
    // database client. Only the methods this run's discriminators actually name
    // are fetched, so a run that raises no cancellation question pays for no
    // cancellation query — and a run with no diagnoses touches nothing.
    const diagnosed = diagnosisResult.data ?? [];
    const resolved = await this.resolveEntityContext(clinicId, date, diagnosed, startedAt);

    // ── Stage 5: Constraints and strategy ────────────────────────────────────
    // The first point in the pipeline where anything is recommended. Kept behind
    // the same failure isolation as every other stage: a throw here costs the
    // advice, not the findings the dentist came for.
    const strategyStart = this.clock();
    let strategyOk = true;
    try {
      constraints = deriveConstraints(resolved, clinicId, date, startedAt).constraints;
      // Sizes each bottleneck from metrics already computed, so strategies of
      // equal urgency are ordered by how much is actually sitting in them.
      const valued = deriveValues(constraints, metrics, startedAt);
      valueAtStake = valued.byConstraint;
      strategies = proposeStrategies(
        constraints,
        resolved,
        clinicId,
        date,
        startedAt,
        valued.byConstraint,
      ).strategies;
      // Workflows are the execution plans derived from strategies.
      workflows = generateWorkflows(
        strategies,
        constraints,
        clinicId,
        date,
        startedAt,
      ).workflows;
    } catch (error) {
      strategyOk = false;
      this.log.warn("Business Brain could not derive strategy; findings are unaffected", {
        clinicId,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stages.push(
      stage(BusinessBrainStageName.STRATEGY, {
        ok: strategyOk,
        executed: true,
        outputCount: strategies.length,
        durationMs: this.clock() - strategyStart,
      }),
    );

    // ── Stage 6: Actions ─────────────────────────────────────────────────────
    // Purely mechanical: workflow template key → prepared screens, filters and
    // drafts. Isolated in its own stage so a fault in the last, least important
    // stage cannot cost the workflows a dentist can follow perfectly well by
    // hand — and so the run details show whether it ran at all.
    const actionsStart = this.clock();
    let actionsOk = true;
    try {
      actionPlans = generateActions(workflows, clinicId, date, startedAt).plans;
    } catch (error) {
      actionsOk = false;
      this.log.warn("Business Brain could not prepare actions; workflows are unaffected", {
        clinicId,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stages.push(
      stage(BusinessBrainStageName.ACTIONS, {
        ok: actionsOk,
        executed: true,
        outputCount: actionPlans.length,
        durationMs: this.clock() - actionsStart,
      }),
    );

    // ── Derived: opportunities ───────────────────────────────────────────────
    if (options.opportunities !== undefined) {
      const detected = await this.detectOpportunities(
        clinicId,
        date,
        options.opportunities.now,
        constraints,
      );
      opportunities = detected.opportunities;
      opportunityAssessments = detected.assessments;
    }

    // ── Derived: root causes ─────────────────────────────────────────────────
    if (options.rootCauses !== undefined) {
      rootCauses = await this.explainFindings(clinicId, date, options.rootCauses, {
        clinicId,
        date,
        constraints,
        diagnoses: resolved,
        valueAtStake,
        workflows,
        actionPlans,
        opportunities,
        achievements,
        trajectories,
      });
    }

    const trace = [...signalTrace, ...(diagnosisResult.trace ?? [])];
    return finish({
      metrics,
      signals,
      diagnoses: resolved,
      trace,
      error: diagnosisResult.error,
      historyDaysLoaded: history.length,
      calibration: calibration.applied,
    });
  }

  /**
   * Load the `days` calendar days immediately before `date` as metrics-only
   * history, ascending.
   *
   * Stored measurements are preferred over recomputation, for two reasons. They
   * are far cheaper — recomputing a week means a week of full clinic snapshots
   * on every dashboard load — and they are more faithful, because a value
   * recorded on the day it was measured cannot be distorted by anything that
   * happened since. Recomputation can only approximate whatever the schema does
   * not version.
   *
   * Days the store does not have are computed, so history is never simply
   * missing because the job has not run yet. A day that can be neither read nor
   * computed is omitted and logged; the Diagnosis Engine reconstructs the gap as
   * `unknown` rather than assuming a quiet day.
   */
  private async loadHistory(
    clinicId: string,
    date: string,
    days: number,
    maxRecomputed?: number,
  ): Promise<{ days: MetricsOnlyDay[]; recomputed: MetricsOnlyDay[] }> {
    const wanted: string[] = [];
    for (let offset = days; offset >= 1; offset -= 1) {
      wanted.push(addDays(date, -offset));
    }

    const stored = await this.readStoredHistory(clinicId, wanted);

    // Which of the missing days this run is allowed to measure itself.
    //
    // A stored day costs one row of a range read; a missing day costs a full
    // clinic snapshot. Without a cap, asking for five weeks of history against a
    // cold store means five weeks of snapshots on a page render.
    //
    // NEWEST missing days win, which is why this reverses before slicing:
    // persistence reasons over the recent consecutive run, so keeping the recent
    // end intact and dropping the oldest days leaves the supplied window
    // contiguous where it matters rather than punching a hole in it.
    const missing = wanted.filter((day) => !stored.has(day));
    const recomputable = new Set(
      maxRecomputed === undefined
        ? missing
        : [...missing].reverse().slice(0, Math.max(0, maxRecomputed)),
    );
    if (missing.length > recomputable.size) {
      this.log.info("Business Brain skipped recomputing older history days", {
        clinicId,
        date,
        missing: missing.length,
        recomputing: recomputable.size,
      });
    }

    const recomputed: MetricsOnlyDay[] = [];

    const loaded = await Promise.all(
      wanted.map(async (day): Promise<MetricsOnlyDay | null> => {
        const fromStore = stored.get(day);
        if (fromStore !== undefined) return fromStore;
        // Over the cap: left out entirely rather than measured. Absent is already
        // a first-class state everywhere downstream — the persistence window
        // treats an unsupplied day as unknown, never as a healthy one.
        if (!recomputable.has(day)) return null;
        try {
          // The knowledge the day was measured with travels with it, so a caller
          // storing it can say whether it was read as of that day or as of now.
          const { metrics, knowledge, timezone } = await this.metricsEngine.measureDay(clinicId, day);
          const measured: MetricsOnlyDay = {
            date: day,
            metrics,
            ...(knowledge === undefined ? {} : { knowledge }),
            ...(timezone === undefined ? {} : { timezone }),
          };
          recomputed.push(measured);
          return measured;
        } catch (error) {
          this.log.warn("Business Brain could not load a history day; treating it as unknown", {
            clinicId,
            date: day,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );

    return {
      days: loaded.filter((day): day is MetricsOnlyDay => day !== null),
      // Ascending, so a caller writing them back does so in calendar order.
      recomputed: recomputed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    };
  }

  /**
   * Read the three ledger views the Opportunity Engine pairs, and run it.
   *
   * Never fatal, and never silent: without a ledger port, or when a read fails,
   * every type is assessed `insufficient_data` with the reason — so a caller can
   * never mistake "could not look" for "nothing to act on".
   */
  private async detectOpportunities(
    clinicId: string,
    date: string,
    now: string,
    constraints: readonly Constraint[],
  ): Promise<{ opportunities: readonly Opportunity[]; assessments: readonly OpportunityAssessment[] }> {
    const unmeasured = (reason: string) => ({
      opportunities: [],
      assessments: Object.values(OpportunityType).map((type) => ({
        type,
        outcome: "insufficient_data" as const,
        reason,
        detected: 0,
      })),
    });
    const port = this.ledgerPort;
    if (port === undefined) return unmeasured("No clinic ledger is available to this run.");

    try {
      const to = addDays(date, OPPORTUNITY_FORWARD_DAYS);
      const [capacity, schedule, openWork] = await Promise.all([
        port.readCapacityWindow({ clinicId, from: date, to }),
        port.readAppointmentWindow({
          kind: "appointment_window",
          clinicId,
          from: date,
          to,
          asOf: now,
          limit: OPPORTUNITY_SCHEDULE_LIMIT,
        }),
        port.readOpenWorkLedger({
          clinicId,
          asOf: now,
          maxPatients: OPPORTUNITY_MAX_PATIENTS,
          limit: OPPORTUNITY_ROW_LIMIT,
        }),
      ]);
      return deriveOpportunities({
        clinicId,
        date,
        now,
        capacity,
        schedule: buildLedgerGraph(schedule),
        openWork: buildLedgerGraph(openWork),
        constraints,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn("Business Brain could not measure opportunities", { clinicId, date, error: message });
      return unmeasured("The clinic ledger could not be read for this run.");
    }
  }

  /**
   * Investigate where this run's explainable findings are concentrated.
   *
   * The subjects come from the same normalisation the prioritiser runs, so every
   * analysis names a finding that will exist. Nothing is read when no finding
   * qualifies. Never fatal, and never silent: without a ledger, or when a read
   * fails, each subject is still answered — "insufficient evidence to explain",
   * with the reason — rather than left without an analysis.
   */
  private async explainFindings(
    clinicId: string,
    date: string,
    request: { readonly now: string; readonly timezone: string },
    sources: FindingSources,
  ): Promise<readonly RootCauseAnalysis[]> {
    try {
      const subjects = rootCauseSubjects(normalizeFindings(sources));
      if (subjects.length === 0) return [];
      const base = { clinicId, date, now: request.now, timezone: request.timezone, subjects };
      const port = this.ledgerPort;
      if (port === undefined) {
        return deriveRootCauses({ ...base, schedule: null, capacity: null, unavailableReason: "no clinic ledger is available to this run" });
      }
      const from = addDays(date, -(DEFAULT_ROOT_CAUSE_CONFIG.windowDays - 1));
      try {
        const [schedule, capacity] = await Promise.all([
          port.readAppointmentWindow({
            kind: "appointment_window",
            clinicId,
            from,
            to: date,
            asOf: request.now,
            limit: ROOT_CAUSE_SCHEDULE_LIMIT,
          }),
          subjects.some((s) => s.category === ConstraintCategory.CAPACITY)
            ? port.readCapacityWindow({ clinicId, from, to: date })
            : Promise.resolve(null),
        ]);
        return deriveRootCauses({ ...base, schedule: buildLedgerGraph(schedule), capacity });
      } catch (error) {
        this.log.warn("Business Brain could not read the ledger for root causes", {
          clinicId,
          date,
          error: error instanceof Error ? error.message : String(error),
        });
        return deriveRootCauses({ ...base, schedule: null, capacity: null, unavailableReason: "the clinic ledger could not be read for this run" });
      }
    } catch (error) {
      this.log.warn("Business Brain could not derive root causes", {
        clinicId,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Read a bounded set of patients' complete relational history and index it.
   *
   * Returns `null` when no ledger port was supplied — "this deployment cannot
   * answer", never an empty graph that would read as "these patients have no
   * history". A failed read throws: unlike entity context inside a run, a
   * caller asking for the ledger directly needs to know it did not get one.
   */
  async readPatientLedger(scope: PatientLedgerScope): Promise<ClinicLedgerGraph | null> {
    if (this.ledgerPort === undefined) return null;
    return buildLedgerGraph(await this.ledgerPort.readPatientLedger(scope));
  }

  /**
   * Read the appointments scheduled in a clinic-local window, with everything
   * attached to them, and index them. `null` without a ledger port, as above.
   */
  async readAppointmentWindow(scope: AppointmentWindowScope): Promise<ClinicLedgerGraph | null> {
    if (this.ledgerPort === undefined) return null;
    return buildLedgerGraph(await this.ledgerPort.readAppointmentWindow(scope));
  }

  /**
   * Take the entity-level measurements this run's discriminators call for, and
   * fold them into the diagnoses.
   *
   * Never fatal. Entity context is an enrichment: without it the hypotheses stay
   * `undetermined`, which is exactly what they were before this stage existed
   * and a correct answer in its own right. A failed fetch must not cost a
   * dentist the diagnosis the matchers already produced.
   */
  private async resolveEntityContext(
    clinicId: string,
    date: string,
    diagnoses: readonly Diagnosis[],
    now: string,
  ): Promise<readonly Diagnosis[]> {
    const port = this.contextPort;
    if (port === undefined || diagnoses.length === 0) return diagnoses;

    const wanted = portMethodsFor(diagnoses);
    if (wanted.length === 0) return diagnoses;

    const window: EntityWindow = {
      clinicId,
      from: addDays(date, -(ENTITY_WINDOW_DAYS - 1)),
      to: date,
      limit: ENTITY_ROW_LIMIT,
    };

    try {
      // Each method is fetched independently and a failure in one is recorded as
      // "could not answer" rather than failing the rest: partial context yields
      // fewer conclusions, which is the honest degradation.
      const ask = async <T>(
        name: string,
        fetch: () => Promise<readonly T[] | null>,
      ): Promise<readonly T[] | null | undefined> => {
        if (!wanted.includes(name)) return undefined;
        try {
          return await fetch();
        } catch (error) {
          this.log.warn("Business Brain could not read entity context", {
            clinicId,
            date,
            method: name,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };

      const [
        cancellationEvents,
        noShowHistory,
        pendingTreatments,
        outstandingBalances,
        appointmentArrivals,
        completedTreatments,
      ] = await Promise.all([
        ask("listCancellationEvents", () => port.listCancellationEvents(window)),
        ask("listNoShowHistory", () => port.listNoShowHistory(window)),
        ask("listPendingTreatments", () => port.listPendingTreatments(window)),
        ask("listOutstandingBalances", () => port.listOutstandingBalances(window)),
        ask("listAppointmentArrivals", () => port.listAppointmentArrivals(window)),
        ask("listCompletedTreatments", () => port.listCompletedTreatments(window)),
      ]);

      return applyEntityResolution(
        diagnoses,
        {
          cancellationEvents,
          noShowHistory,
          pendingTreatments,
          outstandingBalances,
          appointmentArrivals,
          completedTreatments,
        },
        now,
      );
    } catch (error) {
      this.log.warn("Business Brain could not resolve entity context; leaving hypotheses open", {
        clinicId,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
      return diagnoses;
    }
  }

  /**
   * Stored history for the wanted days, keyed by date.
   *
   * A store failure is not a run failure: it degrades to recomputation, which is
   * exactly what happened before a store existed. Losing the cache must never
   * cost a dentist their dashboard.
   *
   * A stored day with no metrics is DISCARDED rather than returned, so it falls
   * through to recomputation. An empty day is indistinguishable from "everything
   * measured zero", which would invent a quiet day the clinic never had.
   */
  private async readStoredHistory(
    clinicId: string,
    wanted: readonly string[],
  ): Promise<Map<string, MetricsOnlyDay>> {
    const byDate = new Map<string, MetricsOnlyDay>();
    if (this.historyStore === undefined || wanted.length === 0) return byDate;

    try {
      const days = await this.historyStore.readMetricDays(
        clinicId,
        wanted[0],
        wanted[wanted.length - 1],
      );
      for (const day of days) {
        if (day.metrics.length === 0) continue;
        byDate.set(day.date, {
          date: day.date,
          metrics: day.metrics.map((m) =>
            buildMetric(m.key as MetricKey, m.value, clinicId, day.date, m.measuredAt),
          ),
        });
      }
    } catch (error) {
      this.log.warn("Business Brain could not read stored history; recomputing instead", {
        clinicId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return byDate;
  }

  /**
   * Record a day's measurements so future runs read them instead of
   * reconstructing them.
   *
   * Best-effort and deliberately non-fatal: persistence is an optimisation and
   * an accuracy improvement, never a precondition for answering. A failed write
   * costs the next run some time, not its result.
   */
  async persistMetrics(clinicId: string, date: string, metrics: readonly Metric[]): Promise<void> {
    if (this.historyStore === undefined || metrics.length === 0) return;
    try {
      await this.historyStore.writeMetricDay(clinicId, {
        date,
        metrics: metrics.map((m) => ({
          // Metric ids are `key:clinicId:date`, and the key itself contains a
          // dot but never a colon — so the first segment is the key.
          key: m.id.slice(0, m.id.indexOf(":")),
          value: m.value,
          measuredAt: m.timestamp,
        })),
      });
    } catch (error) {
      this.log.warn("Business Brain could not persist metrics", {
        clinicId,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * How far back a "since last week" comparison looks, and how far it may stretch
 * when that exact day was never measured.
 *
 * Seven days, because a week is the shortest honest comparison for a clinic: a
 * day-over-day reading swings on which weekday it is, and dentistry's weekdays
 * are not interchangeable. The tolerance exists because a clinic closed on the
 * matching day has no measurement for it, and refusing to compare at all would
 * be worse than comparing against the nearest week-ish day and saying which.
 */
const COMPARISON_TARGET_DAYS = 7;
const COMPARISON_MIN_DAYS = 4;
const COMPARISON_MAX_DAYS = 10;

/**
 * Choose the day a movement is measured against.
 *
 * Prefers exactly a week back; otherwise the measured day closest to it inside
 * the tolerance, breaking ties toward the OLDER day so the comparison never
 * quietly shortens into a day-over-day reading.
 *
 * Returns undefined when history does not reach back far enough — the caller
 * then shows a level with no movement, which is the honest output for a clinic
 * that has not been running long enough to have a last week.
 */
function pickComparisonDay(
  history: readonly MetricsOnlyDay[],
  date: string,
  withBaselines: boolean,
): BusinessBrainComparison | undefined {
  let best: { day: MetricsOnlyDay; daysAgo: number } | undefined;
  for (const day of history) {
    if (day.metrics.length === 0) continue;
    const daysAgo = daysBetween(day.date, date);
    if (daysAgo < COMPARISON_MIN_DAYS || daysAgo > COMPARISON_MAX_DAYS) continue;

    const distance = Math.abs(daysAgo - COMPARISON_TARGET_DAYS);
    if (best === undefined) {
      best = { day, daysAgo };
      continue;
    }
    const bestDistance = Math.abs(best.daysAgo - COMPARISON_TARGET_DAYS);
    if (distance < bestDistance || (distance === bestDistance && daysAgo > best.daysAgo)) {
      best = { day, daysAgo };
    }
  }
  if (best === undefined) return undefined;

  // Baselines as they stood for THAT day: same history, same medians, but the
  // band position read against that day's values. Its own day is excluded from
  // its own history, exactly as today is excluded from today's.
  const baselines = withBaselines
    ? deriveBaselines({
        history: history.filter((d) => d.date < (best as { day: MetricsOnlyDay }).day.date),
        current: best.day.metrics,
      }).baselines
    : [];

  return {
    date: best.day.date,
    daysAgo: best.daysAgo,
    metrics: best.day.metrics,
    baselines,
  };
}

/**
 * Convenience wrapper for a one-off run.
 *
 * Prefer constructing {@link BusinessBrain} once and reusing it when running
 * for several clinics or dates — it builds three engines per construction.
 */
export async function runBusinessBrain(
  deps: BusinessBrainDependencies,
  clinicId: string,
  date: string,
  options?: RunBusinessBrainOptions,
): Promise<BusinessBrainResult> {
  return new BusinessBrain(deps).runBusinessBrain(clinicId, date, options);
}
