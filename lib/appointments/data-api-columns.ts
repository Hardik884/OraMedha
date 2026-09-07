/**
 * lib/appointments/data-api-columns.ts
 *
 * The columns of `appointments` and `treatments` that the Data API will
 * actually return, as one definition instead of a `"*"` in each query.
 *
 * WHY `"*"` STOPPED WORKING
 *   20260907000100 withholds the clinical free-text columns from `anon` and
 *   `authenticated` at the COLUMN level, because that is the only mechanism
 *   Postgres has that can distinguish them — RLS is row-level, and every user
 *   of this product (dentist, receptionist and patient alike) arrives as the
 *   same database role.
 *
 *   A table-level GRANT subsumes column grants, so the fix had to revoke the
 *   table grant and re-grant per column. The consequence is that `select *`
 *   now fails outright:
 *
 *     select * from appointments;
 *       → ERROR: permission denied for table appointments
 *
 *   It fails for the dentist too. There is no role for which `*` still works,
 *   which is why these lists exist rather than a conditional.
 *
 * WHY A LIST AND NOT A CODEGEN
 *   Keeping it by hand is the point. A column added to either table is not
 *   granted by 20260907000100 (there is no `alter default privileges` for
 *   columns), so it is invisible until someone grants it AND adds it here —
 *   two deliberate steps. The previous default was the opposite: a new clinical
 *   column was readable by every patient the moment it existed, which is the
 *   defect that migration fixes.
 *
 * WHERE THE CLINICAL COLUMNS WENT
 *   `appointment_clinical_notes` and `treatment_clinical_notes` — SECURITY
 *   DEFINER projections that check the caller's clinic and role in their own
 *   WHERE clause. See getAppointmentClinical / getTreatmentInternalNotes in the
 *   Server Actions.
 */

/**
 * Every `appointments` column readable through the Data API.
 *
 * Excludes notes, chief_complaints, medical_history, oral_findings and
 * provisional_diagnosis — staff read those through appointment_clinical_notes.
 */
export const APPOINTMENT_COLUMNS = [
  "id",
  "clinic_id",
  "patient_id",
  "dentist_id",
  "scheduled_at",
  "duration_minutes",
  "source",
  "status",
  "deleted_at",
  "created_at",
  "updated_at",
  "created_by",
  "follow_up_id",
] as const;

/** PostgREST select string for a whole appointment row. Replaces `"*"`. */
export const APPOINTMENT_SELECT = APPOINTMENT_COLUMNS.join(", ");

/**
 * Every `treatments` column readable through the Data API.
 *
 * Excludes internal_notes — a dentist reads that through
 * treatment_clinical_notes.
 */
export const TREATMENT_COLUMNS = [
  "id",
  "clinic_id",
  "appointment_id",
  "patient_id",
  "treatment_type",
  "patient_visible_notes",
  "cost",
  "status",
  "performed_at",
  "deleted_at",
  "created_at",
  "updated_at",
  "created_by",
  "medications",
  "consultant_id",
  "commission_type",
  "commission_value",
  "consultant_share",
  "clinic_share",
  "opd_charged",
  "xray_taken",
  "xray_cost",
  "opd_fee",
  "tooth_number",
  "dentition_type",
] as const;

/** PostgREST select string for a whole treatment row. Replaces `"*"`. */
export const TREATMENT_SELECT = TREATMENT_COLUMNS.join(", ");

/**
 * The clinical columns each table no longer exposes. Exported so a spec can
 * assert they never reappear in the lists above.
 */
export const WITHHELD_APPOINTMENT_COLUMNS = [
  "notes",
  "chief_complaints",
  "medical_history",
  "oral_findings",
  "provisional_diagnosis",
] as const;

export const WITHHELD_TREATMENT_COLUMNS = ["internal_notes"] as const;
