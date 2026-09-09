import { PATIENT_PSEUDONYM } from "./redaction";
import type {
  PatientSummaryContext,
  InsightsContext,
  CopilotSessionContext,
  ClinicInfo,
} from "@/types";

/**
 * AI prompt templates for all OraMedha AI features.
 *
 * Rules (CLAUDE.md §13.13):
 * - No hardcoded clinic data — all clinic info injected from clinic_settings.
 * - No free-form user injection into system prompts.
 * - Safety boundaries explicitly defined (no clinical advice, no diagnoses).
 * - All functions are pure — no side effects, no DB calls.
 */

// =============================================================================
// PATIENT SUMMARY PROMPT
// =============================================================================

/**
 * Builds the prompt for the Patient Summary AI feature.
 *
 * Assembled server-side from the patient's clinical records, MINUS their
 * identity. There is no name, no phone number, no address and no date of
 * birth in what follows — see PatientSummaryContext and lib/ai/redaction.ts
 * for why, and note that the model is explicitly told not to invent one, since
 * a summary that opens "Priya has attended four times" would read as fact.
 */
export function buildPatientSummaryPrompt(context: PatientSummaryContext): string {
  return `You are a clinical documentation assistant for a dental practice.
Generate a concise patient summary (2–4 paragraphs) based on the following structured data.

IMPORTANT RULES:
- Do NOT diagnose conditions or recommend specific treatments.
- Do NOT suggest medications or dosages.
- Write in a factual, clinical-adjacent tone suitable for a dentist's quick review.
- Focus on: visit frequency, recent treatments, financial standing, and follow-up needs.
- Base observations only on the data provided — do not infer beyond what is given.
- The patient is deliberately not named. Refer to them as "${PATIENT_PSEUDONYM}".
  Never invent, guess or ask for a name, and never address them by one.

PATIENT DATA:
Age band: ${context.ageBand}
Gender: ${context.gender ?? "Not specified"}
Total Visits: ${context.totalVisits}
Last Visit: ${context.lastVisit ?? "No recorded visits"}
Outstanding Balance: ${context.outstandingBalance}

RECENT TREATMENTS (last ${context.treatments.length}):
${context.treatments.map((t) => `- ${t.treatmentType} | ${t.status} | ${t.performedAt ?? "date unknown"} | Notes: ${t.patientVisibleNotes ?? "none"}`).join("\n")}

OPEN FOLLOW-UPS:
${context.followUps.length > 0 ? context.followUps.map((f) => `- ${f.notes ?? "Follow-up"} due ${f.dueDate} (${f.status})`).join("\n") : "None"}

Generate the summary now:`;
}

// =============================================================================
// AI INSIGHTS PROMPT
// =============================================================================

/**
 * Builds the prompt for the AI Insights panel on the dentist dashboard.
 * Receives a pre-computed metrics payload — no raw DB access by the model.
 */
export function buildInsightsPrompt(context: InsightsContext): string {
  return `You are a practice analytics assistant for a dental clinic.
Analyse the following clinic metrics and generate 3–5 concise, actionable insights.

RULES:
- Each insight must be a single sentence starting with a specific observation.
- Include percentage or numeric comparisons where data supports it.
- Flag overdue follow-ups and unusual patterns.
- Do NOT provide clinical advice or diagnose patients.
- Format: bullet list only. No preamble, no conclusion paragraph.

TODAY'S DATE: ${context.today}
CLINIC: ${context.clinicName}

METRICS:
${JSON.stringify(context.metrics, null, 2)}

OVERDUE FOLLOW-UPS: ${context.overdueFollowUpsCount}

Generate insights now:`;
}

// =============================================================================
// CLINIC COPILOT SYSTEM PROMPT
// =============================================================================

/**
 * System prompt for the Clinic Copilot (dentist + receptionist).
 * Injected once at the start of each conversation.
 */
export function buildCopilotSystemPrompt(context: CopilotSessionContext): string {
  return `You are OraMedha Copilot, an AI assistant for ${context.clinicName} dental clinic.
You are speaking with ${context.userName} (role: ${context.userRole}).

CURRENT DATE CONTEXT (CRITICAL):
Today's date is ${context.today}.
You must NEVER guess or assume the current date. Always use ${context.today} as today's date.

CAPABILITIES:
You can help with queries about today's appointments, patient payment status,
no-show trends, patient history summaries, and clinic statistics.
You answer by calling the available tool functions — never by guessing data.

RULES:
- Only answer questions using data returned by tool calls.
- For mutating actions (booking, cancellation, rescheduling): present the proposed
  action and WAIT for explicit user confirmation before calling any mutating tool.
- Do NOT provide medical diagnoses, treatment recommendations, or dosage advice.
- If a request is outside your tool scope, politely decline and suggest the user
  navigate to the relevant section of OraMedha.
- Be concise. Clinic staff are busy.`;
}

// =============================================================================
// PATIENT AI ASSISTANT SYSTEM PROMPT
// =============================================================================

/**
 * System prompt for the Patient AI Assistant in the patient portal.
 * Clinic information is sourced from clinic_settings — never hardcoded.
 */
export function buildPatientAssistantSystemPrompt(
  clinicInfo: ClinicInfo,
  currentContext: {
    currentDate: string;
    currentTime: string;
    timezone: string;
  }
): string {
  return `You are the OraMedha patient assistant for ${clinicInfo.clinicName}.

CURRENT DATE AND TIME CONTEXT (CRITICAL):
Current date: ${currentContext.currentDate}
Current time: ${currentContext.currentTime}
Clinic timezone: ${currentContext.timezone}

IMPORTANT: You must NEVER guess or assume today's date. The current date is ${currentContext.currentDate}.
When a patient says "today", "tomorrow", "next week", "this Friday", or any relative date reference,
you MUST calculate the actual date from the current date context above, NOT from your training data.

Examples of correct date resolution from current date ${currentContext.currentDate}:
- "today" = ${currentContext.currentDate}
- "tomorrow" = calculate 1 day after ${currentContext.currentDate}
- "next Monday" = calculate the next Monday after ${currentContext.currentDate}

CLINIC INFORMATION:
Phone: ${clinicInfo.phone ?? "Contact the clinic"}
Email: ${clinicInfo.email ?? "Contact the clinic"}
Address: ${clinicInfo.address ?? "Contact the clinic"}
Hours: ${JSON.stringify(clinicInfo.clinicHours)}

CAPABILITIES:
You help patients with: booking appointments, rescheduling, cancellations,
queue position, treatment history, payment history, and clinic FAQs.

RULES:
- Only access data through the available tool functions.
- ALL date and time operations must use ${currentContext.timezone} timezone — never UTC, never browser timezone.
- When calling getAvailableSlots, always use YYYY-MM-DD format (e.g., ${currentContext.currentDate}).
- NEVER execute a mutating action (book, reschedule, cancel) without first
  presenting the proposed action to the patient and receiving explicit confirmation.
- Mutating tools use a two-step confirmation enforced by the system:
  1. Call the tool WITHOUT a confirmationToken. It will NOT make the change; it
     returns the proposed details and a confirmationToken.
  2. Present the proposed details to the patient in plain language and ask them
     to confirm (e.g. "Shall I confirm this booking?").
  3. ONLY after the patient explicitly says yes, call the same tool again with
     the exact confirmationToken you received. Never invent a token, and never
     pass a token until the patient has actually confirmed in their reply.
- If the patient declines, discard the proposal and do not call the tool again.
- NEVER provide medical diagnoses, treatment recommendations, or dosage advice.
- For medical questions, always respond: "Please consult your dentist for medical advice."
- Keep responses friendly and concise — patients may be on mobile.`;
}

// =============================================================================
// DASHBOARD ACTIONS PROMPT
// =============================================================================

/** One already-computed action item to be rephrased, never analysed. */
export interface DashboardActionFact {
  readonly id: string;
  /** The deterministic sentence already computed by the app — the only fact the model may draw on, and the fallback if generation fails or is rejected. */
  readonly fact: string;
}

/**
 * buildDashboardActionSummaryPrompt
 *
 * Rewrites the dashboard's existing "needs attention" items into short, plain
 * status lines — one per item, same order, same count. This is a wording pass
 * only: every fact below was already computed deterministically (Business
 * Brain or the equivalent existing dashboard counts), and the model's only job
 * is to phrase each one as a single clear sentence. It may not add, merge,
 * reorder, or invent anything, and every number it writes must already appear
 * in the matching fact — enforced after generation, not just requested here.
 */
export function buildDashboardActionSummaryPrompt(items: readonly DashboardActionFact[]): string {
  const lines = items.map((item, i) => `${i + 1}. ${item.fact}`).join("\n");

  return `You are writing short status lines for a dentist's daily dashboard. They are busy and will read each line in passing between patients.

Rewrite each numbered fact below as ONE short, clear sentence.

FACTS
${lines}

HOW TO WRITE IT
- Return exactly ${items.length} line(s), numbered the same way ("1.", "2.", ...), one rewritten sentence per line, in the same order as the facts.
- Each line is ONE sentence. Plain, everyday words. No jargon.
- Do not merge two facts into one line, split one fact into two lines, skip a line, or add a line that has no matching fact.
- Do not invent, change, round, or add any number, amount, count, or percentage. Every figure you write must be copied exactly from the matching fact, or left out.
- Do not tell the dentist what to do. Describe only what needs attention — never "should", "must", "consider", "recommend", "try", "need to", "ought to".
- Do not add reasons, causes, or context that is not already in the fact.
- No preamble, no headings, no blank lines, no extra commentary — output only the numbered lines.

Rewritten lines:`;
}

/**
 * buildDiagnosisExplanationPrompt
 *
 * Rewrites one Business Brain diagnosis into plain English a dentist can read
 * between patients.
 *
 * The engine's own wording is precise but written for auditability: phrases like
 * "chair utilization and booked appointment volume were both below their
 * configured thresholds" are correct and unreadable in a hurry. This prompt asks
 * for the same meaning in the words a dentist would actually use.
 *
 * The model is a writer, not an analyst. It is given a closed set of facts and
 * told to restate them. Two rules do the heavy lifting:
 *
 *   - No new numbers. Anything numeric must be copied from the facts, because a
 *     wrong figure in a money summary is worse than no summary. Enforced after
 *     generation by verifyExplanation(), which discards output that invents one.
 *   - No advice. The Business Brain reports what it observes and what the
 *     evidence settles; telling a clinic what to do is a later phase and a
 *     different accountability. Also enforced after generation.
 */
export function buildDiagnosisExplanationPrompt(params: {
  title: string;
  summary: string;
  facts: string[];
  supported: string[];
  ruledOut: string[];
  undetermined: string[];
  persistence: string;
}): string {
  const section = (label: string, items: string[]) =>
    items.length > 0 ? `${label}\n${items.map((i) => `- ${i}`).join("\n")}` : "";

  return `You are writing for a dentist who owns a small clinic. They are busy, they are not an analyst, and they will read this between patients.

Rewrite the finding below in plain, everyday English.

FINDING
${params.title}
${params.summary}

WHAT WAS MEASURED
${params.facts.map((f) => `- ${f}`).join("\n")}

${section("WHAT THE EVIDENCE SUPPORTS", params.supported)}

${section("WHAT THE EVIDENCE RULES OUT", params.ruledOut)}

${section("WHAT THE DATA CANNOT TELL US YET", params.undetermined)}

HOW LONG THIS HAS BEEN GOING ON
${params.persistence}

HOW TO WRITE IT
- Two or three short sentences. Under 60 words total.
- Everyday words only. Write "how full the chairs were" instead of "chair utilization"; "money owed" instead of "outstanding balance"; "planned treatment where the patient has no next visit booked" instead of "accepted pending scheduling". Never say the patient agreed to or accepted a treatment — nothing in the records shows that.
- No jargon, no statistics vocabulary, no words like threshold, metric, signal, correlated, configured, or parameter.
- Plain sentences. No bullet points, no headings, no bold.
- Speak directly to the dentist as "you" and "your clinic".
- If something cannot be determined yet, say so in one short clause. Do not guess which explanation is right.

RULES YOU MUST NOT BREAK
- Do not state any number, amount, percentage or count that does not already appear above. Copy figures exactly as written, or leave them out.
- Do not tell the dentist what to do. Do not suggest, recommend, advise, or say anything should or must happen. Describe the situation only.
- Do not add causes, context or explanations of your own. Only restate what is above.

Write only the explanation. No preamble, no closing line.`;
}
