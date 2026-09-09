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
  buildDiagnosisExplanationPrompt,
  buildDashboardActionSummaryPrompt,
  type DashboardActionFact,
} from "@/lib/ai/prompts";
import { parseDashboardActionSummary } from "@/lib/ai/dashboard-action-summary";
import {
  explanationInputFor,
  verifyExplanation,
  type Diagnosis,
} from "@/business-brain";
import { addDays } from "@/business-brain";
import { getClinicConfig } from "@/lib/clinic/config";
import { getTodayInTimezone } from "@/lib/utils";
import { persistMetricRange, type PersistResult } from "@/lib/business-brain/persist-metrics";
import { revalidatePath } from "next/cache";
import { DismissProblemSchema, type ActionResult } from "@/types";

/**
 * Business Brain — AI explanation Server Action.
 *
 * Rewrites one already-computed diagnosis in plain English. It adds no analysis:
 * the diagnosis, its evidence and its hypothesis statuses are all decided by the
 * deterministic engines before this runs, and the model only rephrases them.
 *
 * Three guardrails, in order of importance:
 *
 * 1. Output is VERIFIED before it is returned. `verifyExplanation` rejects any
 *    text containing a figure absent from the supplied facts, any advisory
 *    wording, or anything over-long. Failing output is discarded and logged
 *    rather than shown — a fabricated number in a money summary is worse than
 *    no summary.
 * 2. The fact set is closed and derived server-side from the diagnosis. The
 *    client cannot widen what the model is allowed to talk about.
 * 3. Failure is never fatal. Timeouts, API errors and rejected generations all
 *    return a message, so the dashboard keeps working with AI unavailable
 *    (CLAUDE.md §13.11).
 */

const EXPLANATION_UNAVAILABLE =
  "Plain-English explanation is unavailable right now. The findings above are unaffected.";

/** Kept short: this is one paragraph, not a conversation. */
const EXPLANATION_TIMEOUT_MS = 12_000;

export interface DiagnosisExplanation {
  readonly diagnosisId: string;
  readonly text: string;
}

/**
 * Explain a diagnosis in plain language.
 *
 * @param diagnosis          The diagnosis to explain, as produced by the pipeline.
 * @param signalDescriptions Descriptions of the signals behind it. These become
 *                           part of the closed fact set the model may restate.
 */
export async function explainDiagnosis(
  diagnosis: Diagnosis,
  signalDescriptions: string[] = [],
): Promise<ActionResult<DiagnosisExplanation>> {
  try {
    // Same gate as the dashboard: this is a development surface.
    const { profile } = await resolveSession();
    if (!profile || profile.role !== "dentist") {
      return { data: null, error: "Unauthorized" };
    }
    if (!isBusinessBrainEnabled(profile.clinic_id)) {
      return { data: null, error: "Unauthorized" };
    }

    if (!diagnosis?.id || !diagnosis.title || !Array.isArray(diagnosis.hypotheses)) {
      return { data: null, error: "Invalid diagnosis." };
    }

    const input = explanationInputFor(diagnosis, signalDescriptions);

    // The Business Brain prompt has always been identifier-free — it restates
    // aggregate findings the deterministic engines already computed. The guard
    // is applied anyway, so that stays true of every future diagnosis a matcher
    // learns to emit rather than being true only of today's.
    const prompt = guardOutboundPrompt(
      buildDiagnosisExplanationPrompt({
        title: diagnosis.title,
        summary: diagnosis.summary,
        facts: [...input.facts],
        supported: diagnosis.hypotheses
          .filter((h) => h.status === "supported")
          .map((h) => h.statement),
        ruledOut: diagnosis.hypotheses
          .filter((h) => h.status === "contradicted")
          .map((h) => h.statement),
        undetermined: diagnosis.hypotheses
          .filter((h) => h.status === "undetermined")
          .map((h) => h.statement),
        persistence: diagnosis.persistence.replace(/_/g, " "),
      })
    );

    const raw = await withAITimeout(async () => {
      const model = getGeminiModel();
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          // Low temperature: this is a rewording task, not a creative one.
          temperature: 0.2,
          maxOutputTokens: 220,
        },
      });
      return result.response.text();
    }, EXPLANATION_TIMEOUT_MS);

    const text = raw.trim();
    const verdict = verifyExplanation(text, input);

    if (!verdict.ok) {
      // Deliberately not returned to the user and deliberately not retried: a
      // generation that invented a figure or gave advice is not a transient
      // fault, and silently showing it would defeat the guardrail.
      console.error("[explainDiagnosis] rejected generation", {
        diagnosisId: diagnosis.id,
        violations: verdict.violations,
      });
      return { data: null, error: EXPLANATION_UNAVAILABLE };
    }

    return { data: { diagnosisId: diagnosis.id, text }, error: null };
  } catch (error) {
    if (error instanceof AIError) {
      console.error("[explainDiagnosis] AI unavailable:", error.message);
      return { data: null, error: EXPLANATION_UNAVAILABLE };
    }
    console.error("[explainDiagnosis]", error);
    return { data: null, error: EXPLANATION_UNAVAILABLE };
  }
}

/** Kept short: this is a handful of one-line rewrites, not a conversation. */
const DASHBOARD_ACTIONS_TIMEOUT_MS = 8_000;

/** Most items a dashboard load will ever ask to have rephrased at once. Keeps the prompt small and the failure mode (whole batch discarded) cheap. */
const MAX_DASHBOARD_ACTION_ITEMS = 8;

export interface DashboardActionSummary {
  readonly id: string;
  readonly text: string;
}

/**
 * Rephrase the dashboard's existing "needs attention" items into single, plain
 * sentences — one Gemini call for the whole card rather than one per item, so
 * the card renders after a single round trip.
 *
 * This is deliberately NOT the same shape as explainDiagnosis: there is no new
 * analysis here, no evidence, no hypotheses — each item's `fact` is already a
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

    const bounded = items
      .filter((item) => item.id && item.fact)
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
    // Unlike explainDiagnosis, failure here still returns data: every item's
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
