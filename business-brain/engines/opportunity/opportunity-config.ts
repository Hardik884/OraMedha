/**
 * Business Brain — Opportunity Engine: configuration
 *
 * Every number the engine judges with, in one place, each with the reason it has
 * the value it has. No detector may contain a bare threshold.
 */

export interface OpportunityConfig {
  /**
   * Days ahead the forward-capacity match looks. Seven, matching
   * `capacity.booked_next_7d`, so the surplus side of the opportunity and the
   * forward-schedule metric describe the same week.
   */
  readonly forwardDays: number;
  /**
   * Minimum notice before a freed slot is worth offering. Two hours: less than
   * that and a patient realistically cannot rearrange their day and travel in.
   * A slot inside it is not an opportunity, it is a gap.
   */
  readonly minimumRefillLeadMinutes: number;
  /** Most freed slots reported at once, earliest first. A guard, not a ranking. */
  readonly maxFreedSlots: number;
  /**
   * Length used to size gaps when the clinic has not configured a typical
   * appointment length. Used only with a stated confidence penalty and a line in
   * the confidence basis — never silently.
   */
  readonly assumedAppointmentMinutes: number;
  /** Fillable appointments at or above which a forward match is high priority. */
  readonly highPriorityFillable: number;
  /** Fillable appointments at or above which a forward match is medium priority. */
  readonly mediumPriorityFillable: number;
  /** A freed slot starting within this many hours is high priority. */
  readonly freedSlotHighWithinHours: number;
  /** ...within this many, medium. Anything later is low. */
  readonly freedSlotMediumWithinHours: number;
  /**
   * Days since the most recent delivered work at which a balance counts as aged.
   * Thirty: a balance older than a month is past the point most clinics settle
   * at the chair, and is the one worth a deliberate follow-up.
   */
  readonly agedBalanceDays: number;
  /** Confidence deductions, each named in the confidence basis when applied. */
  readonly penalties: {
    /** Demand counted from a population a bounded read cut. */
    readonly demandLowerBound: number;
    /** Gaps sized with the assumed rather than the configured appointment length. */
    readonly assumedAppointmentLength: number;
    /** Patient availability is never recorded, so a gap-to-patient fit is unverified. */
    readonly patientAvailabilityUnrecorded: number;
    /** Discounts and write-offs are never recorded, so part of a balance may be intended. */
    readonly discountsUnrecorded: number;
  };
}

export const DEFAULT_OPPORTUNITY_CONFIG: OpportunityConfig = {
  forwardDays: 7,
  minimumRefillLeadMinutes: 120,
  maxFreedSlots: 5,
  assumedAppointmentMinutes: 30,
  highPriorityFillable: 5,
  mediumPriorityFillable: 2,
  freedSlotHighWithinHours: 24,
  freedSlotMediumWithinHours: 72,
  agedBalanceDays: 30,
  penalties: {
    demandLowerBound: 0.2,
    assumedAppointmentLength: 0.15,
    patientAvailabilityUnrecorded: 0.1,
    discountsUnrecorded: 0.15,
  },
};

export function resolveOpportunityConfig(
  overrides: Partial<Omit<OpportunityConfig, "penalties">> & {
    penalties?: Partial<OpportunityConfig["penalties"]>;
  } = {},
): OpportunityConfig {
  return {
    ...DEFAULT_OPPORTUNITY_CONFIG,
    ...overrides,
    penalties: { ...DEFAULT_OPPORTUNITY_CONFIG.penalties, ...(overrides.penalties ?? {}) },
  };
}
