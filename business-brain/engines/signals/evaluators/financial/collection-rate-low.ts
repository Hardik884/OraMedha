/**
 * Signal: revenue.collection_rate_low
 *
 * Business rule: over the trailing window, the clinic collected materially less
 * than it produced.
 *
 * ## Production against collection, which nothing else here reads
 *
 * The pipeline held only half of practice management's fundamental pair: it
 * could say how much was owed (`revenue.outstanding`, a LEVEL) and whether
 * today's cash lagged today's treatments (`collection_lagging_completions`, a
 * DAY), but never what share of delivered work actually converts to money over a
 * period long enough to be a habit.
 *
 * ## It reads the WORK, not the cash
 *
 * This rule was written against `revenue.collection_rate_30d`, which divides the
 * window's cash by the window's production — different cohorts of work. A clinic
 * clearing old balances reads above 100% there, which masked exactly the
 * situation this rule exists to catch: recent work going unpaid while older debt
 * comes in. `revenue.production_paid_rate_30d` follows the work delivered in the
 * window and asks how much of THAT has been paid.
 *
 * The distinction matters because the two have different answers. A clinic with a
 * large outstanding book and a 95% collection rate is growing and carrying
 * receivables; a clinic with a small outstanding book and a 60% collection rate is
 * writing work off. The outstanding level alone cannot tell them apart, and it is
 * the only thing the pipeline previously judged.
 *
 * ## The production guard is not optional
 *
 * A collection rate computed over a nearly-idle month is arithmetic, not a
 * finding: one small unpaid consultation in a month that produced almost nothing
 * reads as a catastrophic collection rate. The guard is a production floor rather
 * than a treatment count, because what makes the rate meaningful is the size of
 * the denominator in money, which is the unit the rate is in.
 */

import { MetricUnit, SignalCategory, SignalType } from "../../../../domain";
import { MetricKey } from "../../../metrics/metric-ids";
import { formatValue } from "../../support/evidence";
import { ThresholdDirection } from "../../support/severity";
import { buildThresholdSignal } from "../../support/signal-builder";
import {
  skippedForMissing,
  type EvaluatorContext,
  type EvaluatorOutcome,
  type SignalEvaluator,
} from "../types";

const REQUIRED = [
  MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D,
  MetricKey.REVENUE_PRODUCTION_30D,
] as const;
const OPTIONAL = [MetricKey.REVENUE_COLLECTED_30D] as const;

export const collectionRateLowEvaluator: SignalEvaluator = {
  type: SignalType.REVENUE_COLLECTION_RATE_LOW,
  category: SignalCategory.FINANCIAL,
  requiredMetrics: REQUIRED,
  optionalMetrics: OPTIONAL,

  evaluate(ctx: EvaluatorContext): EvaluatorOutcome {
    const required = ctx.metrics.require(...REQUIRED);
    if (!required.ok) return skippedForMissing(required.missing);

    const rate = required.metrics.value(MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D);
    const production = required.metrics.value(MetricKey.REVENUE_PRODUCTION_30D);
    const { revenue } = ctx.config;

    if (production < revenue.minimumProductionForRateCheck) {
      return {
        kind: "no_signal",
        reason: `Production of ${formatValue(production, MetricUnit.CURRENCY)} over the window is below the ${formatValue(revenue.minimumProductionForRateCheck, MetricUnit.CURRENCY)} needed for a collection rate to mean anything.`,
      };
    }

    if (rate >= revenue.minimumCollectionRate) {
      return {
        kind: "no_signal",
        reason: `${rate}% of the window's delivered work has been paid for, at or above the minimum ${revenue.minimumCollectionRate}%.`,
      };
    }

    const collected = ctx.metrics.get(MetricKey.REVENUE_COLLECTED_30D);

    return buildThresholdSignal(ctx, {
      type: SignalType.REVENUE_COLLECTION_RATE_LOW,
      category: SignalCategory.FINANCIAL,
      title: "Collecting less than the clinic produces",
      description: `Of the ${formatValue(production, MetricUnit.CURRENCY)} of work delivered in the last 30 days, ${rate}% has been paid for, against a minimum of ${revenue.minimumCollectionRate}%.`,
      observed: {
        label: "Delivered work paid for (30 days)",
        value: rate,
        unit: MetricUnit.PERCENTAGE,
      },
      threshold: {
        label: "Minimum collection rate",
        value: revenue.minimumCollectionRate,
        unit: MetricUnit.PERCENTAGE,
        direction: ThresholdDirection.LOWER,
      },
      inputs: [
        { label: "Production (30 days)", value: production, unit: MetricUnit.CURRENCY },
        ...(collected
          ? [
              {
                label: "Collected (30 days)",
                value: collected.value,
                unit: MetricUnit.CURRENCY,
              },
            ]
          : []),
      ],
      missingOptionalMetrics: collected ? 0 : 1,
      metricsRead: collected ? [...required.metrics.all, collected] : required.metrics.all,
    });
  },
};
