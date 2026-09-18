/**
 * Feature Flags Configuration
 * 
 * Centralized feature toggles for the DentGrow application.
 * Change these flags to enable/disable features across the application.
 */

export const FEATURE_FLAGS = {
  /**
   * PATIENT_BOOKING_ENABLED
   * 
   * Controls whether patients can initiate appointment booking through:
   * - Patient Portal UI (Book Appointment buttons, CTAs)
   * - AI Chatbot appointment booking tools
   * 
   * When disabled:
   * - All patient-facing booking UI is hidden
   * - AI chatbot returns a friendly message for booking requests
   * - Server-side validation enforces the restriction
   * - All business logic and components remain intact
   * 
   * To re-enable patient booking: set to true
   * 
   * Staff (dentist/receptionist) booking is NOT affected by this flag.
   */
  PATIENT_BOOKING_ENABLED: false,
} as const;

/**
 * BUSINESS_BRAIN_CLINIC_IDS
 *
 * Clinics allowed to see the Business Brain dashboard.
 *
 * An explicit allow-list rather than a boolean: the Business Brain is a
 * development surface, and a global toggle would expose it to the pilot clinic
 * the moment anyone flipped it. Naming the clinics makes accidental exposure
 * impossible — a clinic that is not listed cannot reach the route at all
 * (the page returns 404, so it does not even acknowledge that it exists) and
 * never sees the navigation entry.
 *
 * Production clinics are deliberately absent:
 *   11111111-…  Dr. Liying's Dental Care  (live pilot)
 *   22222222-…  Clinic B
 */
export const BUSINESS_BRAIN_CLINIC_IDS: readonly string[] = [
  // My Dental Clinic — development / demo
  "00000000-0000-0000-0000-000000000001",
  // Demo Clinic (sample data) — generated records, for reviewing the analysis
  // against realistic volume. See DEMO_CLINIC_IDS below.
  "d0000000-0000-4000-8000-0000000000d0",
];

/** True when this clinic may access the Business Brain dashboard. */
export function isBusinessBrainEnabled(clinicId: string | null | undefined): boolean {
  return !!clinicId && BUSINESS_BRAIN_CLINIC_IDS.includes(clinicId);
}

/**
 * DEMO_CLINIC_IDS
 *
 * Clinics whose records are GENERATED, not real.
 *
 * The Business Brain cannot be reviewed against a clinic with three
 * appointments a month: every rate is noise, every baseline is too wide to flag
 * anything, and every gate correctly stays shut — so the feature looks broken
 * when it is working. `scripts/seed-demo-clinic.mjs` fills a clinic with nine
 * months of plausible activity instead.
 *
 * Named here for two reasons. Every surface that shows this clinic labels it as
 * sample data, so nobody mistakes a generated figure for their own; and the
 * seeder refuses to write to any clinic that is not on this list, so it can
 * never be pointed at a real one.
 */
export const DEMO_CLINIC_IDS: readonly string[] = [
  // Demo Clinic (sample data) — generated records, safe to delete and rebuild.
  "d0000000-0000-4000-8000-0000000000d0",
];

/** True when this clinic's records are generated sample data, not a real clinic's. */
export function isDemoClinic(clinicId: string | null | undefined): boolean {
  return !!clinicId && DEMO_CLINIC_IDS.includes(clinicId);
}

/**
 * WHATSAPP_ENABLED_CLINIC_IDS
 *
 * Clinics allowed to prepare WhatsApp reminders from the Morning Briefing.
 *
 * An allow-list, for the same reason as the Business Brain above: WhatsApp is a
 * documented MVP non-goal (CLAUDE.md §14) pending a compliance review, and there
 * is no patient-consent field in the schema yet. Naming the clinics keeps it a
 * deliberate, per-clinic pilot rather than a global switch someone can flip on
 * for everyone. A clinic not listed never sees the "Prepare WhatsApp reminders"
 * affordance.
 *
 * Note: the send path is wa.me click-to-send — DentGrow prepares the message and
 * a staff member sends it by hand. It never messages a patient on its own.
 */
export const WHATSAPP_ENABLED_CLINIC_IDS: readonly string[] = [
  // My Dental Clinic — development / demo
  "00000000-0000-0000-0000-000000000001",
];

/** True when this clinic may prepare WhatsApp reminders. */
export function isWhatsAppEnabled(clinicId: string | null | undefined): boolean {
  return !!clinicId && WHATSAPP_ENABLED_CLINIC_IDS.includes(clinicId);
}

/**
 * Helper to check if patient booking is enabled
 */
export function isPatientBookingEnabled(): boolean {
  return FEATURE_FLAGS.PATIENT_BOOKING_ENABLED;
}

/**
 * Message to display when patient booking is disabled
 */
export const PATIENT_BOOKING_DISABLED_MESSAGE =
  "Online appointment booking is temporarily unavailable during our pilot phase. Please contact your clinic directly to schedule an appointment.";
