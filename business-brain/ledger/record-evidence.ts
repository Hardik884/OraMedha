/**
 * Business Brain — what a record is evidence of
 *
 * The clinic's tables record what someone clicked, which is not always what
 * happened. These rules say, for the cases where the two are known to differ,
 * what a row may be read as. Each keeps "unknown" distinct from "no" and "zero":
 *
 *   no-show basis        a no-show the nightly job INFERRED (no actor) is not the
 *                        same observation as one a person recorded
 *   cancellation side    the patient cancelled, the clinic cancelled, or unknown
 *   arrival evidence     a queue visit completed within a minute of its check-in,
 *                        with no call-in, is the fingerprint of the old "Mark as
 *                        Complete" walk: the arrival and call-in were never
 *                        recorded, only clicked through
 *   unresolved visits    an appointment still checked in or in progress after its
 *                        day ended has no recorded outcome
 *   performed date       a completed treatment with no performed_at is dated by
 *                        when its completion was RECORDED, and says so
 *   treatment type       "Root Canal", "root_canal" and "root canal " are one type;
 *                        a consultation (OPD) record is not a treatment type
 *
 * Pure functions. No database client, no clock, no I/O.
 */

// ── No-show basis ─────────────────────────────────────────────────────────────

export type NoShowBasis = "recorded" | "inferred" | "unknown";

export interface StatusChangeLike {
  /** Status after the change, when the change recorded one. */
  readonly statusAfter: string | null;
  /** ISO-8601 moment of the change. */
  readonly at: string;
  /** Whether a person made the change; null when not known. */
  readonly byPerson: boolean | null;
}

/** How an appointment's no-show was established, from its latest no-show mark. */
export function noShowBasis(changes: readonly StatusChangeLike[]): NoShowBasis {
  const latest = [...changes]
    .filter((c) => c.statusAfter === "no_show")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (latest === undefined || latest.byPerson === null) return "unknown";
  return latest.byPerson ? "recorded" : "inferred";
}

// ── Cancellation side ─────────────────────────────────────────────────────────

export type CancellationSide = "patient" | "clinic" | "unknown";

/**
 * Who cancelled.
 *
 *   patient   the cancellation was made from the patient's own account
 *   clinic    staff cancelled it on a day the clinic had marked closed
 *   unknown   anything else — staff record cancellations of both kinds, and
 *             without a reason no more can be said
 */
export function cancellationSide(input: {
  /** Role of whoever recorded the cancellation, when known. */
  readonly actorRole: string | null;
  /** Whether the appointment's clinic-local date is a recorded closure. */
  readonly onClosedDay: boolean;
}): CancellationSide {
  if (input.actorRole === "patient") return "patient";
  if ((input.actorRole === "dentist" || input.actorRole === "receptionist") && input.onClosedDay) return "clinic";
  return "unknown";
}

// ── Arrival evidence ──────────────────────────────────────────────────────────

/** A completion this soon after check-in, with no call-in, was clicked through, not observed. */
export const CLICKED_THROUGH_MAX_SECONDS = 60;

export interface QueueVisitLike {
  readonly checkedInAt: string;
  readonly calledAt: string | null;
  readonly completedAt: string | null;
}

/**
 * Whether a queue visit carries the fingerprint of a visit completed without a
 * recorded arrival: no call-in, and completed within a minute of "check-in".
 */
export function isClickedThroughVisit(q: QueueVisitLike): boolean {
  if (q.calledAt !== null || q.completedAt === null) return false;
  const seconds = (Date.parse(q.completedAt) - Date.parse(q.checkedInAt)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 && seconds < CLICKED_THROUGH_MAX_SECONDS;
}

/** Whether a queue visit's check-in is evidence of a real arrival. */
export function arrivalRecorded(q: QueueVisitLike): boolean {
  return !isClickedThroughVisit(q);
}

// ── Unresolved visits ─────────────────────────────────────────────────────────

/**
 * Whether an appointment's outcome was never recorded: still checked in or in
 * progress once its own clinic-local day has ended. Arrived, but whether the
 * visit completed is unknown.
 */
export function isUnresolvedVisit(status: string, appointmentDate: string, today: string): boolean {
  return (status === "checked_in" || status === "in_progress") && appointmentDate < today;
}

// ── Performed date ────────────────────────────────────────────────────────────

export type PerformedAtBasis = "performed_at" | "recorded" | "unknown";

/**
 * When a completed treatment happened, and on what evidence: its own
 * performed_at; else the moment its completion was recorded by the state history
 * (observed, never a baseline); else unknown.
 */
export function treatmentPerformedAt(input: {
  readonly performedAt: string | null;
  readonly completionRecordedAt: string | null;
}): { readonly at: string | null; readonly basis: PerformedAtBasis } {
  if (input.performedAt !== null) return { at: input.performedAt, basis: "performed_at" };
  if (input.completionRecordedAt !== null) return { at: input.completionRecordedAt, basis: "recorded" };
  return { at: null, basis: "unknown" };
}

// ── Treatment type ────────────────────────────────────────────────────────────

/** Spellings that name the same type, keyed by their normalised form. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  rct: "root_canal",
  root_canal_treatment: "root_canal",
  crown_placement: "crown",
  crown_fitting: "crown",
  tooth_extraction: "extraction",
  scale_and_polish: "scaling",
  scaling_and_polishing: "scaling",
  braces: "braces_fitting",
  whitening: "teeth_whitening",
};

/** Records of a consultation charge, not of a treatment. */
const CONSULTATION_ONLY = new Set(["consultation", "opd", "opd_consultation", "consultation_fee", "opd_fee"]);

/** The canonical key of a treatment type: lower case, words joined by "_", aliases folded. */
export function treatmentTypeKey(raw: string): string {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return TYPE_ALIASES[key] ?? key;
}

/** A readable label for a canonical key: "root_canal" → "Root Canal". */
export function treatmentTypeLabel(key: string): string {
  return key
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Whether a treatment record is only a consultation (OPD) charge, not a treatment type. */
export function isConsultationOnly(raw: string): boolean {
  return CONSULTATION_ONLY.has(treatmentTypeKey(raw));
}

/** One spelling for a type, for display and grouping: "root canal " → "Root Canal". */
export function canonicalTreatmentType(raw: string): string {
  const key = treatmentTypeKey(raw);
  return key.length === 0 ? raw.trim() : treatmentTypeLabel(key);
}

/**
 * The type a Business Brain grouping should use: the canonical label, or null
 * when the record names no treatment (blank, or consultation only).
 */
export function groupableTreatmentType(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const key = treatmentTypeKey(raw);
  if (key.length === 0 || CONSULTATION_ONLY.has(key)) return null;
  return treatmentTypeLabel(key);
}
