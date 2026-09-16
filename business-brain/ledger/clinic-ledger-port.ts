/**
 * Business Brain — Clinic Ledger port
 *
 * The promotion of `DiagnosisContextPort` into a general intelligence port.
 *
 * The diagnosis port was shaped around one consumer: each method answered one
 * discriminator, and the rows it returned were already half-interpreted
 * ("cancellation events", "pending treatments"). That was the right first step
 * and remains in service — this port EXTENDS it, so everything wired to the
 * diagnosis context keeps working unchanged.
 *
 * What it adds is the relational ledger itself: the clinic's facts with their
 * foreign keys intact, loaded as one consistent SLICE and walked through a pure
 * graph. A new intelligence feature asks a question of the graph instead of
 * adding another flattened metric or another single-purpose port method.
 *
 * ## Two paths, on purpose
 *
 * The aggregate path (`MetricsDataRepository` → snapshot → metrics) stays the
 * way the pipeline runs every day: one snapshot, constant query count, fast.
 * The ledger path is for reasoning ACROSS entities over a bounded scope. Neither
 * replaces the other, and where they describe the same fact they must agree —
 * `clinic-ledger.spec.ts` checks that against a real database.
 *
 * ## Design rules, inherited and extended
 *
 * - READ-ONLY and EXPLICITLY ENUMERATED. Two scoped reads, no query builder, no
 *   predicate parameter.
 * - CLINIC-SCOPED. Every scope names its tenant. Every fact carries it back, and
 *   the graph refuses a slice that mixes tenants.
 * - BOUNDED, AND HONEST ABOUT THE BOUND. Every read takes a per-kind row limit,
 *   and a kind that hit it is reported as truncated. A truncated list is never
 *   presented as complete: the graph answers `outside_slice` for anything the
 *   cut could have removed.
 * - ROWS, NOT JUDGEMENTS. No metric, threshold or conclusion comes back.
 */

import type { DiagnosisContextPort } from "../engines/diagnosis/ports/diagnosis-context-port";
import type {
  ActionCompletionFact,
  CapacityWindowFact,
  AppointmentEventFact,
  AppointmentFact,
  FollowUpFact,
  LedgerFactKind,
  PatientFact,
  PaymentFact,
  QueueVisitFact,
  ReminderSendFact,
  TreatmentEventFact,
  TreatmentFact,
} from "./ledger-facts";

/** Load everything the ledger holds for a bounded set of patients. */
export interface PatientLedgerScope {
  readonly kind: "patients";
  readonly clinicId: string;
  readonly patientIds: readonly string[];
  /**
   * ISO-8601 moment the slice describes. Rows CREATED after it are excluded.
   * Statuses are the rows' current values — OraMedha does not version most of
   * them — so a historical `asOf` bounds membership, not state.
   */
  readonly asOf: string;
  /** Maximum rows per fact kind. */
  readonly limit: number;
}

/** Load appointments scheduled in a window and everything attached to them. */
export interface AppointmentWindowScope {
  readonly kind: "appointment_window";
  readonly clinicId: string;
  /** Clinic-local business dates, inclusive, "YYYY-MM-DD". */
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  readonly limit: number;
}

export type LedgerScope = PatientLedgerScope | AppointmentWindowScope;

/** Published capacity for a clinic-local date range. */
export interface CapacityWindowScope {
  readonly clinicId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The patients who currently have OPEN WORK, loaded with their complete history.
 *
 * Open work is a recorded fact on the patient's own ledger, never an inference:
 *
 *   - a live treatment in status `planned`
 *   - a pending follow-up whose due date is before `asOf`'s clinic-local date
 *   - recorded charges exceeding recorded payments (the balance rule in
 *     lib/billing/balance.ts, clamped per patient)
 *
 * The result is a PATIENT-scope slice, so every patient in it is complete and
 * the graph can answer "has nothing booked" with confidence. When more patients
 * qualify than `maxPatients`, the slice is marked truncated on `patient` and
 * every population derived from it is a lower bound.
 */
export interface OpenWorkScope {
  readonly clinicId: string;
  readonly asOf: string;
  /** Most patients to load. */
  readonly maxPatients: number;
  /** Maximum rows per fact kind, per page of patients. */
  readonly limit: number;
}

/**
 * One consistent read of the clinic's relational facts.
 *
 * What a slice CONTAINS is exactly its arrays. What it can ANSWER depends on its
 * scope and on `truncated` — which is why engines should walk it through
 * `buildLedgerGraph` rather than scanning the arrays and treating a missing row
 * as "none".
 */
export interface ClinicLedgerSlice {
  readonly clinicId: string;
  readonly scope: LedgerScope;
  readonly patients: readonly PatientFact[];
  readonly appointments: readonly AppointmentFact[];
  readonly appointmentEvents: readonly AppointmentEventFact[];
  readonly treatments: readonly TreatmentFact[];
  readonly treatmentEvents: readonly TreatmentEventFact[];
  readonly queueVisits: readonly QueueVisitFact[];
  readonly followUps: readonly FollowUpFact[];
  readonly payments: readonly PaymentFact[];
  readonly reminderSends: readonly ReminderSendFact[];
  readonly actionCompletions: readonly ActionCompletionFact[];
  /** Fact kinds whose read hit `scope.limit`. */
  readonly truncated: readonly LedgerFactKind[];
  /**
   * Fact kinds this reader did not read at all — typically because the session
   * is not permitted to (`action_completions` is dentist-only under RLS).
   *
   * Row Level Security does not refuse a read it disallows; it returns zero
   * rows. Without this list a receptionist's slice would carry an empty
   * completions array that the graph could only read as "no action ever
   * targeted this patient". A withheld kind's array is always empty and every
   * traversal over it answers `outside_slice`.
   */
  readonly withheld: readonly LedgerFactKind[];
  /**
   * Requested patient ids that did not resolve to a live patient in this clinic
   * — soft-deleted, belonging to another clinic, or never existing. Reported
   * rather than dropped silently, and deliberately not distinguished: telling a
   * caller that an id exists in another tenant would itself be a leak.
   */
  readonly unresolvedPatientIds: readonly string[];
}

/**
 * Read-only relational access to one clinic's ledgers.
 *
 * Extends the diagnosis context so a single adapter serves both, and so the
 * service can accept this wherever it accepted the narrower port.
 *
 * Both reads THROW on a failed query. A failure is not an empty ledger, and an
 * adapter that swallowed one would hand the graph an empty slice that reads as
 * "this patient has no appointments".
 */
export interface ClinicLedgerPort extends DiagnosisContextPort {
  readPatientLedger(scope: PatientLedgerScope): Promise<ClinicLedgerSlice>;
  readAppointmentWindow(scope: AppointmentWindowScope): Promise<ClinicLedgerSlice>;
  readCapacityWindow(scope: CapacityWindowScope): Promise<CapacityWindowFact>;
  readOpenWorkLedger(scope: OpenWorkScope): Promise<ClinicLedgerSlice>;
}
