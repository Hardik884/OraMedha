/**
 * types/index.ts — Single source of truth for all TypeScript types.
 *
 * Sections:
 *   1. Database type re-exports
 *   2. Enum types (as const objects)
 *   3. Computed / extended types
 *   4. Server Action result type
 *   5. Zod validation schemas
 *   6. AI types
 *   7. Analytics types
 *   8. Session / auth types
 */

import { z } from "zod";
import type { Database } from "./database.types";

// =============================================================================
// SECTION 1 — DATABASE TYPE RE-EXPORTS
// =============================================================================

export type { Database } from "./database.types";

// Row types
export type Clinic          = Database["public"]["Tables"]["clinics"]["Row"];
export type Profile         = Database["public"]["Tables"]["profiles"]["Row"];
export type Patient         = Database["public"]["Tables"]["patients"]["Row"];
export type Appointment     = Database["public"]["Tables"]["appointments"]["Row"];
export type AppointmentHistory = Database["public"]["Tables"]["appointment_history"]["Row"];
export type QueueEntry      = Database["public"]["Tables"]["queue_entries"]["Row"];
export type Treatment       = Database["public"]["Tables"]["treatments"]["Row"];
export type TreatmentDocument = Database["public"]["Tables"]["treatment_documents"]["Row"];
export type Payment         = Database["public"]["Tables"]["payments"]["Row"];
export type FollowUp        = Database["public"]["Tables"]["follow_ups"]["Row"];
export type PatientPortalLink = Database["public"]["Tables"]["patient_portal_links"]["Row"];
export type ClinicSettings  = Database["public"]["Tables"]["clinic_settings"]["Row"];
export type AvailabilityRule = Database["public"]["Tables"]["availability_rules"]["Row"];
export type WebhookLog      = Database["public"]["Tables"]["webhook_logs"]["Row"];
export type Consultant      = Database["public"]["Tables"]["consultants"]["Row"];
export type ConsultancyIncome = Database["public"]["Tables"]["consultancy_income"]["Row"];
export type ConsultancySchedule = Database["public"]["Tables"]["consultancy_schedules"]["Row"];
export type UnavailableDate = Database["public"]["Tables"]["unavailable_dates"]["Row"];
export type PatientTooth    = Database["public"]["Tables"]["patient_teeth"]["Row"];
export type ToothHistory    = Database["public"]["Tables"]["tooth_history"]["Row"];

// Insert types
export type PatientInsert     = Database["public"]["Tables"]["patients"]["Insert"];
export type AppointmentInsert = Database["public"]["Tables"]["appointments"]["Insert"];
export type TreatmentInsert   = Database["public"]["Tables"]["treatments"]["Insert"];
export type PaymentInsert     = Database["public"]["Tables"]["payments"]["Insert"];
export type FollowUpInsert    = Database["public"]["Tables"]["follow_ups"]["Insert"];
export type PatientToothInsert = Database["public"]["Tables"]["patient_teeth"]["Insert"];

// Update types
export type PatientUpdate     = Database["public"]["Tables"]["patients"]["Update"];
export type AppointmentUpdate = Database["public"]["Tables"]["appointments"]["Update"];
export type TreatmentUpdate   = Database["public"]["Tables"]["treatments"]["Update"];
export type FollowUpUpdate    = Database["public"]["Tables"]["follow_ups"]["Update"];
export type ClinicSettingsUpdate = Database["public"]["Tables"]["clinic_settings"]["Update"];
export type PatientToothUpdate = Database["public"]["Tables"]["patient_teeth"]["Update"];

// =============================================================================
// SECTION 2 — ENUM TYPES
// =============================================================================

export const AppointmentStatus = {
  SCHEDULED:   "scheduled",
  CHECKED_IN:  "checked_in",
  IN_PROGRESS: "in_progress",
  COMPLETED:   "completed",
  CANCELLED:   "cancelled",
  NO_SHOW:     "no_show",
} as const;
export type AppointmentStatus = (typeof AppointmentStatus)[keyof typeof AppointmentStatus];

export const AppointmentSource = {
  WALK_IN:    "walk_in",
  PHONE_CALL: "phone_call",
  WEBSITE:    "website",
  REFERRAL:   "referral",
  OTHER:      "other",
} as const;
export type AppointmentSource = (typeof AppointmentSource)[keyof typeof AppointmentSource];

export const TreatmentStatus = {
  PLANNED:     "planned",
  IN_PROGRESS: "in_progress",
  COMPLETED:   "completed",
  CANCELLED:   "cancelled",
} as const;
export type TreatmentStatus = (typeof TreatmentStatus)[keyof typeof TreatmentStatus];

export const PaymentMethod = {
  CASH:          "cash",
  UPI:           "upi",
  CARD:          "card",
  BANK_TRANSFER: "bank_transfer",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentType = {
  TREATMENT: "treatment",
  OPD:       "opd",
} as const;
export type PaymentType = (typeof PaymentType)[keyof typeof PaymentType];

export const FollowUpStatus = {
  PENDING:   "pending",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;
export type FollowUpStatus = (typeof FollowUpStatus)[keyof typeof FollowUpStatus];

export const FollowUpType = {
  REVIEW:            "review",
  CLEANING:          "cleaning",
  CROWN_CHECK:       "crown_check",
  ROOT_CANAL_REVIEW: "root_canal_review",
  IMPLANT_REVIEW:    "implant_review",
  PAYMENT_REMINDER:  "payment_reminder",
  CONSULTATION:      "consultation",
  CUSTOM:            "custom",
} as const;
export type FollowUpType = (typeof FollowUpType)[keyof typeof FollowUpType];

export const QueueStatus = {
  WAITING:     "waiting",
  IN_PROGRESS: "in_progress",
  COMPLETED:   "completed",
} as const;
export type QueueStatus = (typeof QueueStatus)[keyof typeof QueueStatus];

export const UserRole = {
  DENTIST:       "dentist",
  RECEPTIONIST:  "receptionist",
  PATIENT:       "patient",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const GenderType = {
  MALE:   "male",
  FEMALE: "female",
  OTHER:  "other",
} as const;
export type GenderType = (typeof GenderType)[keyof typeof GenderType];

// ── Dental Chart ──────────────────────────────────────────────────────────────

export const DentitionType = {
  ADULT:   "adult",
  PRIMARY: "primary",
} as const;
export type DentitionType = (typeof DentitionType)[keyof typeof DentitionType];

export const ToothStatus = {
  NORMAL:      "normal",
  RECOMMENDED: "recommended",
  PLANNED:     "planned",
  IN_PROGRESS: "in_progress",
  COMPLETED:   "completed",
  MISSING:     "missing",
} as const;
export type ToothStatus = (typeof ToothStatus)[keyof typeof ToothStatus];

export const TOOTH_STATUS_LABELS: Record<ToothStatus, string> = {
  normal:      "Normal",
  recommended: "Treatment Recommended",
  planned:     "Treatment Planned",
  in_progress: "Treatment In Progress",
  completed:   "Treatment Completed",
  missing:     "Missing / Extracted",
};

/**
 * Valid appointment status transition map.
 * Used in actions/appointments.ts to enforce lifecycle order.
 */
export const VALID_APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled:   ["checked_in", "cancelled", "no_show"],
  checked_in:  ["in_progress", "cancelled", "no_show"],
  in_progress: ["completed"],
  completed:   [],
  cancelled:   [],
  no_show:     [],
};

// =============================================================================
// SECTION 3 — COMPUTED / EXTENDED TYPES
// =============================================================================

export type PatientWithBalance = Patient & {
  outstandingBalance: number;
};

export type PatientWithFollowUps = Patient & {
  pendingFollowUps: FollowUp[];
};

export type PatientFull = Patient & {
  outstandingBalance: number;
  pendingFollowUps: FollowUp[];
};

export type AppointmentWithPatient = Appointment & {
  /** Treating doctor's display name, resolved from profiles via dentist_id. Null when unassigned. */
  dentistName?: string | null;
  patient: Pick<Patient, "id" | "name" | "phone" | "date_of_birth" | "gender">;
};

export type AppointmentWithHistory = Appointment & {
  patient: Pick<Patient, "id" | "name" | "phone" | "date_of_birth" | "gender">;
  history: AppointmentHistory[];
};

export type QueueEntryWithPatient = QueueEntry & {
  patient: Pick<Patient, "id" | "name">;
  /** Duration of the linked appointment — used for accurate wait time calculation */
  duration_minutes?: number;
};

/** Follow-up with joined patient, appointment, and treatment relations */
export type FollowUpWithRelations = FollowUp & {
  patient: Pick<Patient, "id" | "name" | "phone"> | null;
  appointment: Pick<Appointment, "id" | "scheduled_at" | "status"> | null;
  treatment: Pick<Treatment, "id" | "treatment_type" | "status"> | null;
};

/** Receptionist view — internal_notes excluded */
export type TreatmentForReceptionist = Omit<Treatment, "internal_notes">;

/** Patient portal view — only patient-visible fields */
export type TreatmentForPatient = Pick<
  Treatment,
  | "id"
  | "clinic_id"
  | "appointment_id"
  | "patient_id"
  | "treatment_type"
  | "patient_visible_notes"
  | "medications"
  | "cost"
  | "status"
  | "performed_at"
  | "created_at"
>;

/**
 * Resolved dentist signature shown in the patient portal. The signature is NOT
 * stored on the treatment — it is resolved at read time from the dentist's
 * profile (via appointments.dentist_id) and applies to EVERY treatment status
 * (planned, in_progress, completed, cancelled). `null` only when the dentist
 * has never uploaded a signature, in which case the signature block is hidden
 * entirely. Treatment status and date are rendered from the treatment itself.
 * Registration number is resolved from clinic_settings.
 */
export type TreatmentSignature = {
  dentistName: string;
  signatureUrl: string;
  registrationNumber: string | null;
};

/** Patient portal treatment enriched with an optional resolved dentist signature. */
export type TreatmentForPatientWithSignature = TreatmentForPatient & {
  signature: TreatmentSignature | null;
};

/**
 * Past treatment history row shown on the appointment detail page.
 * Enriched with the performing dentist's display name (resolved at read time
 * via the treatment's appointment → dentist profile).
 */
export type TreatmentHistoryItem = Pick<
  Treatment,
  | "id"
  | "treatment_type"
  | "status"
  | "cost"
  | "performed_at"
  | "created_at"
  | "patient_visible_notes"
  | "appointment_id"
> & {
  dentistName: string | null;
};

/**
 * A treatment record small enough to show in a tooth's linked-treatment list,
 * mirroring the fields TreatmentHistoryItem already exposes so both lists
 * render with the same summary shape.
 */
export type ToothLinkedTreatment = Pick<
  Treatment,
  | "id"
  | "treatment_type"
  | "status"
  | "cost"
  | "performed_at"
  | "created_at"
  | "patient_visible_notes"
  | "appointment_id"
>;

/**
 * One tooth's full chart entry as rendered by the Dental Chart: current state
 * (patient_teeth row, or null if the tooth has never been charted — it then
 * defaults to "normal" in the UI), its append-only history, and any
 * treatments linked to it via treatments.tooth_number.
 */
export type ToothChartEntry = {
  toothNumber: number;
  dentitionType: DentitionType;
  tooth: PatientTooth | null;
  history: ToothHistory[];
  treatments: ToothLinkedTreatment[];
};

/** Full dental chart for a patient — every FDI tooth in the requested dentition. */
export type PatientDentalChart = {
  patientId: string;
  dentitionType: DentitionType;
  teeth: ToothChartEntry[];
};

// =============================================================================
// SECTION 4 — SERVER ACTION RESULT TYPE
// =============================================================================

/** Enforced return type for all Server Actions */
export type ActionResult<T> = {
  data: T | null;
  error: string | null;
};

// =============================================================================
// SECTION 5 — ZOD VALIDATION SCHEMAS
// =============================================================================

const phoneRegex = /^[+]?[\d\s\-().]{7,15}$/;

// ── Patient ───────────────────────────────────────────────────────────────────

export const CreatePatientSchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be 100 characters or fewer"),
  phone: z.string().regex(phoneRegex, "Invalid phone number format").optional().or(z.literal("")),
  /**
   * Clinic-issued contact address, and the ONLY key to portal access.
   *
   * Optional on purpose: most patients never use the portal, and a walk-in must
   * still be creatable from a name alone. Leaving it empty means "no portal
   * access" rather than "not filled in yet" — a clinic can add it later from the
   * patient's edit screen and activation becomes available from that moment.
   *
   * Lower-cased and trimmed before it reaches the database (actions/patients.ts)
   * so it matches uq_patients_clinic_email_active, which is case-insensitive.
   */
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .max(254, "Email is too long")
    .optional()
    .or(z.literal("")),
  date_of_birth: z.string().optional(),
  // Gender is optional. The form maps the empty "Select…" option to undefined
  // (via register setValueAs) so this enum never receives "".
  gender: z.enum(["male", "female", "other"]).optional(),
  address: z.string().max(500, "Address is too long").optional(),
  emergency_contact_name: z.string().max(100, "Contact name is too long").optional(),
  emergency_contact_phone: z
    .string()
    .regex(phoneRegex, "Invalid phone number format")
    .optional()
    .or(z.literal("")),
  notes: z.string().max(2000, "Notes are too long").optional(),
});
export type CreatePatientInput = z.infer<typeof CreatePatientSchema>;

export const UpdatePatientSchema = CreatePatientSchema.partial();
export type UpdatePatientInput = z.infer<typeof UpdatePatientSchema>;

// ── Appointment ───────────────────────────────────────────────────────────────

export const CreateAppointmentSchema = z.object({
  patient_id: z.string().uuid("Please select a patient"),
  // Accept ISO datetime with OR without timezone offset.
  // Slots from getAvailableSlots() return "YYYY-MM-DDTHH:MM:00" (no offset);
  // the server action converts to a proper timestamptz before inserting.
  scheduled_at: z.string().min(1, "Please select a time slot"),
  duration_minutes: z.number().int().positive().default(30),
  source: z.enum(["walk_in", "phone_call", "website", "referral", "other"]),
  // Chief complaints captured at booking. Stored directly in
  // appointments.chief_complaints so the Patient Visit page auto-loads it
  // (single source of truth — no duplicate "notes" field).
  chief_complaints: z.string().max(5000).optional(),
});
export type CreateAppointmentInput = z.infer<typeof CreateAppointmentSchema>;

/**
 * Structured medical history stored in appointments.medical_history (jsonb).
 * Quick-select flags plus free-text notes. Editable by receptionist + dentist.
 */
export type MedicalHistory = {
  hypertension: boolean;
  diabetes: boolean;
  pregnancy_lactation: boolean;
  drug_allergies: boolean;
  thyroid_disorders: boolean;
  notes: string;
};

export const MedicalHistorySchema = z.object({
  hypertension: z.boolean().default(false),
  diabetes: z.boolean().default(false),
  pregnancy_lactation: z.boolean().default(false),
  drug_allergies: z.boolean().default(false),
  thyroid_disorders: z.boolean().default(false),
  notes: z.string().max(2000).default(""),
});

/**
 * Clinical consultation fields on the Patient Visit page.
 * Every field is optional — each card saves independently. The server action
 * enforces which role may write which field (chief complaints + medical
 * history: receptionist & dentist; oral findings + provisional diagnosis:
 * dentist only).
 */
export const UpdateAppointmentClinicalSchema = z.object({
  chief_complaints: z.string().max(5000).nullable().optional(),
  medical_history: MedicalHistorySchema.nullable().optional(),
  oral_findings: z.string().max(5000).nullable().optional(),
  provisional_diagnosis: z.string().max(5000).nullable().optional(),
});
export type UpdateAppointmentClinicalInput = z.infer<typeof UpdateAppointmentClinicalSchema>;

/** Radiographic document categories offered on the Patient Visit page. */
export const RADIOGRAPH_DOCUMENT_TYPES = ["IOPA", "OPG", "CBCT", "Other"] as const;
export type RadiographDocumentType = (typeof RADIOGRAPH_DOCUMENT_TYPES)[number];

export const RescheduleAppointmentSchema = z.object({
  appointment_id: z.string().uuid(),
  // Accept ISO datetime with OR without timezone offset.
  // Slots from getAvailableSlots() return "YYYY-MM-DDTHH:MM:00" (no offset);
  // the server action converts to UTC via zonedDateToUTC before inserting.
  new_scheduled_at: z.string().min(1, "Please select a time slot"),
});
export type RescheduleAppointmentInput = z.infer<typeof RescheduleAppointmentSchema>;

export const UpdateAppointmentStatusSchema = z.object({
  appointment_id: z.string().uuid(),
  new_status: z.enum(["scheduled", "checked_in", "in_progress", "completed", "cancelled", "no_show"]),
});
export type UpdateAppointmentStatusInput = z.infer<typeof UpdateAppointmentStatusSchema>;

// ── Treatment ─────────────────────────────────────────────────────────────────

/**
 * Standard prescription frequency codes used in the dosage dropdown.
 * Displayed as-is in the UI; stored verbatim in the medication JSONB record.
 */
export const DOSAGE_OPTIONS = [
  "OD",
  "BD",
  "TDS",
  "QID",
  "SOS",
  "HS",
  "TSP",
] as const;
export type DosageOption = (typeof DOSAGE_OPTIONS)[number];

/**
 * Canonical treatment type options.
 *
 * Single source of truth shared by BOTH the Treatment Type dropdown and the
 * Follow-Up Type dropdown (CLAUDE.md task: the two must reuse the same list).
 * Stored verbatim in `treatments.treatment_type` (text) and
 * `follow_ups.follow_up_type` (text). Both columns are free text, so existing
 * legacy records (e.g. "Root Canal", "review") remain valid and editable —
 * the forms surface the legacy value as an extra option when it is not in this
 * list so saving never silently rewrites it.
 */
export const TREATMENT_TYPE_OPTIONS = [
  "OPD",
  "Scaling",
  "Restoration",
  "Root Canal Treatment",
  "Crown Treatment",
  "Orthodontic Treatment",
  "Bleaching",
  "Extraction",
  "Denture",
  "Surgical Extraction",
  "Implant",
] as const;
export type TreatmentTypeOption = (typeof TREATMENT_TYPE_OPTIONS)[number];

/**
 * Standard medication instruction options for the Instructions dropdown.
 * Stored verbatim in the medication JSONB record. Optional — legacy free-text
 * instructions remain valid and are preserved when editing.
 */
export const MEDICATION_INSTRUCTION_OPTIONS = [
  "Before Breakfast",
  "After Breakfast",
  "After Lunch",
  "After Dinner",
  "After Meal",
  "Apply Locally",
] as const;
export type MedicationInstructionOption = (typeof MEDICATION_INSTRUCTION_OPTIONS)[number];

/**
 * Medication line item attached to a treatment.
 *  - name:         medicine name (free text)
 *  - dosage:       frequency code — one of DOSAGE_OPTIONS, or legacy free text
 *  - number:       units per intake — 0.5 ("1/2"), 1, 2 or 3
 *  - days:         number of days to take it (increment counter)
 *  - instructions: optional instruction — one of MEDICATION_INSTRUCTION_OPTIONS,
 *                  or legacy free text
 */
export const MedicationSchema = z.object({
  name: z.string().min(1, "Medicine name is required").max(120),
  dosage: z.string().max(40).optional().or(z.literal("")),
  number: z.coerce.number().min(0.5).max(3),
  days: z.coerce.number().int().min(1).max(365),
  instructions: z.string().max(1000).optional().or(z.literal("")),
});
export type MedicationInput = z.infer<typeof MedicationSchema>;

export const CreateTreatmentSchema = z.object({
  appointment_id: z.string().uuid("Please select an appointment"),
  patient_id: z.string().uuid(),
  treatment_type: z.string().min(1, "Treatment type is required").max(100),
  internal_notes: z.string().max(5000).optional(),
  patient_visible_notes: z.string().max(2000).optional(),
  medications: z.array(MedicationSchema).max(30).optional(),
  cost: z.number({ invalid_type_error: "Cost is required" }).nonnegative("Cost cannot be negative"),
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).default("planned"),
  // Whether an OPD consultation fee should be collected for this treatment.
  // Drives visibility of the OPD payments subsection on the Patient Visit page.
  opd_charged: z.boolean().default(false),
  // X-ray information. xray_cost is required and must be > 0 only when xray_taken is true.
  // Cross-field validation is enforced in the form (not here, so .partial() works cleanly).
  xray_taken: z.boolean().default(false),
  xray_cost: z.number().nonnegative("X-ray cost cannot be negative").nullable().optional(),
  // Accepts "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", or full ISO strings.
  // The server action normalises this to a proper timestamptz before inserting.
  // Truly optional — can be omitted or left blank without validation failure.
  performed_at: z.string().optional().or(z.literal("")).transform(v => v || undefined),
  // ── Revenue distribution ──────────────────────────────────────────────────
  // consultant_id NULL/empty => performed by the treating dentist (no split).
  // When a consultant is selected, commission_type + commission_value drive the
  // consultant_share / clinic_share computed server-side. Cross-field rules are
  // enforced in the server action (kept off the object so .partial() works).
  consultant_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  commission_type: z.enum(["percentage", "fixed"]).optional(),
  commission_value: z.number().nonnegative().optional(),
  // ── Dental Chart link ─────────────────────────────────────────────────────
  // Optional — most treatments are still whole-mouth (consultation, cleaning).
  // When set, the treatment is linked to a specific FDI tooth and the chart's
  // patient_teeth row for that tooth is upserted to match. tooth_number alone
  // (without dentition_type) is invalid; the schema-level refine below and the
  // server action both enforce that they travel together.
  tooth_number: z.number().int().optional(),
  dentition_type: z.enum(["adult", "primary"]).optional(),
});
export type CreateTreatmentInput = z.infer<typeof CreateTreatmentSchema>;

export const UpdateTreatmentSchema = CreateTreatmentSchema.omit({ appointment_id: true, patient_id: true }).partial();
export type UpdateTreatmentInput = z.infer<typeof UpdateTreatmentSchema>;

// ── Dental Chart ──────────────────────────────────────────────────────────────

/** FDI tooth number ranges, keyed by dentition type. Mirrors the DB CHECK constraints. */
export const FDI_TOOTH_NUMBERS: Record<DentitionType, readonly number[]> = {
  adult: [
    11, 12, 13, 14, 15, 16, 17, 18,
    21, 22, 23, 24, 25, 26, 27, 28,
    31, 32, 33, 34, 35, 36, 37, 38,
    41, 42, 43, 44, 45, 46, 47, 48,
  ],
  primary: [
    51, 52, 53, 54, 55,
    61, 62, 63, 64, 65,
    71, 72, 73, 74, 75,
    81, 82, 83, 84, 85,
  ],
};

function isValidFdiToothNumber(dentitionType: DentitionType, toothNumber: number): boolean {
  return (FDI_TOOTH_NUMBERS[dentitionType] as readonly number[]).includes(toothNumber);
}

export const UpsertToothSchema = z
  .object({
    patient_id: z.string().uuid("Patient is required"),
    dentition_type: z.enum(["adult", "primary"]).default("adult"),
    tooth_number: z.number().int(),
    status: z.enum(["normal", "recommended", "planned", "in_progress", "completed", "missing"]),
    condition: z.string().max(500).optional().or(z.literal("")).transform((v) => v || undefined),
    notes: z.string().max(2000).optional().or(z.literal("")).transform((v) => v || undefined),
  })
  .refine((v) => isValidFdiToothNumber(v.dentition_type, v.tooth_number), {
    message: "Tooth number is not valid for the selected dentition",
    path: ["tooth_number"],
  });
export type UpsertToothInput = z.infer<typeof UpsertToothSchema>;

/** Multi-select bulk update — same fields applied to every selected tooth. */
export const BulkUpdateTeethSchema = z.object({
  patient_id: z.string().uuid("Patient is required"),
  dentition_type: z.enum(["adult", "primary"]).default("adult"),
  tooth_numbers: z.array(z.number().int()).min(1, "Select at least one tooth").max(32),
  status: z.enum(["normal", "recommended", "planned", "in_progress", "completed", "missing"]),
  condition: z.string().max(500).optional().or(z.literal("")).transform((v) => v || undefined),
  notes: z.string().max(2000).optional().or(z.literal("")).transform((v) => v || undefined),
});
export type BulkUpdateTeethInput = z.infer<typeof BulkUpdateTeethSchema>;

/**
 * Link an EXISTING treatment (past or current — any status, any age) to a
 * tooth. patient_id is deliberately NOT part of this input: the server
 * action resolves it from the treatment record itself (scoped to the
 * caller's clinic), rather than trusting a client-supplied value that would
 * have to be cross-checked against the treatment anyway.
 */
export const LinkTreatmentToToothSchema = z
  .object({
    treatment_id: z.string().uuid("Select a treatment to link"),
    dentition_type: z.enum(["adult", "primary"]).default("adult"),
    tooth_number: z.number().int(),
  })
  .refine((v) => isValidFdiToothNumber(v.dentition_type, v.tooth_number), {
    message: "Tooth number is not valid for the selected dentition",
    path: ["tooth_number"],
  });
export type LinkTreatmentToToothInput = z.infer<typeof LinkTreatmentToToothSchema>;

/** Metadata recorded after a file is uploaded to storage */
export const CreateTreatmentDocumentSchema = z.object({
  treatment_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  file_name: z.string().min(1).max(255),
  file_path: z.string().min(1).max(500),
  file_type: z.string().min(1).max(120),
  file_size: z.number().int().nonnegative().optional(),
});
export type CreateTreatmentDocumentInput = z.infer<typeof CreateTreatmentDocumentSchema>;

// ── Payment ───────────────────────────────────────────────────────────────────

export const RecordPaymentSchema = z.object({
  patient_id: z.string().uuid("Please select a patient"),
  appointment_id: z.string().uuid().optional(),
  // Optional link to the specific treatment this payment is for. Enables
  // treatment-wise payment tracking on the Patient Visit page.
  treatment_id: z.string().uuid().optional().or(z.literal("")).transform((v) => v || undefined),
  amount: z.number({ invalid_type_error: "Amount is required" }).positive("Amount must be greater than 0"),
  method: z.enum(["cash", "upi", "card", "bank_transfer"]),
  payment_type: z.enum(["treatment", "opd"]).optional(),
  // Optional: when omitted, the server stamps the clinic's local "today" (not the
  // server's UTC date), so a payment recorded near midnight lands on the right
  // business day. An explicit value (e.g. a backdated entry) is respected.
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Valid payment date is required").optional(),
  notes: z.string().max(500).optional(),
});
export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

// ── Follow-Up ─────────────────────────────────────────────────────────────────

/**
 * follow_up_type is a free-text column. The UI sources its options from
 * TREATMENT_TYPE_OPTIONS (shared with the Treatment Type dropdown), but the
 * schema accepts any non-empty string so legacy values (review, cleaning, …)
 * remain valid and editable.
 */
export const FollowUpConfirmationStatus = {
  TENTATIVE: "tentative",
  CONFIRMED: "confirmed",
} as const;
export type FollowUpConfirmationStatus =
  (typeof FollowUpConfirmationStatus)[keyof typeof FollowUpConfirmationStatus];

export const CreateFollowUpSchema = z.object({
  patient_id: z.string().uuid("Patient is required"),
  follow_up_type: z.string().min(1, "Follow-up type is required").max(100),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Valid due date is required"),
  /** Time-of-day for the auto-created appointment, "HH:MM" (24h). */
  due_time: z.string().regex(/^\d{2}:\d{2}$/, "Valid time is required (HH:MM)").optional().or(z.literal("")).transform(v => v || undefined),
  appointment_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  treatment_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  confirmation_status: z.enum(["tentative", "confirmed"]).optional(),
  notes: z.string().max(1000).optional(),
  /**
   * Initial status. Defaults to "pending" — every existing caller that omits
   * this field behaves exactly as before.
   *
   * Exists for back-entered / historical records: a clinic digitising a recall
   * that already happened has no way to say so without this, so it is forced
   * into "pending" — and since its due_date is necessarily in the past, that
   * status makes it read as overdue, misreporting resolved history as a missed
   * follow-up.
   */
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
});
export type CreateFollowUpInput = z.infer<typeof CreateFollowUpSchema>;

export const UpdateFollowUpSchema = z.object({
  follow_up_type: z.string().min(1).max(100).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  appointment_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  treatment_id: z.string().uuid().optional().or(z.literal("")).transform(v => v || undefined),
  confirmation_status: z.enum(["tentative", "confirmed"]).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
});
export type UpdateFollowUpInput = z.infer<typeof UpdateFollowUpSchema>;

// ── Clinic Settings ───────────────────────────────────────────────────────────

const ClinicDayHoursSchema = z.object({
  open: z.string().nullable(),
  close: z.string().nullable(),
  is_open: z.boolean(),
});

export const UpdateClinicSettingsSchema = z.object({
  clinic_name: z.string().min(1).max(100),
  phone: z.string().regex(phoneRegex).optional().or(z.literal("")),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(500).optional(),
  average_appointment_duration: z.number().int().positive(),
  // Treatment chairs that can be occupied at once. Mirrors the database CHECK:
  // 0 chairs would make the clinic's capacity zero and its utilization a divide
  // by zero. Capped at a level no single-site practice reaches, so a typo in a
  // number field cannot silently make every capacity reading meaningless.
  chair_count: z.number().int().min(1).max(50),
  // Days since a patient's last visit before they count as due for reactivation.
  // Mirrors the database CHECK (30..1095): below a month is a treatment plan
  // rather than a recall, and beyond three years the patient has lapsed by any
  // definition — either extreme would quietly distort the clinic's call-back list.
  recall_interval_days: z.number().int().min(30).max(1095),
  timezone: z.string().min(1),
  registration_number: z.string().max(100).optional().or(z.literal("")),
  allow_receptionist_payments: z.boolean().default(false),
  show_consultancy_on_dashboard: z.boolean().default(true),
  // Default OPD consultation fee (clinic-specific). Optional — leave empty to
  // configure no default. Pre-fills the amount when recording an OPD payment.
  default_opd_fee: z.number().nonnegative().nullable().optional(),
  // Whether the X-ray section is shown inside treatment forms clinic-wide.
  enable_xray_charges: z.boolean().default(true),
  clinic_hours: z.object({
    monday: ClinicDayHoursSchema,
    tuesday: ClinicDayHoursSchema,
    wednesday: ClinicDayHoursSchema,
    thursday: ClinicDayHoursSchema,
    friday: ClinicDayHoursSchema,
    saturday: ClinicDayHoursSchema,
    sunday: ClinicDayHoursSchema,
  }).optional(),
});
export type UpdateClinicSettingsInput = z.infer<typeof UpdateClinicSettingsSchema>;

// ── Availability Rule ─────────────────────────────────────────────────────────

export const CreateAvailabilityRuleSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  slot_duration_minutes: z.number().int().positive(),
  is_active: z.boolean().default(true),
});
export type CreateAvailabilityRuleInput = z.infer<typeof CreateAvailabilityRuleSchema>;

// ── Consultant Directory ────────────────────────────────────────────────────

export const CreateConsultantSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
});
export type CreateConsultantInput = z.infer<typeof CreateConsultantSchema>;

export const UpdateConsultantSchema = CreateConsultantSchema;
export type UpdateConsultantInput = z.infer<typeof UpdateConsultantSchema>;

// ── Consultancy Income (external earnings) ───────────────────────────────────

export const RecordConsultancyIncomeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Valid date is required"),
  external_clinic: z.string().trim().max(200).optional().or(z.literal("")).transform((v) => v || undefined),
  description: z.string().trim().max(500).optional().or(z.literal("")).transform((v) => v || undefined),
  amount: z.number().positive("Amount must be greater than zero"),
  notes: z.string().max(1000).optional().or(z.literal("")).transform((v) => v || undefined),
});
export type RecordConsultancyIncomeInput = z.infer<typeof RecordConsultancyIncomeSchema>;

// ── Consultancy Schedule (single-date time blocks) ───────────────────────────

export const CreateConsultancyScheduleSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Valid date is required"),
    start_time: z.string().regex(/^\d{2}:\d{2}$/, "Valid start time required (HH:MM)"),
    end_time: z.string().regex(/^\d{2}:\d{2}$/, "Valid end time required (HH:MM)"),
    reason: z.string().max(200).optional().or(z.literal("")).transform((v) => v || undefined),
  })
  .refine((v) => v.end_time > v.start_time, {
    message: "End time must be after start time",
    path: ["end_time"],
  });
export type CreateConsultancyScheduleInput = z.infer<typeof CreateConsultancyScheduleSchema>;

// ── Unavailable Date (holiday / closure) ─────────────────────────────────────

export const CreateUnavailableDateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Valid date is required"),
  reason: z.string().max(200).optional().or(z.literal("")).transform((v) => v || undefined),
});
export type CreateUnavailableDateInput = z.infer<typeof CreateUnavailableDateSchema>;

// ── Portal Link ───────────────────────────────────────────────────────────────
//
// LinkPortalAccountSchema — REMOVED.
//
// It validated { clinicId, phone, name?, confirmNew? } for linkPortalAccount,
// the self-registration flow deleted from actions/portal-link.ts. Its shape was
// the problem, not its validation: a clinic id and a phone number supplied by
// the browser, plus a flag authorising the server to create a patient record.
//
// Portal activation takes none of those. It takes an email address, sends a
// code to it, and reads the clinic from the record that address already belongs
// to — so there is nothing here left to validate.

// =============================================================================
// SECTION 6 — AI TYPES
// =============================================================================

export type CopilotMessage = {
  role: "user" | "model";
  content: string;
};

/**
 * What the Patient Summary feature is allowed to send to the AI provider.
 *
 * `name` was here, and is gone. The dentist reading the summary already knows
 * whose record they opened; the model does not need to, and putting a name in
 * the prompt was the difference between sending a clinical history and sending
 * an IDENTIFIED clinical history to a service with no processing agreement.
 *
 * Age and last-visit are coarsened by the caller (lib/ai/redaction.ts) for the
 * same reason: an exact date of birth is a re-identification key, an age band
 * is a clinical fact.
 */
export type PatientSummaryContext = {
  /** Ten-year band, e.g. "30-39", or "unknown". Never a date of birth. */
  ageBand: string;
  gender: string | null;
  totalVisits: number;
  /** Month and year only, e.g. "March 2026". Never an exact timestamp. */
  lastVisit: string | null;
  outstandingBalance: string;
  treatments: Array<{
    treatmentType: string;
    status: string;
    performedAt: string | null;
    patientVisibleNotes: string | null;
  }>;
  followUps: Array<{
    notes: string | null;
    dueDate: string;
    status: string;
  }>;
};

export type InsightsContext = {
  today: string;
  clinicName: string;
  overdueFollowUpsCount: number;
  metrics: {
    totalAppointmentsToday: number;
    seenPatientsToday: number;
    noShowsToday: number;
    walkInsToday: number;
    revenueToday: number;
    revenueLastWeek: number;
    noShowsThisWeek: number;
    noShowsLastWeek: number;
    walkInsThisWeek: number;
    walkInsLastWeek: number;
    busiestHourThisWeek: string | null;
  };
};

export type CopilotSessionContext = {
  clinicName: string;
  userName: string;
  userRole: "dentist" | "receptionist";
  today: string;
};

export type ClinicInfo = {
  clinicName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  clinicHours: Record<string, { open: string | null; close: string | null; is_open: boolean }> | null;
};

// =============================================================================
// SECTION 7 — ANALYTICS TYPES
// =============================================================================

export type DashboardKPIs = {
  totalAppointmentsToday: number;
  seenPatientsToday: number;
  completionRateToday: number;
  waitingPatients: number;
  noShowsToday: number;
  /** Gross payments collected today. */
  revenueToday: number;
  newPatientsToday: number;
  walkInsToday: number;
};

export type AppointmentAnalytics = {
  byStatus: Array<{ status: AppointmentStatus; count: number; date: string }>;
  cancellationRate: Array<{ date: string; rate: number }>;
  noShowRate: Array<{ date: string; rate: number }>;
  averagePerDay: number;
  peakHours: Array<{ hour: number; dayOfWeek: number; count: number }>;
};

export type PatientAnalytics = {
  newPatientsOverTime: Array<{ date: string; count: number }>;
  returningVsNew: { returning: number; new: number };
  ageDistribution: Array<{ ageGroup: string; count: number }>;
  genderBreakdown: Array<{ gender: string; count: number }>;
  topPatients: Array<{ patientId: string; name: string; visits: number }>;
};

export type TreatmentAnalytics = {
  byType: Array<{ treatmentType: string; count: number }>;
  avgCostByType: Array<{ treatmentType: string; avgCost: number }>;
  completionRate: number;
  revenueByType: Array<{ treatmentType: string; revenue: number }>;
};

export type RevenueAnalytics = {
  overTime: Array<{ date: string; amount: number }>;
  byPaymentMethod: Array<{ method: PaymentMethod; amount: number }>;
  bySource: Array<{ source: AppointmentSource; amount: number }>;
  outstandingTotal: number;
  avgPerCompletedAppointment: number;
  momGrowth: number;
};

export type SourceAnalytics = {
  breakdown: Array<{ source: AppointmentSource; count: number }>;
  trendOverTime: Array<{ date: string; source: AppointmentSource; count: number }>;
  conversionBySource: Array<{
    source: AppointmentSource;
    booked: number;
    completed: number;
    noShow: number;
  }>;
};

export type FollowUpAnalytics = {
  pendingCount: number;
  overdueCount: number;
  completedOverTime: Array<{ date: string; count: number }>;
  completionRate: number;
  byTreatmentType: Array<{ treatmentType: string; count: number }>;
};

// =============================================================================
// SECTION 8 — SESSION / AUTH TYPES
// =============================================================================

/** Resolved from profiles table for staff (dentist + receptionist) */
export type SessionUser = {
  id: string;
  role: "dentist" | "receptionist";
  clinicId: string;
  fullName: string;
};

/** Resolved from patient_portal_links for portal users */
export type PortalUser = {
  id: string;          // auth.uid()
  patientId: string;   // patient_portal_links.patient_id
  clinicId: string;    // patients.clinic_id (derived via join)
};

/** Portal link status returned by checkPortalLinkStatus() */
export type PortalLinkStatus = "linked" | "unlinked" | "no_match";

// =============================================================================
// SECTION 9 — PATIENT CONSENT FORMS
// =============================================================================

// Row types
export type ConsentTemplate        = Database["public"]["Tables"]["consent_templates"]["Row"];
export type ConsentTemplateVersion = Database["public"]["Tables"]["consent_template_versions"]["Row"];
export type Consent                = Database["public"]["Tables"]["consents"]["Row"];
export type ConsentAudit           = Database["public"]["Tables"]["consent_audit"]["Row"];
/** Portal-safe consent projection (own signed consents only). */
export type PatientConsentView     = Database["public"]["Views"]["patient_consents"]["Row"];

/** Consent status — mirrors the consent_status DB enum. */
export const ConsentStatusEnum = {
  DRAFT: "draft",
  READY_TO_SIGN: "ready_to_sign",
  SIGNED: "signed",
  CANCELLED: "cancelled",
} as const;
export type ConsentStatusValue = (typeof ConsentStatusEnum)[keyof typeof ConsentStatusEnum];

/** Consent source — mirrors the consent_source DB enum. */
export const ConsentSourceEnum = {
  DIGITAL: "digital",
  UPLOADED: "uploaded",
} as const;
export type ConsentSourceValue = (typeof ConsentSourceEnum)[keyof typeof ConsentSourceEnum];

// ── Zod validation schemas ──────────────────────────────────────────────────

/** A single per-consent section edit (only editablePerConsent sections). */
export const ConsentSectionEditSchema = z.object({
  key: z.string().min(1).max(60),
  body: z.string().max(6000),
});
export type ConsentSectionEditInput = z.infer<typeof ConsentSectionEditSchema>;

/** Create a digital consent from a treatment. Content is built server-side from
 *  the selected template version; section_edits carries any patient-specific
 *  tailoring of the editable sections. */
export const CreateConsentSchema = z.object({
  patient_id: z.string().uuid(),
  treatment_id: z.string().uuid().optional().or(z.literal("")).transform((v) => v || undefined),
  appointment_id: z.string().uuid().optional().or(z.literal("")).transform((v) => v || undefined),
  template_key: z.string().min(1).max(60),
  section_edits: z.array(ConsentSectionEditSchema).max(40).optional(),
});
export type CreateConsentInput = z.infer<typeof CreateConsentSchema>;

/** Edit a draft consent's content and/or move it between draft/ready_to_sign. */
export const UpdateConsentSchema = z.object({
  section_edits: z.array(ConsentSectionEditSchema).max(40).optional(),
  status: z.enum(["draft", "ready_to_sign"]).optional(),
});
export type UpdateConsentInput = z.infer<typeof UpdateConsentSchema>;

/** Sign a digital consent — patient's typed name + drawn signature (PNG data URL). */
export const SignConsentSchema = z.object({
  patient_signed_name: z.string().min(2, "Please enter the patient's name").max(120),
  patient_signature: z
    .string()
    .min(1, "A signature is required")
    .refine((v) => v.startsWith("data:image/"), "Signature must be an image"),
});
export type SignConsentInput = z.infer<typeof SignConsentSchema>;

/** Metadata for uploading an externally-signed consent (the file travels as
 *  FormData; these fields identify what it is linked to). */
export const UploadConsentMetaSchema = z.object({
  patient_id: z.string().uuid(),
  treatment_id: z.string().uuid().optional().or(z.literal("")).transform((v) => v || undefined),
  appointment_id: z.string().uuid().optional().or(z.literal("")).transform((v) => v || undefined),
  template_key: z.string().min(1).max(60),
});
export type UploadConsentMetaInput = z.infer<typeof UploadConsentMetaSchema>;

/** Save an edit to a clinic's master consent template (creates a new version). */
export const UpdateConsentTemplateSchema = z.object({
  template_id: z.string().uuid(),
  name: z.string().min(1).max(160).optional(),
  consent_required: z.boolean().optional(),
  consent_recommended: z.boolean().optional(),
  is_active: z.boolean().optional(),
  // Full replacement content for a new version. Sections + disclaimer.
  content: z
    .object({
      disclaimer: z.string().max(4000),
      sections: z
        .array(
          z.object({
            key: z.string().min(1).max(60),
            title: z.string().min(1).max(160),
            body: z.string().max(6000),
            editablePerConsent: z.boolean(),
          })
        )
        .max(40),
    })
    .optional(),
});
export type UpdateConsentTemplateInput = z.infer<typeof UpdateConsentTemplateSchema>;

/**
 * Snoozing one Business Brain problem card.
 *
 * `days` is bounded at 90 deliberately. A snooze is a judgement about the clinic
 * as it is today, and a year-long one is indistinguishable from deleting the
 * check — the clinic would have changed underneath it long before it lapsed.
 * The floor of 1 stops a zero-day snooze, which would insert a row that suppresses
 * nothing and reads as a bug.
 *
 * `reason` is required. See `dismissProblem` for why: an unexplained snooze
 * cannot be reviewed later, and the reasons are what tell us which false
 * positives deserve a real schema fix.
 */
export const DismissProblemSchema = z.object({
  category: z.string().min(1).max(64),
  severityAtDismissal: z.enum(["info", "low", "medium", "high", "critical"]),
  reason: z.string().trim().min(3).max(500),
  days: z.number().int().min(1).max(90),
});
