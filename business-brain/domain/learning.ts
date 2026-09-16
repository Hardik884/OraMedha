/**
 * Business Brain — Domain: Learning
 *
 * What one clinic's own history of actions and outcomes shows, stated only once
 * the evidence for it clears an explicit threshold.
 *
 * ## Three things a learning never is
 *
 * - A cause. The strongest wording is "repeatedly associated with".
 * - A rule change. A learning can PROPOSE a threshold, action, workflow or
 *   confidence adjustment; every proposal requires a person to accept it and
 *   nothing in the Business Brain reads a proposal back.
 * - Portable. A learning belongs to one clinic. There is no benchmark across
 *   clinics and no pooling, so one clinic's history can never inform another's.
 */

export const LearningKind = {
  /** An action repeatedly followed by its intended result. */
  REPEATED_IMPROVEMENT: "repeated_improvement",
  /** An action repeatedly completed and followed by no measurable change. */
  NO_MEASURABLE_CHANGE: "no_measurable_change",
  /** An action repeatedly recommended at the top of the briefing and not marked done. */
  FREQUENTLY_IGNORED: "frequently_ignored",
  /** A problem flagged across weeks of recorded days and still flagged today. */
  RECURRING_UNRESOLVED: "recurring_unresolved",
  /** How long an action's intended result typically takes to be recorded. */
  TIME_TO_OUTCOME: "time_to_outcome",
  /** Episodes of a problem that ended sooner when the action was completed. */
  FASTER_RESOLUTION: "faster_resolution",
  /** An opportunity shown repeatedly with no related action marked done. */
  OPPORTUNITY_NOT_ACTED: "opportunity_not_acted",
} as const;

export type LearningKind = (typeof LearningKind)[keyof typeof LearningKind];

/** How strong the evidence behind a learning is. Mirrors the attribution ladder. */
export type LearningLevel = "observed" | "likely_contributed" | "strong_evidence";

export interface Learning {
  /** `learning.<kind>:<subject>:<clinicId>` */
  readonly id: string;
  readonly clinicId: string;
  readonly kind: LearningKind;
  /** The action category, or opportunity type, the learning is about. */
  readonly subject: string;
  readonly level: LearningLevel;
  readonly statement: string;
  readonly evidence: readonly string[];
  /** The counts the statement rests on, by name. */
  readonly counts: Readonly<Record<string, number>>;
  readonly firstObserved: string;
  readonly lastObserved: string;
  /** Data completeness behind the learning, never a probability. */
  readonly confidence: number;
  readonly limitations: readonly string[];
}

/** Why a learning was, or was not, exposed for one subject. */
export interface LearningAssessment {
  readonly kind: LearningKind;
  readonly subject: string;
  readonly status: "detected" | "not_detected" | "insufficient_evidence";
  readonly reason: string;
}

export const ProposalKind = {
  THRESHOLD_ADJUSTMENT: "threshold_adjustment",
  ACTION_PREFERENCE: "action_preference",
  WORKFLOW_IMPROVEMENT: "workflow_improvement",
  CONFIDENCE_ADJUSTMENT: "confidence_adjustment",
} as const;

export type ProposalKind = (typeof ProposalKind)[keyof typeof ProposalKind];

/**
 * A suggested change. Inert: it names what a person might review and why, and
 * nothing in the Business Brain applies it or reads it back.
 */
export interface LearningProposal {
  readonly id: string;
  readonly clinicId: string;
  readonly kind: ProposalKind;
  readonly learningId: string;
  readonly subject: string;
  readonly statement: string;
  readonly status: "proposed";
  readonly requiresHumanAcceptance: true;
  readonly appliedAutomatically: false;
}

export interface ClinicLearning {
  readonly clinicId: string;
  readonly date: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly learnings: readonly Learning[];
  readonly assessments: readonly LearningAssessment[];
  readonly proposals: readonly LearningProposal[];
  readonly coverage: {
    readonly completions: number;
    readonly closedOutcomes: number;
    readonly recordedDays: number;
    /** History kinds withheld or cut short; every learning that needs one is insufficient. */
    readonly gaps: readonly string[];
  };
}
