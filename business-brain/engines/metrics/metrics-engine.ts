/**
 * Business Brain — Metrics Engine (implementation)
 *
 * Deterministic engine that turns a clinic data snapshot into factual Metric
 * domain objects. It calculates facts only — no signals, no ranking, no
 * recommendations, no AI, no database access (data arrives via a repository
 * port).
 *
 * Robustness: every calculator runs in isolation. If one throws, it is logged
 * and skipped, and the remaining metrics are still returned (partial results).
 */

import type { EngineResult, ExecutionContext } from "../../types";
import type { Metric } from "../../domain";
import type { ClinicDataSnapshot, MetricsDataRepository } from "../../repositories";
import { logger, type Logger } from "../../utils";
import { MetricsEngine } from "../metrics-engine";
import { METRIC_CALCULATORS } from "./calculators";

/** Input accepted by {@link DentGrowMetricsEngine.execute}. */
export interface MetricsQuery {
  /** Business date to calculate metrics for, "YYYY-MM-DD". */
  readonly date: string;
}

/**
 * Runs every calculator against a snapshot, isolating failures so one bad
 * metric never blocks the rest.
 */
function calculateFromSnapshot(snapshot: ClinicDataSnapshot, log: Logger): Metric[] {
  const metrics: Metric[] = [];
  for (const calculate of METRIC_CALCULATORS) {
    try {
      const metric = calculate(snapshot);
      // `null` is a deliberate withholding, not a failure: the calculator ran
      // and determined the metric is not measurable from this snapshot. It is
      // omitted silently so downstream evaluators skip on missing input.
      if (metric !== null) {
        metrics.push(metric);
      }
    } catch (error) {
      log.warn("Metric calculation failed; skipping", {
        engine: "MetricsEngine",
        clinicId: snapshot.clinicId,
        date: snapshot.date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return metrics;
}

/**
 * The DentGrow Metrics Engine.
 */
export class DentGrowMetricsEngine extends MetricsEngine {
  private readonly repository: MetricsDataRepository;
  private readonly log: Logger;

  constructor(repository: MetricsDataRepository, options?: { enabled?: boolean; logger?: Logger }) {
    super(options?.enabled ?? true);
    this.repository = repository;
    this.log = options?.logger ?? logger;
  }

  /**
   * Calculate all metrics for a clinic on a date. Returns partial results if
   * some individual calculations fail; never throws for a single bad metric.
   */
  async calculateMetrics(clinicId: string, date: string): Promise<Metric[]> {
    return (await this.measureDay(clinicId, date)).metrics;
  }

  /**
   * Calculate a day's metrics AND report how the records behind them were read,
   * so a stored reading can say whether it knew anything the day did not.
   */
  async measureDay(
    clinicId: string,
    date: string,
  ): Promise<{ metrics: Metric[]; knowledge: ClinicDataSnapshot["knowledge"]; timezone: string | undefined }> {
    const snapshot = await this.repository.getClinicSnapshot(clinicId, date);
    return { metrics: calculateFromSnapshot(snapshot, this.log), knowledge: snapshot.knowledge, timezone: snapshot.timezone };
  }

  /**
   * Engine contract entry point. Wraps {@link calculateMetrics} in the uniform
   * {@link EngineResult} envelope. Only unexpected/infrastructure failures
   * (e.g. the repository itself throwing) surface as an error result.
   */
  async execute(
    input: MetricsQuery,
    context: ExecutionContext,
  ): Promise<EngineResult<Metric[]>> {
    const generatedAt = new Date().toISOString();
    try {
      const metrics = await this.calculateMetrics(context.clinicId, input.date);
      return {
        ok: true,
        data: metrics,
        generatedAt,
      };
    } catch (error) {
      this.log.error("Metrics Engine failed to load clinic data", {
        clinicId: context.clinicId,
        date: input.date,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        data: null,
        error: {
          code: "METRICS_DATA_UNAVAILABLE",
          message: "Failed to load clinic data for metric calculation.",
          details: error instanceof Error ? error.message : String(error),
        },
        generatedAt,
      };
    }
  }
}
