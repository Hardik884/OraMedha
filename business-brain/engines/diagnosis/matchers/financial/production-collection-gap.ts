/**
 * Pattern: production_collection_gap
 *
 * Correlation: across the trailing window, the clinic collected materially less
 * than it produced. Production against collection is the fundamental pair in
 * practice management, and until this pattern existed the engine reasoned about
 * only one side of it.
 *
 * ## Why this is not the collection_gap pattern again
 *
 * `collection_gap` requires the DAILY signal — treatment finished today, cash did
 * not arrive today — and its whole discrimination rests on persistence: one day is
 * a billing lag, three consecutive days is a routine. That works, and it is the
 * right way to read a day.
 *
 * It cannot read a month. A clinic can pass the daily check every single day —
 * every day's takings clear the floor, so the signal never fires — while
 * collecting 68% of what it delivers, because the shortfall is spread evenly
 * rather than concentrated. And `high_outstanding` cannot catch it either: that is
 * a LEVEL, and a clinic writing work off has a small outstanding book precisely
 * BECAUSE the money is never going to arrive.
 *
 * So the guard runs the other way from most in this engine. This stands down when
 * the daily signal fired, because then `collection_gap` has the sharper story with
 * its persistence classification attached. What is left is the case neither
 * existing pattern can see.
 *
 * ## Routed into revenue_leakage on purpose
 *
 * The Constraint Engine maps this alongside `collection_gap`, `revenue_shortfall`
 * and `outstanding_receivables`. That is correct and deliberate: the bottleneck is
 * named "work delivered against money received", which is exactly this finding.
 * Adding a pattern here adds a measurement and a strategy without adding a card —
 * the clinic sees one revenue card whose description now names both the level owed
 * and the share being lost.
 *
 * ## What is not asserted
 *
 * Two explanations are consistent with a low collection rate and nothing here can
 * separate them: work billed and still owed, versus work delivered and never
 * charged at all. Both are declared and neither is asserted.
 *
 * They name `charge_reconciliation` and NOT `outstanding_invoice_ageing`, which is
 * the whole point of the distinction. Ageing looks like the right measurement and
 * is not: work that was never charged produces NO balance row, so it is invisible
 * to a query over balances however that ageing reads. Attaching it would let the
 * resolver settle one of these on evidence that does not bear on it — worse than
 * leaving them open, because it would be wrong confidently.
 *
 * What would actually settle them is each completed treatment matched against the
 * charge raised for it, which is precisely the work the corrective strategy asks a
 * person to do, because no query in OraMedha performs it.
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

const REQUIRED = [SignalType.REVENUE_COLLECTION_RATE_LOW] as const;
const EXCLUDED = SignalType.REVENUE_COLLECTION_LAGGING_COMPLETIONS;
const OPTIONAL = [SignalType.REVENUE_HIGH_OUTSTANDING] as const;

const SUSTAINED_UNDER_COLLECTION =
  "A material share of the work the clinic delivered over the window has not been collected, sustained across the period rather than concentrated in any one day.";
const UNBILLED_DELIVERY =
  "Some delivered work was never charged for at all, rather than charged and awaiting payment.";
const AWAITING_PAYMENT =
  "The shortfall is work billed and still owed, which will arrive as those balances are settled.";

export const productionCollectionGapMatcher: PatternMatcher = {
  pattern: DiagnosisPattern.PRODUCTION_COLLECTION_GAP,
  category: SignalCategory.FINANCIAL,
  requiredSignals: REQUIRED,
  optionalSignals: OPTIONAL,
  rule: "Requires a low collection rate over the trailing window, with the daily collection-lagging signal absent (a same-day gap is reported as collection_gap instead, which classifies its own persistence). High outstanding strengthens it.",

  match(ctx: MatcherContext): MatcherOutcome {
    const lowRate = ctx.signals.get(SignalType.REVENUE_COLLECTION_RATE_LOW);
    if (!lowRate) {
      return notMatched(`Required signal absent: ${absenceSummary(ctx, REQUIRED)}.`);
    }
    if (ctx.signals.has(EXCLUDED)) {
      return notMatched(
        `${EXCLUDED} is present, so the shortfall has a same-day reading with its own persistence classification. Reported as ${DiagnosisPattern.COLLECTION_GAP} instead.`,
      );
    }

    const optionalPresent = ctx.signals.present(OPTIONAL);
    const contributing = [lowRate, ...optionalPresent];

    // The share of the window's OWN work that has been paid for — the rate the
    // signal is triggered on. The cash-flow ratio it used to read counts old
    // balances being cleared as this month's collection.
    const rate = metricValue(ctx, MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D);
    const production = metricValue(ctx, MetricKey.REVENUE_PRODUCTION_30D);
    const collected = metricValue(ctx, MetricKey.REVENUE_COLLECTED_30D);
    const outstanding = metricValue(ctx, MetricKey.REVENUE_OUTSTANDING);
    const { revenue } = ctx.config.signals;

    const shortfall =
      production !== undefined && collected !== undefined
        ? Math.max(0, Math.round(production - collected))
        : undefined;

    const arithmetic: EvidenceNote = {
      slug: "revenue.production_vs_collection",
      description: `${rate ?? "An unavailable share"}% of the window's delivered work has been paid for, against the configured minimum ${revenue.minimumCollectionRate}%, on production of ${production ?? "an unavailable amount"} and collections of ${collected ?? "an unavailable amount"} over the window — a shortfall of ${shortfall ?? "an unavailable amount"}. The outstanding balance stands at ${outstanding ?? "an unavailable amount"}. A shortfall larger than the outstanding balance would indicate delivered work that was never charged; a smaller one is consistent with balances still owed. That comparison is stated, not concluded: separating the two needs each completed treatment matched against the charge raised for it, and unbilled work leaves no balance row for an ageing query to find.`,
      data: {
        productionPaidRate: rate,
        minimumCollectionRate: revenue.minimumCollectionRate,
        production,
        collected,
        shortfall,
        outstanding,
      },
    };

    const hypotheses: HypothesisSpec[] = [
      {
        slug: "sustained_under_collection",
        statement: SUSTAINED_UNDER_COLLECTION,
        status: "supported",
        supporting: [
          {
            slug: "rate-below-minimum",
            description: `Over the window the clinic collected ${rate ?? "less than the minimum"}% of what it delivered, below the configured minimum of ${revenue.minimumCollectionRate}%, on production large enough for the rate to be meaningful. No single day breached the daily collection check, so the shortfall is spread rather than concentrated.`,
            data: { collectionRate: rate, production, shortfall },
          },
        ],
      },
      // Both permanently undetermined. See the file header for why the obvious
      // discriminator is the wrong one.
      {
        slug: "unbilled_delivery",
        statement: UNBILLED_DELIVERY,
        status: "undetermined",
        requires: ["CHARGE_RECONCILIATION"],
      },
      {
        slug: "awaiting_payment",
        statement: AWAITING_PAYMENT,
        status: "undetermined",
        requires: ["CHARGE_RECONCILIATION"],
      },
    ];

    return emit(ctx, {
      pattern: DiagnosisPattern.PRODUCTION_COLLECTION_GAP,
      category: SignalCategory.FINANCIAL,
      title: "Collecting less than the clinic delivers",
      summary: `Over the trailing window the clinic collected a share of its production below the configured minimum, without any single day breaching the same-day collection check — so the gap is a standing level rather than one late afternoon.`,
      contributing,
      requiredSignals: REQUIRED,
      optionalSignals: OPTIONAL,
      hypotheses,
      discriminators: [
        {
          key: "CHARGE_RECONCILIATION",
          separates: ["unbilled_delivery", "awaiting_payment"],
        },
      ],
      evidence: [arithmetic],
    });
  },
};
