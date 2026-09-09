/**
 * lib/business-brain/dashboard-actions.ts
 *
 * Feeds the compact "Actions" card on Today's Dashboard (components/dentist/
 * DashboardActions.tsx) from the SAME data the full Business Brain "Actions"
 * page (/dentist/business-brain) already computes — no new aggregation, no new
 * recommendation logic. This file only reads `buildBriefing`'s output and
 * reshapes it into the short list the compact card renders.
 *
 * Returns `null` for any clinic where the Business Brain is not enabled
 * (lib/feature-flags.ts) — the dashboard card falls back to its own existing,
 * simpler data sources for those clinics, exactly as it did before. The
 * Business Brain pipeline itself, buildBriefing, and the /dentist/
 * business-brain page are all untouched by this file.
 */

import "server-only";
import { createServerClient } from "@/lib/supabase/server";
import { getClinicConfig } from "@/lib/clinic/config";
import { isBusinessBrainEnabled } from "@/lib/feature-flags";
import { runDashboardBrain } from "./dashboard-data";
import { buildBriefing } from "./briefing-view";
import { readActiveDismissals, isSuppressed } from "./dismissals";

/** The route the compact card's chevron sends the dentist to — the full "Actions" page. */
export const BUSINESS_BRAIN_ACTIONS_HREF = "/dentist/business-brain";

export interface DashboardActionItem {
  readonly id: string;
  /** Deterministic, already-correct sentence — the AI phrasing's source fact and its fallback. */
  readonly fact: string;
  readonly href: string;
}

/**
 * Load today's Business Brain actions for the compact dashboard card, or
 * `null` when this clinic doesn't have the Business Brain enabled.
 *
 * Never throws: a pipeline failure here must not take down Today's Dashboard,
 * which is core-operations surface (CLAUDE.md §13.11) — the caller treats a
 * caught error the same as "not enabled" and falls back to the legacy items.
 */
export async function loadBusinessBrainDashboardItems(): Promise<DashboardActionItem[] | null> {
  const { clinicId } = await getClinicConfig();
  if (!isBusinessBrainEnabled(clinicId)) return null;

  try {
    const run = await runDashboardBrain();
    const supabase = await createServerClient();

    // Same suppression rule the full Actions page applies — a card the dentist
    // has snoozed there must not reappear here just because it's a different
    // rendering of the same run.
    const dismissals = await readActiveDismissals(
      supabase as never,
      clinicId,
      new Date().toISOString(),
    );
    const suppressedCategories = new Set(
      run.result.constraints
        .filter((c) => isSuppressed(dismissals.get(c.category), c.severity))
        .map((c) => c.category),
    );

    // No patientCounts: those only refine wording precision on the full page
    // (distinct-patient counts vs. row counts), which the reminder-summary
    // fetch that computes them exists to support. The compact card doesn't
    // render a WhatsApp population count, so the metric-based figure
    // buildBriefing already falls back to is accurate enough for one sentence,
    // and skipping it keeps this a single extra query rather than the full
    // page's WhatsApp-gated fetch.
    const { actions } = buildBriefing(run.result, run.result.metrics, undefined, suppressedCategories);

    return actions.map((action) => ({
      id: action.id,
      fact: action.reason,
      href: BUSINESS_BRAIN_ACTIONS_HREF,
    }));
  } catch (error) {
    console.error("[loadBusinessBrainDashboardItems]", error);
    return null;
  }
}
