/**
 * Business Brain — Domain: Root-cause analysis
 *
 * WHERE a detected problem is concentrated, and which recorded factors are
 * ASSOCIATED with it — measured from the clinic's own ledger, never inferred.
 *
 * This is diagnostic association, not causal inference. An analysis can say
 * "lost appointments are concentrated in Monday evenings: 38% versus 12%". It
 * cannot say Monday evenings cause them, and nothing on these types allows it to:
 * every association carries its comparison group, both sample sizes and the gap,
 * so a reader can check the claim is exactly as strong as the numbers.
 *
 * An analysis always belongs to one existing Finding. It is evidence ON that
 * finding, never a finding of its own.
 */

import type { Confidence } from "../types";

/** The question an analysis answers, fixed by the parent finding's category. */
export const RootCauseQuestion = {
  /** Where lost appointments (cancelled, missed, or both) are concentrated. */
  ATTRITION: "attrition",
  /** Where visits overrun their booked length most. */
  OVERRUN: "overrun",
  /** Where patients wait longest after arriving. */
  WAITING: "waiting",
  /** Where published chair time goes unbooked. */
  IDLE_CAPACITY: "idle_capacity",
} as const;

export type RootCauseQuestion = (typeof RootCauseQuestion)[keyof typeof RootCauseQuestion];

/** A dimension the ledger records reliably enough to split a population by. */
export const RootCauseDimension = {
  DAY_OF_WEEK: "day_of_week",
  SESSION: "session",
  BOOKED_DURATION: "booked_duration",
  BOOKING_LEAD_TIME: "booking_lead_time",
  BOOKING_ORIGIN: "booking_origin",
  TREATMENT_TYPE: "treatment_type",
  DAY_DENSITY: "day_density",
  ARRIVAL_PUNCTUALITY: "arrival_punctuality",
} as const;

export type RootCauseDimension = (typeof RootCauseDimension)[keyof typeof RootCauseDimension];

/** One group's measured outcome. */
export interface RootCauseGroupStat {
  /** Plain label: "Monday", "Evening (17:00 onwards)", "Root canal". */
  readonly label: string;
  /** Units in the group: appointments, visits, or days/sessions for capacity. */
  readonly n: number;
  readonly unit: "appointments" | "visits" | "days" | "sessions";
  /** For proportions: units with the outcome. Null for measurements. */
  readonly events: number | null;
  /** For proportions: events / n, as a percentage. Null when n is below the minimum. */
  readonly rate: number | null;
  /** For measurements: median, lower and upper quartile. Null for proportions. */
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
}

/** A concentration the data supports, with everything needed to check it. */
export interface RootCauseAssociation {
  /** `<analysis id>#<dimension>:<group>` */
  readonly id: string;
  readonly dimension: RootCauseDimension;
  readonly group: RootCauseGroupStat;
  /** Everyone else in the same population — never the overall figure, which includes the group. */
  readonly comparison: RootCauseGroupStat;
  /** Group minus comparison, in the outcome's unit (percentage points, minutes). */
  readonly gap: number;
  readonly gapUnit: "percentage_points" | "minutes";
  /** Group rate ÷ comparison rate, for proportions when the comparison rate is above zero. */
  readonly ratio: number | null;
  /** The group's share of all events against its share of the population, for proportions. */
  readonly shareOfEvents: number | null;
  readonly shareOfPopulation: number | null;
  /** Other associations in this analysis covering largely the same units. */
  readonly overlapsWith: readonly { readonly associationId: string; readonly sharedShare: number }[];
  readonly confidence: Confidence;
  /** One sentence. Association wording only. */
  readonly statement: string;
  readonly evidence: readonly string[];
}

/** What investigating one dimension found. */
export interface RootCauseDimensionResult {
  readonly dimension: RootCauseDimension;
  readonly status: "association_found" | "no_meaningful_difference" | "insufficient_sample" | "no_variation" | "not_recorded";
  /** Share of the population with this dimension recorded. */
  readonly coverage: number;
  readonly groups: readonly RootCauseGroupStat[];
  readonly reason: string;
}

export interface RootCauseAnalysis {
  /** `rootcause.<question>:<parentFindingId>` */
  readonly id: string;
  readonly parentFindingId: string;
  readonly clinicId: string;
  readonly date: string;
  readonly question: RootCauseQuestion;
  /**
   *   explained              at least one association passed every rule
   *   no_concentration       enough data, and nothing stands out
   *   insufficient_evidence  too little data to look at all
   */
  readonly outcome: "explained" | "no_concentration" | "insufficient_evidence";
  readonly population: {
    readonly description: string;
    readonly from: string;
    readonly to: string;
    readonly n: number;
    readonly events: number | null;
    /** Units left out, and why — never silently dropped. */
    readonly excluded: readonly { readonly reason: string; readonly count: number }[];
  };
  /** Every association that passed, strongest evidence first. More than one stays more than one. */
  readonly associations: readonly RootCauseAssociation[];
  /** True when the passing associations come from more than one dimension. */
  readonly competing: boolean;
  readonly dimensions: readonly RootCauseDimensionResult[];
  readonly confidence: Confidence;
  readonly statement: string;
  readonly limitations: readonly string[];
}
