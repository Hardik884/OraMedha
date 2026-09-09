/**
 * lib/__tests__/server-action-surface.spec.ts
 *
 * Bounds the set of functions that are reachable as HTTP endpoints.
 *
 * WHAT THIS CATCHES, AND WHY DELETING THE UI DOES NOT
 *   Every exported function in a `"use server"` module that reaches the client
 *   graph becomes a Server Action: Next.js assigns it a stable id and will
 *   execute it for any POST carrying that id and the `Next-Action` header. It
 *   is an endpoint, not a function.
 *
 *   `signUpPatient` is the case that motivated this file. The clinic-dropdown
 *   signup UI was replaced in 853e188 and nothing rendered the action any more
 *   — but it stayed exported, and the production build published it in the
 *   `action-browser` layer on ALL 65 routes. It accepted a browser-supplied
 *   clinic_id and called supabase.auth.signUp() with a caller-supplied address,
 *   which made it an unauthenticated, unthrottled way to send mail to anyone,
 *   burning the same provider quota real patients need to activate.
 *
 *   Nothing noticed, because "no component imports it" reads like "it is gone"
 *   and is not the same statement. Reviewing the diff that removed the form
 *   would not have shown it either. Only the build manifest says what is
 *   actually exposed.
 *
 * HOW IT WORKS
 *   `.next/server/server-reference-manifest.json` is written by `next build`
 *   and maps every action id to the module and export it resolves to. This spec
 *   reads that file and asserts the set of exported names matches ALLOWED
 *   exactly — in both directions:
 *
 *     - an action NOT in the list fails, which is the regression above;
 *     - a name in the list that is no longer an action also fails, so the list
 *       cannot rot into a wish list that quietly permits more than it names.
 *
 *   Same contract as lib/ai/__tests__/ai-surface.spec.ts, which pins the AI
 *   call sites for the same reason.
 *
 * WHEN THIS FAILS
 *   Adding a Server Action is normal and the fix is to add its name here. That
 *   is the point: the addition becomes a line in a diff someone reviews,
 *   instead of a side effect of an export.
 *
 *   It SKIPS when `.next` is absent, because the manifest only exists after a
 *   build. CI runs `next build` in the `static` job, and this spec is the
 *   reason the test job would otherwise miss it — so if you are running this
 *   locally, run `npm run build` first.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MANIFEST = path.join(
  process.cwd(),
  ".next",
  "server",
  "server-reference-manifest.json"
);

/**
 * Every function intentionally exposed as a Server Action.
 *
 * Grouped by module. A name here is a decision that this function may be
 * invoked by anything that can reach the app over HTTP, subject only to the
 * authorisation it performs itself.
 */
const ALLOWED: ReadonlySet<string> = new Set([
  // actions/ai.ts
  "generatePatientSummary",
  "generateInsights",
  "sendCopilotMessage",
  "sendPatientAssistantMessage",

  // actions/appointments.ts
  "createAppointment",
  "updateAppointmentStatus",
  "rescheduleAppointment",
  "cancelAppointment",
  "updateAppointmentNotes",
  "updateAppointmentClinical",
  "getAppointmentsToday",
  "getAppointment",
  "getAppointments",
  "getClinicDentist",

  // actions/auth.ts — signUpPatient is deliberately ABSENT. See the file header.
  "signInStaff",
  "signInPatient",
  "signInAdmin",
  "resendVerificationEmail",
  "abandonSignupEmail",
  "signOut",
  "requestPasswordReset",
  "updatePassword",

  // actions/availability.ts
  "getAvailabilityRules",
  "createAvailabilityRule",
  "updateAvailabilityRule",
  "toggleAvailabilityRule",
  "getAvailableSlots",

  // actions/billing.ts
  "getStaffBill",
  "getPatientBillsList",
  "getClinicBillsList",
  "getPortalBillsList",
  "getPortalTreatmentBill",

  // actions/business-brain.ts
  "explainDiagnosis",
  "recordMetricHistory",
  "dismissProblem",
  "summarizeDashboardActions",

  // actions/clinic-settings.ts
  "getClinicSettings",
  "checkReceptionistPaymentAccess",
  "updateClinicSettings",

  // actions/consent-templates.ts
  "ensureConsentTemplates",
  "getConsentTemplates",
  "getConsentTemplateContent",
  "updateConsentTemplate",

  // actions/consents.ts
  "createConsent",
  "updateConsentDraft",
  "signConsent",
  "cancelConsent",
  "uploadSignedConsent",
  "getConsentsForPatient",
  "getConsentsForTreatment",
  "getConsent",
  "getConsentFileUrl",
  "getPortalConsents",
  "getPortalConsentDetail",
  "getPortalConsentFileUrl",

  // actions/consultants.ts
  "getConsultants",
  "createConsultant",
  "updateConsultant",
  "deleteConsultant",
  "getConsultancyRevenueToday",
  "recordConsultancyIncome",
  "getConsultancyIncome",
  // Added with external-consultation slot booking: the fee and its paid flag
  // stay editable after the consultation is recorded, and the dashboard
  // Actions card counts the unpaid ones.
  "updateConsultancyIncome",
  "getUnpaidConsultationCount",
  "getConsultancySchedules",
  "createConsultancySchedule",
  "deleteConsultancySchedule",
  "getUnavailableDates",
  "createUnavailableDate",
  "deleteUnavailableDate",

  // actions/data-consent.ts
  "getMyDataConsents",
  "setMyDataConsent",
  "getPatientDataConsents",
  "recordDataConsentForPatient",

  // actions/data-export.ts
  "exportMyData",
  "exportPatientData",

  // actions/dental-chart.ts
  "getPatientDentalChart",
  "upsertToothState",
  "bulkUpdateTeeth",
  "getToothHistory",
  "linkTreatmentToTooth",
  "unlinkTreatmentFromTooth",

  // actions/follow-ups.ts
  "todayForClinic",
  "createFollowUp",
  "updateFollowUp",
  "completeFollowUp",
  "cancelFollowUp",
  "getFollowUp",
  "getFollowUpsForAppointment",
  "getFollowUpsForPatient",
  "getAllFollowUps",
  "getOverdueFollowUps",
  "getPatientAppointmentsForFollowUp",
  "getPatientTreatmentsForFollowUp",
  "getPatientPortalFollowUps",
  "getPortalToday",
  "getFollowUpStats",

  // actions/messaging.ts
  "getWhatsAppSendList",
  "getReminderSummaries",
  "markReminderSent",

  // actions/mfa.ts
  "getMfaState",
  "beginMfaEnrolment",
  "confirmMfaEnrolment",
  "startMfaChallenge",
  "completeMfaChallenge",
  "removeMfaFactor",

  // actions/patients.ts
  "createPatient",
  "updatePatient",
  "softDeletePatient",
  "searchPatients",
  "getPatient",
  "getPatients",
  "getOutstandingBalance",

  // actions/payments.ts
  "recordPayment",
  "getPaymentsForAppointment",
  "getPatientPayments",
  "getPortalPayments",
  "getPatientTreatmentCollections",
  "getPortalOutstandingBalance",
  "getPaymentsToday",
  "getPatientsWithOutstandingBalance",
  "getAllPayments",
  "getAppointmentPaymentStatuses",
  "getPaymentRecorderNames",
  "setPaymentPlan",

  // actions/portal-activation.ts
  "requestActivation",
  "verifyActivation",
  "completeActivation",

  // actions/portal-link.ts — linkPortalAccount is deliberately ABSENT.
  "getLinkedPatient",
  "checkPortalLinkStatus",
  "getPortalProfile",
  "updatePortalProfile",

  // actions/prescriptions.ts
  "getPrescriptions",
  "getDentistList",
  "getPatientPrescriptions",

  // actions/queue.ts
  "checkInPatient",
  "advanceQueue",
  "skipPatient",
  "getTodayQueue",
  "getQueueStatus",
  "getQueueMetrics",

  // actions/signature.ts
  "getMySignature",
  "uploadSignature",
  "deleteSignature",

  // actions/treatments.ts
  "createTreatment",
  "updateTreatment",
  "softDeleteTreatment",
  "getTreatment",
  "getTreatmentsForPatient",
  "getTreatmentsForAppointment",
  "getPatientTreatmentHistory",
  "getAllTreatments",
  "getPatientTreatments",
  "createTreatmentDocument",
  "uploadTreatmentDocument",
  "getTreatmentDocuments",
  "deleteTreatmentDocument",
  "getCurrentUserDisplayName",
  "uploadAppointmentDocument",
  "getAppointmentDocuments",
  "deleteAppointmentDocument",
  "getPatientsWithPlannedTreatmentNoVisit",
]);

/**
 * Names that must NEVER reappear. Redundant with the exact-match assertion, but
 * a deliberate belt-and-braces: if someone widens ALLOWED without reading the
 * header, this still fails and says why.
 */
const FORBIDDEN: ReadonlyArray<[string, string]> = [
  [
    "signUpPatient",
    "Self-registration with a browser-chosen clinic_id, and an unauthenticated mail-send primitive. Removed from actions/auth.ts.",
  ],
  [
    "linkPortalAccount",
    "Self-service portal linking that created patient records from a browser-supplied clinic + phone. Removed from actions/portal-link.ts.",
  ],
  [
    "getClinics",
    "Unauthenticated service-role read of every clinic on the platform. Fed the deleted clinic dropdown; removed with actions/clinics.ts.",
  ],
  [
    "getClinicById",
    "Validated a browser-supplied clinic id. Nothing supplies one any more; removed with actions/clinics.ts.",
  ],
];

const BUILT = existsSync(MANIFEST);

function actionExports(): Set<string> {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    node?: Record<string, { exportedName?: string }>;
    edge?: Record<string, { exportedName?: string }>;
  };

  const names = new Set<string>();
  for (const table of [manifest.node, manifest.edge]) {
    for (const entry of Object.values(table ?? {})) {
      if (entry.exportedName) names.add(entry.exportedName);
    }
  }
  return names;
}

describe.skipIf(!BUILT)("server action surface", () => {
  it("exposes no action that is not on the allow-list", () => {
    const unexpected = [...actionExports()].filter((n) => !ALLOWED.has(n)).sort();

    expect(
      unexpected,
      unexpected.length
        ? `These functions are reachable as HTTP endpoints but are not declared in ALLOWED:\n` +
            unexpected.map((n) => `  - ${n}`).join("\n") +
            `\n\nIf that is intended, add them to ALLOWED in this file. If it is not, ` +
            `remember that deleting the UI does not retire the endpoint — the export does.`
        : undefined
    ).toEqual([]);
  });

  it("has no stale entries on the allow-list", () => {
    const live = actionExports();
    const stale = [...ALLOWED].filter((n) => !live.has(n)).sort();

    expect(
      stale,
      stale.length
        ? `These names are on the allow-list but are no longer Server Actions:\n` +
            stale.map((n) => `  - ${n}`).join("\n") +
            `\n\nRemove them, so the list keeps describing what is actually exposed.`
        : undefined
    ).toEqual([]);
  });

  it.each(FORBIDDEN)("never re-exposes %s", (name, why) => {
    expect(actionExports().has(name), `${name} is exposed again. ${why}`).toBe(false);
  });
});
