"use server";

import { createServerClient } from "@/lib/supabase/server";
import {
  AIError,
  getGeminiModel,
  guardOutboundPrompt,
  withAITimeout,
} from "@/lib/ai/gemini";
import { ageBand, coarsenToMonth } from "@/lib/ai/redaction";
import { recordPhiAccess } from "@/lib/audit/phi-access";
import { isPatientBookingEnabled, PATIENT_BOOKING_DISABLED_MESSAGE } from "@/lib/feature-flags";
import {
  buildPatientSummaryPrompt,
  buildInsightsPrompt,
  buildCopilotSystemPrompt,
  buildPatientAssistantSystemPrompt,
} from "@/lib/ai/prompts";
import { ALL_COPILOT_TOOL_DECLARATIONS } from "@/lib/ai/tools";
import {
  ALL_PATIENT_TOOL_DECLARATIONS,
  getAvailableSlotsInputSchema,
  createAppointmentInputSchema,
  rescheduleAppointmentInputSchema,
  cancelAppointmentInputSchema,
  getQueueStatusInputSchema,
  getPatientAppointmentsInputSchema,
  getPatientTreatmentsInputSchema,
  getPatientPaymentsInputSchema,
  getClinicInformationInputSchema,
  type PatientToolName,
} from "@/lib/ai/patient-tools";
import type { ActionResult, CopilotMessage } from "@/types";
import { computeOutstandingBalance } from "@/lib/billing/balance";
import { getTodayInTimezone, getUtcBoundariesForLocalDate } from "@/lib/utils";
import { createAdminClient } from "@/lib/supabase/admin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

const AI_UNAVAILABLE =
  "AI features are temporarily unavailable. Please try again later.";

// Rate limiting — max messages per session tracked server-side via a simple
// in-memory counter (resets on server restart). For production use Redis.
const SESSION_COUNTERS = new Map<string, { count: number; resetAt: number }>();
const MAX_MESSAGES_PER_MINUTE = 20;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = SESSION_COUNTERS.get(userId);
  if (!entry || now > entry.resetAt) {
    SESSION_COUNTERS.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= MAX_MESSAGES_PER_MINUTE) return false;
  entry.count++;
  return true;
}

// ── Input guardrails ──────────────────────────────────────────────────────────
// Block messages that are clearly off-topic or potentially harmful.
const BLOCKED_PATTERNS = [
  /ignore (previous|all|prior) (instructions?|prompts?|system)/i,
  /you are now/i,
  /act as (a |an )?(different|new|other)/i,
  /jailbreak/i,
  /disregard/i,
  /forget (all|your|previous)/i,
];

const MAX_MESSAGE_LENGTH = 500;

function isMessageSafe(message: string): boolean {
  if (message.length > MAX_MESSAGE_LENGTH) return false;
  return !BLOCKED_PATTERNS.some((re) => re.test(message));
}

// Topics the assistant is allowed to discuss (dental + clinic + booking)
const ALLOWED_TOPIC_PATTERNS = [
  /appoint/i,
  /slot/i,
  /book/i,
  /cancel/i,
  /reschedul/i,
  /queue/i,
  /wait/i,
  /treatment/i,
  /payment/i,
  /follow.?up/i,
  /clinic/i,
  /hours?/i,
  /open/i,
  /close/i,
  /address/i,
  /phone/i,
  /contact/i,
  /dentist/i,
  /tooth|teeth/i,
  /dental/i,
  /clean/i,
  /crown/i,
  /root canal/i,
  /filling/i,
  /extraction/i,
  /implant/i,
  /bleach|whiten/i,
  /pain|ache|hurt/i,
  /hello|hi|hey|greet/i,
  /help/i,
  /thank/i,
  /yes|no|okay|ok|sure|confirm|cancel/i,
  /when|what|how|where|is|are|do|does|can|will|my|the/i,
];

function isTopicAllowed(message: string): boolean {
  const lower = message.toLowerCase().trim();
  // Very short responses (yes, no, numbers) are always allowed — part of confirmation flows
  if (lower.length <= 10) return true;
  return ALLOWED_TOPIC_PATTERNS.some((re) => re.test(lower));
}

// =============================================================================
// Backend-enforced confirmation for mutating appointment actions.
//
// State-changing tools (book / reschedule / cancel) must NEVER execute on the
// first call. The backend:
//   1. On a call WITHOUT a valid confirmationToken → stores a pending action
//      and returns requiresConfirmation + a server-issued token. No mutation.
//   2. On a call WITH a matching token → executes, but ONLY if the token was
//      issued in an EARLIER message turn (a different invocationId). This
//      guarantees a real patient confirmation turn happened between proposal
//      and execution — the model cannot self-confirm in a single turn.
//
// In-memory store (per-process, like the rate limiter). Adequate for the pilot.
// =============================================================================

type MutatingToolName =
  | "createAppointment"
  | "rescheduleAppointment"
  | "cancelAppointment";

type PendingAiAction = {
  token: string;
  toolName: MutatingToolName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>;
  createdInvocationId: string;
};

const PENDING_ACTION_TTL_MS = 10 * 60_000;

/*
 * Held in ai_pending_actions (20260907000300), not in a module-level Map.
 *
 * The Map was per-process. On more than one instance the token was frequently
 * absent when the patient confirmed — a different Lambda served the second turn
 * — so consumeConfirmedAction returned null, the model re-proposed, and the
 * patient was asked "shall I book it?" again. It failed CLOSED, so nothing was
 * ever mis-booked; the assistant simply could not complete a booking, and did
 * so intermittently depending on instance routing, which is the hardest kind of
 * bug to be told about.
 *
 * Written through the admin client because no client role may touch that table.
 * That is the point: a caller who could insert into it could mint its own
 * confirmation and defeat the two-turn rule entirely.
 */
function pendingStore() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any;
}

function newConfirmationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID
    ? c.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stores a pending mutating action and returns the confirmation token the
 * model must echo back (in a later turn) to execute it.
 *
 * Upserts on user_id: one outstanding proposal per patient, so a new proposal
 * replaces the last rather than leaving a stale token redeemable. Same
 * behaviour the single-entry Map had.
 */
async function proposeMutatingAction(
  userId: string,
  toolName: MutatingToolName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  invocationId: string
): Promise<string> {
  const token = newConfirmationId();

  const { error } = await pendingStore()
    .from("ai_pending_actions")
    .upsert(
      {
        user_id: userId,
        token,
        tool_name: toolName,
        args,
        created_invocation_id: invocationId,
        expires_at: new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (error) {
    // Nothing was stored, so the token cannot be redeemed. Say so rather than
    // handing back one that will never work — the caller turns this into
    // "please try again", which is recoverable; a silent dead token is not.
    console.error("[ai] could not store pending action:", error);
    throw new Error("Could not prepare that action. Please try again.");
  }

  return token;
}

/**
 * Validates and consumes a pending action. Returns the stored action only when
 * the token matches, has not expired, and was issued in an EARLIER turn.
 * Returns null otherwise (caller must then (re-)propose).
 *
 * The delete is part of the same statement as the match, so a token cannot be
 * redeemed twice by two concurrent requests.
 */
async function consumeConfirmedAction(
  userId: string,
  toolName: MutatingToolName,
  token: string | undefined,
  invocationId: string
): Promise<PendingAiAction | null> {
  if (!token) return null;

  const { data, error } = await pendingStore()
    .from("ai_pending_actions")
    .delete()
    .eq("user_id", userId)
    .eq("token", token)
    .eq("tool_name", toolName)
    // Must be confirmed in a LATER message turn than it was proposed. This is
    // what stops the model proposing and confirming inside one turn.
    .neq("created_invocation_id", invocationId)
    .gt("expires_at", new Date().toISOString())
    .select("token, tool_name, args, created_invocation_id")
    .maybeSingle();

  if (error) {
    console.error("[ai] could not consume pending action:", error);
    return null;
  }
  if (!data) return null;

  const row = data as {
    token: string;
    tool_name: MutatingToolName;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: Record<string, any>;
    created_invocation_id: string;
  };

  return {
    token: row.token,
    toolName: row.tool_name,
    args: row.args,
    createdInvocationId: row.created_invocation_id,
  };
}

// =============================================================================
// resolvePortalSession — resolves patient_id + clinic_id for portal users
// =============================================================================

type PortalSession = {
  db: DbClient;
  userId: string;
  patientId: string;
  clinicId: string;
};

async function resolvePortalSession(): Promise<PortalSession | null> {
  const supabase = await createServerClient();
  const db: DbClient = supabase;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: link } = await db
    .from("patient_portal_links")
    .select("patient_id, patients!inner(clinic_id)")
    .eq("user_id", user.id)
    .single();

  if (!link) return null;

  const row = link as {
    patient_id: string;
    patients: { clinic_id: string } | { clinic_id: string }[];
  };

  const clinicId = Array.isArray(row.patients)
    ? row.patients[0]?.clinic_id
    : row.patients?.clinic_id;

  if (!clinicId) return null;

  return { db, userId: user.id, patientId: row.patient_id, clinicId };
}

// =============================================================================
// executePatientTool — server-side tool execution (patient AI assistant)
// All DB access happens here. The model NEVER touches the DB.
// =============================================================================

async function executePatientTool(
  toolName: PatientToolName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  session: PortalSession,
  invocationId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { db, patientId, clinicId } = session;

  switch (toolName) {
    case "getAvailableSlots": {
      // Feature flag check — booking disabled
      if (!isPatientBookingEnabled()) {
        return { error: PATIENT_BOOKING_DISABLED_MESSAGE };
      }
      
      const input = getAvailableSlotsInputSchema.parse(args);
      // Reuse the existing server action — it handles auth internally
      const { getAvailableSlots } = await import("@/actions/availability");
      const result = await getAvailableSlots(input.date);
      if (result.error) return { error: result.error };
      const slots = result.data ?? [];
      if (slots.length === 0)
        return { message: "No available slots for that date.", slots: [] };
      return { slots, count: slots.length };
    }

    case "createAppointment": {
      // Feature flag check — booking disabled
      if (!isPatientBookingEnabled()) {
        return { error: PATIENT_BOOKING_DISABLED_MESSAGE };
      }
      
      const input = createAppointmentInputSchema.parse(args);
      const confirmed = await consumeConfirmedAction(
        session.userId,
        "createAppointment",
        input.confirmationToken,
        invocationId
      );

      if (!confirmed) {
        // Step 1 — propose only. No mutation happens here.
        const confirmationToken = await proposeMutatingAction(
          session.userId,
          "createAppointment",
          { scheduledAt: input.scheduledAt, notes: input.notes ?? null },
          invocationId
        );
        return {
          requiresConfirmation: true,
          action: "book",
          proposed: { scheduledAt: input.scheduledAt, notes: input.notes ?? null },
          confirmationToken,
          message:
            "Booking not yet made. Show the patient the proposed date/time and ask them to confirm. Only after they explicitly confirm, call createAppointment again with this confirmationToken.",
        };
      }

      // Step 2 — patient confirmed in an earlier turn. Execute the booking.
      const { createAppointment } = await import("@/actions/appointments");
      const result = await createAppointment({
        patient_id: patientId,
        scheduled_at: confirmed.args.scheduledAt,
        duration_minutes: 30,
        source: "website",
        chief_complaints: confirmed.args.notes ?? undefined,
      });
      if (result.error) return { error: result.error };
      return {
        success: true,
        appointmentId: result.data?.id,
        scheduledAt: result.data?.scheduled_at,
        message: "Appointment booked successfully.",
      };
    }

    case "rescheduleAppointment": {
      // Feature flag check — booking disabled (reschedule also disabled)
      if (!isPatientBookingEnabled()) {
        return { error: PATIENT_BOOKING_DISABLED_MESSAGE };
      }
      
      const input = rescheduleAppointmentInputSchema.parse(args);
      const confirmed = await consumeConfirmedAction(
        session.userId,
        "rescheduleAppointment",
        input.confirmationToken,
        invocationId
      );

      if (!confirmed) {
        const confirmationToken = await proposeMutatingAction(
          session.userId,
          "rescheduleAppointment",
          {
            appointmentId: input.appointmentId,
            newScheduledAt: input.newScheduledAt,
          },
          invocationId
        );
        return {
          requiresConfirmation: true,
          action: "reschedule",
          proposed: {
            appointmentId: input.appointmentId,
            newScheduledAt: input.newScheduledAt,
          },
          confirmationToken,
          message:
            "Reschedule not yet applied. Confirm the new date/time with the patient, then call rescheduleAppointment again with this confirmationToken.",
        };
      }

      const { rescheduleAppointment } = await import("@/actions/appointments");
      const result = await rescheduleAppointment({
        appointment_id: confirmed.args.appointmentId,
        new_scheduled_at: confirmed.args.newScheduledAt,
      });
      if (result.error) return { error: result.error };
      return {
        success: true,
        message: "Appointment rescheduled successfully.",
        newScheduledAt: result.data?.scheduled_at,
      };
    }

    case "cancelAppointment": {
      const input = cancelAppointmentInputSchema.parse(args);
      const confirmed = await consumeConfirmedAction(
        session.userId,
        "cancelAppointment",
        input.confirmationToken,
        invocationId
      );

      if (!confirmed) {
        const confirmationToken = await proposeMutatingAction(
          session.userId,
          "cancelAppointment",
          { appointmentId: input.appointmentId },
          invocationId
        );
        return {
          requiresConfirmation: true,
          action: "cancel",
          proposed: { appointmentId: input.appointmentId },
          confirmationToken,
          message:
            "Cancellation not yet performed. Confirm with the patient that they want to cancel, then call cancelAppointment again with this confirmationToken.",
        };
      }

      const { cancelAppointment } = await import("@/actions/appointments");
      const result = await cancelAppointment(confirmed.args.appointmentId);
      if (result.error) return { error: result.error };
      return { success: true, message: "Appointment cancelled successfully." };
    }

    case "getQueueStatus": {
      getQueueStatusInputSchema.parse(args);
      const { getQueueStatus } = await import("@/actions/queue");
      const result = await getQueueStatus(patientId);
      if (result.error) return { error: result.error };
      if (!result.data || result.data.position === null) {
        return { inQueue: false, message: "You are not currently in the queue." };
      }
      return {
        inQueue: true,
        position: result.data.position,
        patientsAhead: result.data.patientsAhead,
        estimatedWaitMinutes: result.data.estimatedWaitMinutes,
        currentQueueNumber: result.data.currentQueueNumber,
        status: result.data.myStatus,
      };
    }

    case "getPatientAppointments": {
      getPatientAppointmentsInputSchema.parse(args);
      const { data, error } = await db
        .from("appointments")
        .select("id, scheduled_at, status, notes, duration_minutes")
        .eq("patient_id", patientId)
        .is("deleted_at", null)
        .order("scheduled_at", { ascending: false })
        .limit(10);
      if (error) return { error: "Failed to fetch appointments." };
      const upcoming = (data ?? []).filter(
        (a: { status: string; scheduled_at: string }) =>
          ["scheduled", "checked_in"].includes(a.status) &&
          new Date(a.scheduled_at) >= new Date()
      );
      const past = (data ?? []).filter(
        (a: { status: string; scheduled_at: string }) =>
          a.status === "completed" || new Date(a.scheduled_at) < new Date()
      );
      return {
        upcoming: upcoming.slice(0, 5),
        past: past.slice(0, 5),
        total: (data ?? []).length,
      };
    }

    case "getPatientTreatments": {
      getPatientTreatmentsInputSchema.parse(args);
      const { data, error } = await db
        .from("patient_treatments")
        .select("id, treatment_type, patient_visible_notes, cost, opd_charged, opd_fee, status, performed_at"
        )
        .order("performed_at", { ascending: false })
        .limit(10);
      if (error) return { error: "Failed to fetch treatments." };
      return { treatments: data ?? [], total: (data ?? []).length };
    }

    case "getPatientPayments": {
      getPatientPaymentsInputSchema.parse(args);
      const [paymentsResult, treatmentsResult] = await Promise.all([
        db
          .from("payments")
          .select("id, amount, method, payment_date, notes")
          .eq("patient_id", patientId)
          .is("deleted_at", null)
          .order("payment_date", { ascending: false })
          .limit(10),
        db
          .from("treatments")
          .select("cost, opd_charged, opd_fee, xray_taken, xray_cost, status")
          .eq("patient_id", patientId)
          .is("deleted_at", null),
      ]);
      return {
        payments: paymentsResult.data ?? [],
        outstandingBalance: computeOutstandingBalance(
          (treatmentsResult.data ?? []) as { cost: number; status: string }[],
          (paymentsResult.data ?? []) as { amount: number }[]
        ),
        currency: "₹",
      };
    }

    case "getClinicInformation": {
      getClinicInformationInputSchema.parse(args);
      const { data, error } = await db
        .from("clinic_settings")
        .select(
          "clinic_name, phone, email, address, clinic_hours, average_appointment_duration"
        )
        .eq("clinic_id", clinicId)
        .maybeSingle();
      if (error || !data) return { error: "Failed to fetch clinic information." };
      return data;
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// =============================================================================
// generatePatientSummary — dentist only
// =============================================================================

export async function generatePatientSummary(
  patientId: string
): Promise<ActionResult<string>> {
  try {
    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    const { data: profile } = await db
      .from("profiles")
      .select("clinic_id, role")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "dentist")
      return { data: null, error: "Forbidden" };

    const [patientRes, treatmentsRes, followUpsRes] = await Promise.all([
      db
        // `name` is deliberately NOT selected. It was read only to be
        // interpolated into the outbound prompt, and the prompt no longer
        // carries one — so the safest place to drop it is here, where it is
        // never loaded into the process at all.
        .from("patients")
        .select("date_of_birth, gender, total_visits, last_visit")
        .eq("id", patientId)
        .eq("clinic_id", profile.clinic_id)
        .is("deleted_at", null)
        .single(),
      db
        .from("treatments")
        .select("treatment_type, patient_visible_notes, cost, opd_charged, opd_fee, status, performed_at")
        .eq("patient_id", patientId)
        .is("deleted_at", null)
        .order("performed_at", { ascending: false })
        .limit(10),
      db
        .from("follow_ups")
        .select("notes, due_date, status")
        .eq("patient_id", patientId)
        .eq("status", "pending")
        .is("deleted_at", null)
        .order("due_date", { ascending: true })
        .limit(5),
    ]);

    if (!patientRes.data) return { data: null, error: "Patient not found." };

    const p = patientRes.data as {
      date_of_birth: string | null;
      gender: string | null;
      total_visits: number;
      last_visit: string | null;
    };

    const age = p.date_of_birth
      ? new Date().getFullYear() - new Date(p.date_of_birth).getFullYear()
      : null;

    const [txCostRes, paymentRes] = await Promise.all([
      db
        .from("treatments")
        .select("cost, opd_charged, opd_fee, xray_taken, xray_cost, status")
        .eq("patient_id", patientId)
        .is("deleted_at", null),
      db
        .from("payments")
        .select("amount")
        .eq("patient_id", patientId)
        .is("deleted_at", null),
    ]);

    const balance = computeOutstandingBalance(
      (txCostRes.data ?? []) as { cost: number; status: string }[],
      (paymentRes.data ?? []) as { amount: number }[]
    );

    // Assembling a patient's clinical and financial position for transmission
    // to a third-party model is a read of that record, and one worth being able
    // to account for. Recorded whether or not the provider then succeeds.
    await recordPhiAccess(
      { id: user.id, clinic_id: profile.clinic_id, role: profile.role },
      {
        event: "AI_CONTEXT_PREPARED",
        resourceType: "patient",
        resourceId: patientId,
        patientId,
        context: { feature: "patient-summary", count: (treatmentsRes.data ?? []).length },
      }
    );

    const prompt = guardOutboundPrompt(
      buildPatientSummaryPrompt({
        ageBand: ageBand(age),
        gender: p.gender,
        totalVisits: p.total_visits,
        lastVisit: coarsenToMonth(p.last_visit),
        outstandingBalance: `₹${balance.toFixed(2)}`,
        treatments: (treatmentsRes.data ?? []).map(
          (t: {
            treatment_type: string;
            status: string;
            performed_at: string | null;
            patient_visible_notes: string | null;
          }) => ({
            treatmentType: t.treatment_type,
            status: t.status,
            performedAt: t.performed_at,
            patientVisibleNotes: t.patient_visible_notes,
          })
        ),
        followUps: (followUpsRes.data ?? []).map(
          (f: { notes: string | null; due_date: string; status: string }) => ({
            notes: f.notes,
            dueDate: f.due_date,
            status: f.status,
          })
        ),
      })
    );

    const model = getGeminiModel();
    const result = await withAITimeout(async () => {
      const response = await model.generateContent(prompt);
      return response.response.text();
    });

    return { data: result, error: null };
  } catch (error) {
    if (error instanceof AIError)
      return { data: null, error: AI_UNAVAILABLE };
    return { data: null, error: AI_UNAVAILABLE };
  }
}

// =============================================================================
// generateInsights — dentist only
// =============================================================================

export async function generateInsights(): Promise<ActionResult<string[]>> {
  try {
    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    const { data: profile } = await db
      .from("profiles")
      .select("clinic_id, role")
      .eq("id", user.id)
      .single();

    if (!profile || profile.role !== "dentist")
      return { data: null, error: "Forbidden" };

    const cid = profile.clinic_id;
    const now = new Date();

    // Resolve the clinic timezone so "today" and the week windows line up with
    // the rest of the app (dashboard KPIs, queue) instead of drifting by the
    // UTC offset for clinics behind/ahead of UTC.
    const { data: tzRow } = await db
      .from("clinic_settings")
      .select("timezone")
      .eq("clinic_id", cid)
      .maybeSingle();
    const tz = (tzRow as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";

    const todayStr = getTodayInTimezone(tz);
    const { start: todayStart, end: todayEnd } = getUtcBoundariesForLocalDate(
      todayStr,
      tz
    );

    // Week windows: this-week = last 7 days, last-week = the 7 days before that.
    const dayMs = 86400000;
    const sevenDaysAgoIso = new Date(now.getTime() - 7 * dayMs).toISOString();
    const fourteenDaysAgoIso = new Date(now.getTime() - 14 * dayMs).toISOString();
    const sevenDaysAgoDate = sevenDaysAgoIso.split("T")[0];
    const fourteenDaysAgoDate = fourteenDaysAgoIso.split("T")[0];

    const [
      todayAppts,
      thisWeekAppts,
      lastWeekAppts,
      todayPayments,
      lastWeekPayments,
      thisWeekPayments,
      overdueRes,
      settingsRes,
    ] = await Promise.all([
      db
        .from("appointments")
        .select("status, source")
        .eq("clinic_id", cid)
        .gte("scheduled_at", todayStart)
        .lte("scheduled_at", todayEnd)
        .is("deleted_at", null),
      db
        .from("appointments")
        .select("status, source")
        .eq("clinic_id", cid)
        .gte("scheduled_at", sevenDaysAgoIso)
        .is("deleted_at", null),
      db
        .from("appointments")
        .select("status, source")
        .eq("clinic_id", cid)
        .gte("scheduled_at", fourteenDaysAgoIso)
        .lt("scheduled_at", sevenDaysAgoIso)
        .is("deleted_at", null),
      db
        .from("payments")
        .select("amount")
        .eq("clinic_id", cid)
        .eq("payment_date", todayStr)
        .is("deleted_at", null),
      db
        .from("payments")
        .select("amount")
        .eq("clinic_id", cid)
        .gte("payment_date", fourteenDaysAgoDate)
        .lt("payment_date", sevenDaysAgoDate)
        .is("deleted_at", null),
      db
        .from("payments")
        .select("amount")
        .eq("clinic_id", cid)
        .gte("payment_date", sevenDaysAgoDate)
        .is("deleted_at", null),
      db
        .from("follow_ups")
        .select("id")
        .eq("clinic_id", cid)
        .eq("status", "pending")
        .lt("due_date", todayStr)
        .is("deleted_at", null),
      db
        .from("clinic_settings")
        .select("clinic_name")
        .eq("clinic_id", cid)
        .maybeSingle(),
    ]);

    const appts = (todayAppts.data ?? []) as { status: string; source: string }[];
    const weekAppts = (thisWeekAppts.data ?? []) as { status: string; source: string }[];
    const prevWeekAppts = (lastWeekAppts.data ?? []) as { status: string; source: string }[];

    const sumAmount = (rows: { amount: number }[] | null | undefined) =>
      (rows ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0);

    const revenueToday = sumAmount(todayPayments.data as { amount: number }[] | null);
    const revenueLastWeek = sumAmount(
      lastWeekPayments.data as { amount: number }[] | null
    );
    const revenueThisWeek = sumAmount(
      thisWeekPayments.data as { amount: number }[] | null
    );

    // Aggregates only: counts, sums and comparisons over the clinic's own day.
    // No patient row reaches this prompt, which is why it needs no waiver — the
    // guard would reject it if one ever did.
    const insightsPrompt = guardOutboundPrompt(
      buildInsightsPrompt({
        today: todayStr,
        clinicName:
          (settingsRes.data as { clinic_name?: string } | null)?.clinic_name ??
          "the clinic",
        overdueFollowUpsCount: (overdueRes.data ?? []).length,
        metrics: {
          totalAppointmentsToday: appts.length,
          seenPatientsToday: appts.filter((a) => a.status === "completed").length,
          noShowsToday: appts.filter((a) => a.status === "no_show").length,
          walkInsToday: appts.filter((a) => a.source === "walk_in").length,
          revenueToday,
          revenueLastWeek,
          noShowsThisWeek: weekAppts.filter((a) => a.status === "no_show").length,
          noShowsLastWeek: prevWeekAppts.filter((a) => a.status === "no_show").length,
          walkInsThisWeek: weekAppts.filter((a) => a.source === "walk_in").length,
          walkInsLastWeek: prevWeekAppts.filter((a) => a.source === "walk_in").length,
          busiestHourThisWeek: null,
        },
        // Add revenue comparison
        // @ts-expect-error — extra context field
        revenueThisWeek,
      })
    );

    const model = getGeminiModel();
    const result = await withAITimeout(async () => {
      const response = await model.generateContent(insightsPrompt);
      return response.response.text();
    });

    const insights = result
      .split("\n")
      .map((line) => line.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean);

    return { data: insights, error: null };
  } catch (error) {
    if (error instanceof AIError) return { data: null, error: AI_UNAVAILABLE };
    return { data: null, error: AI_UNAVAILABLE };
  }
}

// =============================================================================
// sendCopilotMessage — dentist + receptionist (stub — kept for future impl)
// =============================================================================

export async function sendCopilotMessage(
  history: CopilotMessage[],
  message: string
): Promise<ActionResult<CopilotMessage>> {
  try {
    void history;
    void message;
    void ALL_COPILOT_TOOL_DECLARATIONS;
    void buildCopilotSystemPrompt;

    return {
      data: {
        role: "model",
        content:
          "Copilot is coming soon. Use the dashboard sections to access your clinic data.",
      },
      error: null,
    };
  } catch {
    return { data: null, error: AI_UNAVAILABLE };
  }
}

// =============================================================================
// sendPatientAssistantMessage — portal patients only
// Full tool-calling loop with Gemini.
// =============================================================================

export async function sendPatientAssistantMessage(
  history: CopilotMessage[],
  message: string
): Promise<ActionResult<CopilotMessage>> {
  try {
    // ── Guardrails ────────────────────────────────────────────────────────
    if (!isMessageSafe(message)) {
      return {
        data: {
          role: "model",
          content:
            "I can only help with appointment booking, clinic information, and dental-related questions. Please contact the clinic directly for other requests.",
        },
        error: null,
      };
    }

    if (!isTopicAllowed(message)) {
      return {
        data: {
          role: "model",
          content:
            "I'm your dental clinic assistant. I can help you with appointments, queue status, treatment history, payments, and clinic information. Is there something I can help you with today?",
        },
        error: null,
      };
    }

    // ── Auth — portal patients only ───────────────────────────────────────
    const session = await resolvePortalSession();
    if (!session) {
      return { data: null, error: "Please log in to use the assistant." };
    }

    // ── Rate limiting ─────────────────────────────────────────────────────
    if (!checkRateLimit(session.userId)) {
      return {
        data: {
          role: "model",
          content: "You're sending messages too quickly. Please wait a moment.",
        },
        error: null,
      };
    }

    // ── Fetch clinic info for the system prompt ───────────────────────────
    const { data: clinicSettings } = await session.db
      .from("clinic_settings")
      .select("clinic_name, phone, email, address, clinic_hours, timezone")
      .eq("clinic_id", session.clinicId)
      .maybeSingle();

    const timezone =
      (clinicSettings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";

    const clinicInfo = {
      clinicName:
        (clinicSettings as { clinic_name?: string } | null)?.clinic_name ??
        "your dental clinic",
      phone:
        (clinicSettings as { phone?: string } | null)?.phone ?? null,
      email:
        (clinicSettings as { email?: string } | null)?.email ?? null,
      address:
        (clinicSettings as { address?: string } | null)?.address ?? null,
      clinicHours:
        (clinicSettings as { clinic_hours?: Record<string, { open: string | null; close: string | null; is_open: boolean }> } | null)
          ?.clinic_hours ?? null,
    };

    // ── Build current date/time context for the AI (Asia/Kolkata timezone) ──
    const now = new Date();

    // Get current time in clinic timezone (HH:MM format)
    const currentTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);

    // Build full readable date for the prompt (e.g., "22 June 2026")
    const currentDateReadable = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(now);

    const currentContext = {
      currentDate: currentDateReadable,
      currentTime: `${currentTime} IST`,
      timezone,
    };

    const model = getGeminiModel();

    // A unique id for THIS message turn. Used to enforce that a mutating
    // action proposed during this turn cannot be confirmed within the same
    // turn — the patient must reply (a new turn) to confirm.
    const invocationId = newConfirmationId();

    const result = await withAITimeout(
      async () => {
        // Tool declarations — FunctionDeclarationsTool[] shape required by SDK
        const tools = [{ functionDeclarations: ALL_PATIENT_TOOL_DECLARATIONS }];

        // systemInstruction as Content object: role "system" + parts array.
        // This is the format required by gemini-3.1-flash-lite.
        //
        // The clinic's OWN phone number and email are in this prompt on
        // purpose: answering "what is the clinic's number" is one of the things
        // the assistant exists for, and that information is published by the
        // clinic anyway. Those two identifier rules are therefore waived here
        // and nowhere else. Secrets are never waivable, and a PATIENT's contact
        // details would still be rejected — nothing puts them in this prompt.
        const systemInstruction = {
          role: "system",
          parts: [
            {
              text: guardOutboundPrompt(
                buildPatientAssistantSystemPrompt(clinicInfo, currentContext),
                ["phone-number", "email-address"]
              ),
            },
          ],
        };

        // History: only include user/model turns (never system).
        // Filter out any empty content to avoid API rejection.
        const chatHistory = history
          .slice(-10)
          .filter((m) => m.content.trim().length > 0)
          .map((m) => ({
            role: m.role,
            parts: [{ text: m.content }],
          }));

        // Start chat with system instruction and history
        const chat = model.startChat({
          systemInstruction,
          tools,
          history: chatHistory,
        });

        // Send the user message
        let response = await chat.sendMessage(message);
        let candidate = response.response;

        // Tool-call loop — max 5 iterations to prevent infinite loops
        let iterations = 0;
        while (iterations < 5) {
          iterations++;

          const functionCalls = candidate.functionCalls();
          if (!functionCalls || functionCalls.length === 0) break;

          // Execute all requested tool calls
          const toolResults = await Promise.all(
            functionCalls.map(async (fc) => {
              const toolName = fc.name as PatientToolName;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const toolArgs = (fc.args as Record<string, any>) ?? {};

              try {
                const toolResult = await executePatientTool(
                  toolName,
                  toolArgs,
                  session,
                  invocationId
                );
                return {
                  functionResponse: {
                    name: toolName,
                    response: toolResult,
                  },
                };
              } catch (err) {
                const msg =
                  err instanceof Error ? err.message : "Tool execution failed";
                return {
                  functionResponse: {
                    name: toolName,
                    response: { error: msg },
                  },
                };
              }
            })
          );

          // Send tool results back to the model as function response parts
          const toolResponseParts = toolResults.map((r) => ({
            functionResponse: r.functionResponse,
          }));

          response = await chat.sendMessage(toolResponseParts);
          candidate = response.response;
        }

        const text = candidate.text();
        return text || "I'm here to help. What would you like to do?";
      },
      15_000 // 15s for tool-call loops
    );

    return { data: { role: "model", content: result }, error: null };
  } catch (error) {
    if (error instanceof AIError) {
      console.error("[sendPatientAssistantMessage] AIError:", error.message, error.cause);
      return { data: null, error: AI_UNAVAILABLE };
    }
    console.error("[sendPatientAssistantMessage] unexpected:", error);
    return { data: null, error: AI_UNAVAILABLE };
  }
}
