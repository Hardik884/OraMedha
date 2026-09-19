"use server";

import { resolveSession } from "@/lib/auth/session";
import { isBusinessBrainEnabled } from "@/lib/feature-flags";
import {
  AIError,
  getGeminiModel,
  guardOutboundPrompt,
  withAITimeout,
} from "@/lib/ai/gemini";
import {
  buildDashboardActionSummaryPrompt,
  type DashboardActionFact,
} from "@/lib/ai/prompts";
import { parseDashboardActionSummary } from "@/lib/ai/dashboard-action-summary";
import {
  assessRunHealth,
} from "@/business-brain";
import { addDays } from "@/business-brain";
import { getClinicConfig } from "@/lib/clinic/config";
import { getTodayInTimezone } from "@/lib/utils";
import { persistMetricRange, type PersistResult } from "@/lib/business-brain/persist-metrics";
import { revalidatePath } from "next/cache";
import {
  CompleteActionSchema,
  DecideLearningProposalSchema,
  DismissProblemSchema,
  RecordFindingFeedbackSchema,
  type ActionResult,
} from "@/types";
import { loadActionLearning } from "@/lib/business-brain/action-outcomes";
import { recordClinicDecision } from "@/lib/business-brain/clinic-memory";
import { resolveActionTargets } from "@/lib/business-brain/action-targets";
import { OUTCOME_SPEC_BY_CATEGORY } from "@/business-brain/engines/outcome";
import { runDashboardBrain } from "@/lib/business-brain/dashboard-data";
import { isCurrentCompletionCard } from "@/lib/business-brain/completion-card";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Business Brain — Server Actions.
 *
 * The dashboard's writes and its one AI call. Everything the clinic is told is
 * computed by the deterministic engines first; the model only rephrases facts
 * that are already correct, and the same three guardrails apply to it:
 *
 * 1. Output is VERIFIED before it is shown. `parseDashboardActionSummary`
 *    rejects any line carrying a figure absent from the supplied facts, any
 *    advisory wording, or anything over-long — a fabricated number in a money
 *    summary is worse than no summary.
 * 2. The fact set is closed and computed server-side. The client cannot widen
 *    what the model is allowed to talk about.
 * 3. Failure is never fatal. Timeouts, API errors and rejected generations fall
 *    back to each item's own deterministic sentence, so the dashboard keeps
 *    working with AI unavailable (CLAUDE.md §13.11).
 *
 * A second action, `explainDiagnosis`, once rewrote a whole diagnosis in plain
 * English. It was removed on 18 Sep 2026: no screen ever called it, and an
 * exported "use server" function is a reachable endpoint whether or not a form
 * points at it (CLAUDE.md §13.4). The verifier and prompt it used
 * (`verifyExplanation`, `buildDiagnosisExplanationPrompt`) are kept for the
 * explanation surface when one is actually built.
 */

/** Kept short: this is a handful of one-line rewrites, not a conversation. */
const DASHBOARD_ACTIONS_TIMEOUT_MS = 8_000;

/** Most items a dashboard load will ever ask to have rephrased at once. Keeps the prompt small and the failure mode (whole batch discarded) cheap. */
const MAX_DASHBOARD_ACTION_ITEMS = 8;

const MAX_DASHBOARD_ACTION_FACT_CHARS = 500;
const MAX_DASHBOARD_ACTION_ID_CHARS = 120;

export interface DashboardActionSummary {
  readonly id: string;
  readonly text: string;
}

/**
 * Rephrase the dashboard's existing "needs attention" items into single, plain
 * sentences — one Gemini call for the whole card rather than one per item, so
 * the card renders after a single round trip.
 *
 * There is no new analysis here, no evidence and no hypotheses — each item's `fact` is already a
 * complete, correct sentence computed by the existing Business Brain / dashboard
 * logic, and the model's only job is to phrase it more clearly. Per CLAUDE.md
 * §8/§13.11, a rejected or failed generation must never block the dashboard: the
 * caller renders each item's own `fact` as a deterministic fallback, so the
 * result of this action is always an optional improvement, never a dependency.
 *
 * @param items Already-computed, patient-identifier-free facts. Each is also
 *              this item's own fallback text — see parseDashboardActionSummary.
 */
export async function summarizeDashboardActions(
  items: DashboardActionFact[],
): Promise<ActionResult<DashboardActionSummary[]>> {
  try {
    const { profile } = await resolveSession();
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Unauthorized" };
    }

    const bounded = (Array.isArray(items) ? items : [])
      .filter(
        (item) =>
          typeof item?.id === "string" &&
          typeof item.fact === "string" &&
          item.id.length > 0 &&
          item.id.length <= MAX_DASHBOARD_ACTION_ID_CHARS &&
          item.fact.trim().length > 0 &&
          item.fact.length <= MAX_DASHBOARD_ACTION_FACT_CHARS,
      )
      .slice(0, MAX_DASHBOARD_ACTION_ITEMS);
    if (bounded.length === 0) {
      return { data: [], error: null };
    }

    const prompt = guardOutboundPrompt(buildDashboardActionSummaryPrompt(bounded));

    const raw = await withAITimeout(async () => {
      const model = getGeminiModel();
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          // Low temperature: this is a rewording task, not a creative one.
          temperature: 0.2,
          maxOutputTokens: 60 * bounded.length,
        },
      });
      return result.response.text();
    }, DASHBOARD_ACTIONS_TIMEOUT_MS);

    const verified = parseDashboardActionSummary(raw, bounded);
    return {
      data: bounded.map((item) => ({
        id: item.id,
        // Falls back to the item's own deterministic fact when the model's line
        // for it was missing, malformed, or failed verification — never an error
        // for the whole card over one bad line.
        text: verified.get(item.id) ?? item.fact,
      })),
      error: null,
    };
  } catch (error) {
    if (error instanceof AIError) {
      console.error("[summarizeDashboardActions] AI unavailable:", error.message);
    } else {
      console.error("[summarizeDashboardActions]", error);
    }
    // Failure here still returns data: every item's
    // deterministic fact, so the card renders its concise fallback rather than
    // an error state (CLAUDE.md §13.11 — AI is an enhancement, never a
    // dependency for a page that already has the underlying data).
    return {
      data: items.slice(0, MAX_DASHBOARD_ACTION_ITEMS).map((item) => ({ id: item.id, text: item.fact })),
      error: null,
    };
  }
}

/**
 * Record measured metrics so history stops being reconstructed.
 *
 * The pipeline reads `metric_history` for its history days and recomputes only
 * what is missing, so without something writing to that table the optimisation
 * never engages and every dashboard load re-derives a full week. This is that
 * writer, exposed as an explicit action rather than a side effect of rendering:
 * a page render must not write, and `pipeline.spec.ts` asserts the whole run
 * leaves every table's row count unchanged.
 *
 * Records COMPLETED days only. Today's figures are still moving — a snapshot
 * taken at 11:00 does not describe the day — so freezing today would store a
 * half-finished number as if it were the day's result. The range therefore ends
 * yesterday.
 *
 * Idempotent: the store upserts on (clinic, date, key), so re-running corrects
 * rather than duplicates, and re-running after a data fix is how a correction
 * propagates.
 *
 * @param days How many completed days back to record, ending yesterday.
 */
export async function recordMetricHistory(days = 30): Promise<ActionResult<PersistResult>> {
  try {
    // Same gate as the dashboard: this is a development surface.
    const { profile } = await resolveSession();
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }
    if (!isBusinessBrainEnabled(profile.clinic_id)) {
      return { data: null, error: "Not available for this clinic." };
    }

    const bounded = Math.min(Math.max(1, Math.trunc(days)), 365);
    const { timezone } = await getClinicConfig();
    // Yesterday in the CLINIC's timezone, not the server's: a job running at
    // 00:30 UTC would otherwise record the wrong day for a clinic in IST.
    const to = addDays(getTodayInTimezone(timezone), -1);
    const from = addDays(to, -(bounded - 1));

    const result = await persistMetricRange(profile.clinic_id, from, to);
    return { data: result, error: null };
  } catch (error) {
    console.error("[recordMetricHistory]", error);
    return { data: null, error: "Could not record metric history." };
  }
}

/**
 * Snooze one problem category for this clinic.
 *
 * Records a decision, never a measurement. The pipeline still computes the
 * problem in full on every run; this only stops the briefing drawing its card
 * while the snooze stands.
 *
 * Two guards make a snooze safe to offer at all:
 *
 * 1. It EXPIRES. `days` is bounded, so a decision made today cannot silently
 *    govern the clinic six months from now.
 * 2. It is bound to the severity the problem carried when dismissed
 *    (`severityAtDismissal`). If the problem escalates a band the card returns
 *    immediately, whatever the expiry says — see `isSuppressed`. Without that, a
 *    snooze on "3 patients owe money" would keep hiding it at 40 patients.
 *
 * A reason is required rather than optional: a snooze with no reason is
 * indistinguishable from a mis-click when it is read back weeks later, and the
 * reasons are how we learn which false positives are worth fixing in the schema
 * instead of papering over.
 */
export async function dismissProblem(input: {
  category: string;
  severityAtDismissal: string;
  reason: string;
  days: number;
}): Promise<ActionResult<{ expiresAt: string }>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }
    if (!isBusinessBrainEnabled(profile.clinic_id)) {
      return { data: null, error: "Not available for this clinic." };
    }

    const parsed = DismissProblemSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }

    const expiresAt = new Date(
      Date.now() + parsed.data.days * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error } = await db.from("problem_dismissals").insert({
      clinic_id: profile.clinic_id,
      category: parsed.data.category,
      severity_at_dismissal: parsed.data.severityAtDismissal,
      reason: parsed.data.reason.trim(),
      expires_at: expiresAt,
      dismissed_by: profile.id,
    });
    if (error) {
      console.error("[dismissProblem]", error.message);
      return { data: null, error: "Could not snooze this problem." };
    }

    // The briefing is a server render, so it has to be re-read for the card to
    // disappear. Revalidating here rather than relying on the client keeps the
    // page's own data the single source of what is shown.
    revalidatePath("/dentist/business-brain");
    return { data: { expiresAt }, error: null };
  } catch (error) {
    console.error("[dismissProblem]", error);
    return { data: null, error: "Could not snooze this problem." };
  }
}

/**
 * Record that one Business Brain action was completed.
 *
 * ## What the browser is allowed to say
 *
 * The category, the constraint id it was filed under, and an optional note.
 * Nothing else. Clinic, actor, timestamp, target patients and the headline metric
 * reading are all resolved on this side:
 *
 *   clinic_id   from the session's profile, never the request
 *   completed_by from the session's profile
 *   completed_at by the database default
 *   targets      from the same population readers the briefing displayed
 *   metric       from a fresh pipeline run
 *
 * The target list is the one that matters most. A request body carrying patient
 * ids would be a client-controlled claim about which patients a clinic worked,
 * and those ids would then be matched against clinic data to produce a
 * "verified" figure — so the client is never given the chance.
 *
 * ## Why it reads the metric now rather than later
 *
 * `metric_history` stores COMPLETED days, so the reading at 11am on the day the
 * work was done cannot be recovered afterwards. That number is the "12" in "the
 * backlog fell from 12 to 3", and capturing it here is the only way to have it.
 *
 * ## What it must never do
 *
 * Award score points. The Clinic Score reads measured clinic metrics and nothing
 * else, which is what makes it impossible to game by clicking — a completion
 * moves it only through the data the work actually changed. This function writes
 * one row and revalidates the page; it touches no score.
 */
export async function completeAction(input: {
  category: string;
  constraintId: string;
  note?: string;
}): Promise<ActionResult<{ completionId: string; targeted: number }>> {
  try {
    const { profile } = await resolveSession();
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }
    if (!isBusinessBrainEnabled(profile.clinic_id)) {
      return { data: null, error: "Not available for this clinic." };
    }

    const parsed = CompleteActionSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }
    const { category, constraintId, note } = parsed.data;

    // Only a category the briefing can actually raise. Rejecting an unknown one
    // keeps the table free of rows no outcome assessment could ever interpret.
    const spec = OUTCOME_SPEC_BY_CATEGORY.get(category);
    if (spec === undefined) {
      return { data: null, error: "Unknown action category." };
    }

    // The card this completes: this clinic, this category, a recent run date.
    const { timezone } = await getClinicConfig();
    if (!isCurrentCompletionCard(constraintId, category, profile.clinic_id, getTodayInTimezone(timezone))) {
      return { data: null, error: "This card is out of date. Refresh the page and try again." };
    }

    // Written with the service role: the client write path is closed at the
    // database, so every fact on the row is the one resolved here.
    const admin = createAdminClient() as unknown as SupabaseClient<Database>;

    // Idempotent per card. A double-press, or a retry after a slow response, is
    // one action — two rows would read as two overlapping actions and cap the
    // attribution of both.
    const existing = await admin
      .from("action_completions")
      .select("id, target_patient_ids")
      .eq("clinic_id", profile.clinic_id)
      .eq("constraint_id", constraintId)
      .order("completed_at", { ascending: true })
      .limit(1);
    if (existing.error) {
      console.error("[completeAction] idempotency lookup", existing.error.message);
      return { data: null, error: "Could not record this as done." };
    }
    const prior = (existing.data ?? [])[0] as { id: string; target_patient_ids: string[] | null } | undefined;
    if (prior !== undefined) {
      return { data: { completionId: prior.id, targeted: prior.target_patient_ids?.length ?? 0 }, error: null };
    }

    // The population this card was about, derived from the same readers that
    // built it. Empty for a category with nobody identifiable to target, which
    // is reported downstream as "nothing to confirm" rather than as a failure.
    const targetPatientIds = await resolveActionTargets(category);

    // The headline reading at this moment. Best-effort: a completion is worth
    // recording even if the pipeline cannot run, and a missing reading simply
    // leaves the outcome at `insufficient_evidence`.
    let metricKey: string | null = null;
    let metricValue: number | null = null;
    if (spec.metricKey !== null) {
      try {
        const { result } = await runDashboardBrain();
        const found = result.metrics.find((m) => m.id.startsWith(`${spec.metricKey}:`));
        if (found && Number.isFinite(found.value)) {
          metricKey = spec.metricKey;
          metricValue = found.value;
        }
      } catch (error) {
        console.error("[completeAction] could not capture the metric reading", error);
      }
    }

    const { data, error } = await admin
      .from("action_completions")
      .insert({
        clinic_id: profile.clinic_id,
        category,
        constraint_id: constraintId,
        completed_by: profile.id,
        // A person pressed Done. An inferred completion is a different provenance
        // and is never written from here.
        source: "declared",
        note: note ?? null,
        target_patient_ids: targetPatientIds,
        metric_key: metricKey,
        metric_value: metricValue,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[completeAction]", error?.message);
      return { data: null, error: "Could not record this as done." };
    }

    // The Actions page is a server render, so the history section only picks the
    // completion up on the next read. Revalidating here keeps the page's own data
    // the single source of what is shown.
    revalidatePath("/dentist/business-brain");
    return {
      data: { completionId: (data as { id: string }).id, targeted: targetPatientIds.length },
      error: null,
    };
  } catch (error) {
    console.error("[completeAction]", error);
    return { data: null, error: "Could not record this as done." };
  }
}

/**
 * Record a dentist's decision on a learning proposal.
 *
 * ## An explicit, auditable path — and nothing more
 *
 * One append-only row in `clinic_decisions`. It changes no threshold, rule,
 * ranking or action: the Business Brain lists accepted decisions through the
 * memory reader for an explicit consumer, and no consumer applies them yet.
 *
 * ## What the browser may say
 *
 * Only which proposal and which decision. The proposal is re-derived from this
 * clinic's own history on the server; a proposal the current evidence no longer
 * produces is refused rather than recorded against a basis that no longer holds.
 * The clinic and the author come from the session, and RLS pins both.
 */
export async function decideLearningProposal(input: {
  proposalId: string;
  decision: "accepted" | "rejected";
}): Promise<ActionResult<{ decisionId: string }>> {
  try {
    const { db, profile } = await resolveSession();
    // Recorded below with the service role: the client write path is closed at
    // the database, and the clinic and author come only from this session.
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }
    if (!isBusinessBrainEnabled(profile.clinic_id)) {
      return { data: null, error: "Not available for this clinic." };
    }
    const parsed = DecideLearningProposalSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }

    const { result, date, timezone } = await runDashboardBrain();
    // A proposal is only as current as the run that re-derives it.
    if (!assessRunHealth(result).healthy) {
      return { data: null, error: "Your clinic's records could not be read just now. Try again in a minute." };
    }
    const findings = [
      ...(result.findings.top ? [result.findings.top] : []),
      ...result.findings.next,
      ...result.findings.supporting,
      ...result.findings.wins,
      ...result.findings.noActionRequired,
    ].map((r) => r.finding);
    const { learning } = await loadActionLearning(
      db as never,
      profile.clinic_id,
      { date, timezone, metrics: result.metrics, findings },
      new Date().toISOString(),
    );
    const proposal = learning?.proposals.find((p) => p.id === parsed.data.proposalId);
    const basis = learning?.learnings.find((l) => l.id === proposal?.learningId);
    if (proposal === undefined || basis === undefined) {
      return { data: null, error: "This suggestion is no longer supported by your clinic's records." };
    }

    const decisionId = await recordClinicDecision(createAdminClient() as never, {
      clinicId: profile.clinic_id,
      decidedBy: profile.id,
      target: { type: "proposal", id: proposal.id },
      proposalKind: proposal.kind,
      subject: proposal.subject,
      decision: parsed.data.decision,
      basis: { learningId: basis.id, learningKind: basis.kind, level: basis.level, confidence: basis.confidence, ...basis.counts },
    });
    revalidatePath("/dentist/business-brain");
    return { data: { decisionId }, error: null };
  } catch (error) {
    console.error("[decideLearningProposal]", error);
    return { data: null, error: "Could not record this decision." };
  }
}

/**
 * Record whether one finding was worth telling this clinic.
 *
 * ## The one question the module has never asked
 *
 * Everything else recorded here is what the clinic DID — a snooze, a completion,
 * a decision on a proposal. None of it answers whether what we said was worth
 * saying, and a snooze cannot stand in for it: a dentist snoozes a problem that
 * is real and inconvenient exactly as readily as one that is wrong. So precision
 * has been unmeasurable since the first rule shipped, and a rule firing wrongly
 * for a year looks the same as one firing correctly and being ignored.
 *
 * ## What the browser is allowed to say
 *
 * The finding's id, kind and category — what was on screen — plus a verdict and
 * a reason code. Clinic, actor and business date are resolved from the session
 * and the clinic's own timezone, so no request can file feedback against another
 * clinic, in someone else's name, or against a day of its choosing.
 *
 * No free text anywhere. A comment box here would collect patient names and
 * clinical notes into a table designed to hold neither.
 *
 * ## Changing your mind is a new row
 *
 * The table is append-only and every reader takes the latest verdict, so a
 * mis-click is correctable without anything being overwritten — and that the
 * opinion changed stays visible, which is itself worth knowing.
 */
export async function recordFindingFeedback(input: {
  findingId: string;
  findingKind: string;
  category?: string | null;
  verdict: "useful" | "not_relevant";
  reason?: "already_knew" | "not_true" | "not_my_priority" | "cannot_act" | "other";
}): Promise<ActionResult<{ recorded: true }>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }
    if (!isBusinessBrainEnabled(profile.clinic_id)) {
      return { data: null, error: "Not available for this clinic." };
    }

    const parsed = RecordFindingFeedbackSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }
    // The schema cannot express this one: a "not relevant" with no reason is a
    // count, and a count does not say whether to retire the rule, move a
    // threshold or rank it lower. The database enforces it too.
    if (parsed.data.verdict === "not_relevant" && parsed.data.reason === undefined) {
      return { data: null, error: "Tell us why it was not relevant." };
    }

    // The clinic's own business date, never the browser's: a request cannot
    // choose which day its verdict lands on.
    const { timezone } = await getClinicConfig();
    const { error } = await db.from("finding_feedback").insert({
      clinic_id: profile.clinic_id,
      business_date: getTodayInTimezone(timezone),
      finding_id: parsed.data.findingId,
      finding_kind: parsed.data.findingKind,
      category: parsed.data.category ?? null,
      verdict: parsed.data.verdict,
      reason: parsed.data.reason ?? null,
      recorded_by: profile.id,
    });
    if (error) {
      console.error("[recordFindingFeedback]", error.message);
      return { data: null, error: "Could not record that." };
    }

    // The briefing renders the standing verdict server-side, so it has to be
    // re-read for the card to show what was just said.
    revalidatePath("/dentist/business-brain");
    return { data: { recorded: true }, error: null };
  } catch (error) {
    console.error("[recordFindingFeedback]", error);
    return { data: null, error: "Could not record that." };
  }
}
