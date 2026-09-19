"use client";

import { CheckCircle2 } from "lucide-react";
import type { ClinicHealth } from "@/lib/business-brain/clinic-health";
import type { ActionCardView, ProblemView } from "@/lib/business-brain/briefing-view";
import type { WinsEmptyView, WinView } from "@/lib/business-brain/wins-view";
import type { ReminderSummary } from "@/lib/messaging/reminder-types";
import type { RecordedVerdict } from "@/lib/business-brain/finding-feedback";
import { HealthMeter } from "./HealthMeter";
import { WinsStrip } from "./WinsStrip";
import { ProblemCard } from "./ProblemCard";
import { ActionCard } from "./ActionCard";

interface MorningBriefingProps {
  health: ClinicHealth;
  problems: readonly ProblemView[];
  actions: readonly ActionCardView[];
  /**
   * Measured improvements, capped at three by the Achievement Engine.
   *
   * Rendered BETWEEN the score and the work, deliberately: a clinic should see
   * what is going well before it sees what needs doing, and never instead of it.
   * Empty renders nothing at all — no placeholder, no "no wins today".
   */
  wins?: readonly WinView[];
  /**
   * What the wins strip says when there are none — which is most days.
   *
   * Optional, and its absence keeps the old behaviour of rendering nothing. Not
   * derived here: it comes from the Achievement Engine's own decision trace, so
   * what is shown cannot disagree with what the engine decided.
   */
  winsEmptyState?: WinsEmptyView | null;
  /**
   * Categories already marked done today, resolved server-side.
   *
   * Passed through to each action card so the acknowledgement survives a refresh
   * — which is the whole reason completions are recorded durably rather than in
   * component state.
   */
  completedCategories?: ReadonlySet<string>;
  /**
   * What this clinic already said about today's problem cards, by finding id.
   *
   * Server-resolved so an answer survives a refresh, and scoped to today: the
   * same problem flagged again tomorrow is a new claim.
   */
  verdicts?: ReadonlyMap<string, RecordedVerdict>;
  /** When true, action cards may offer an inline "Contact Patients" button. */
  whatsappEnabled?: boolean;
  /** Per-kind reminder counts from the server, matched onto each card by its messageKind. */
  reminderSummaries?: readonly ReminderSummary[];
}

/**
 * The whole page below the title, in three blocks: the health score, what is
 * going well, then the two paired columns of problems and actions.
 *
 * The order is the product decision. Wins sit above the work so the page opens
 * with where the clinic stands rather than with a list of demands — and below the
 * score, because the score is the summary and a win is one line of the detail
 * behind it. They are never mixed into the problem cards: a card that might be
 * good news or bad news depending on its colour is a card nobody scans reliably.
 *
 * The score, problems and actions are always the server's live truth. Nothing
 * here removes a problem or its action on interaction — a card leaves only when
 * the underlying issue is genuinely resolved and the page re-reads fresh data.
 * Ticking a checklist or sending a reminder is progress, not proof.
 *
 * Problems and actions are rendered as PAIRED ROWS (one problem beside the
 * action that resolves it), not as two independently-scrolling lists. Every
 * row's two cards share a height via CSS Grid's default row-stretch, so the
 * two "columns" always end at exactly the same point — with no per-card
 * height hacks and no huge artificial empty space, since only genuine pairs
 * stretch to match each other. On narrow screens each row collapses to a
 * single column (problem, then its action, then the next pair), which also
 * reads better than two separate long lists: cause and fix stay together.
 *
 * "Patients to contact" is no longer a separate section here — each relevant
 * action card now carries its own inline Contact Patients action (see
 * ActionCard), so the patient-contact workflow lives inside the
 * recommendation it belongs to instead of a disconnected module.
 */
export function MorningBriefing({
  health,
  problems,
  actions,
  wins = [],
  winsEmptyState = null,
  completedCategories,
  verdicts,
  whatsappEnabled = false,
  reminderSummaries = [],
}: MorningBriefingProps) {
  const allClear = problems.length === 0;
  const actionByProblemId = new Map(actions.map((a) => [a.problemId, a]));
  const summaryByKind = whatsappEnabled ? new Map(reminderSummaries.map((s) => [s.kind, s])) : null;

  // Which problem categories actually have a card below, so the health breakdown
  // can mark the deductions that do not. Derived from the rendered cards rather
  // than restated, so it cannot disagree with what is on screen.
  const coveredCategories = new Set(actions.map((a) => a.category));

  return (
    <div className="space-y-6">
      <HealthMeter health={health} coveredCategories={coveredCategories} />

      <WinsStrip wins={wins} empty={winsEmptyState} />

      {allClear ? (
        <div className="bg-surface border border-border rounded-xl px-6 py-10 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-success-bg mb-3">
            <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
          </div>
          <h2 className="text-base font-semibold text-text-primary">Everything looks good today</h2>
          <p className="text-sm text-text-secondary mt-1">
            Nothing needs your attention right now. Your clinic is running as expected.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Column headers stay side-by-side on every screen size — short
              enough to fit even on a narrow phone, and they anchor the two
              "columns" conceptually even though the rows below are paired. */}
          <div className="grid grid-cols-2 gap-x-4 lg:gap-x-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text-primary">Needs attention</h2>
              <span className="text-xs text-text-disabled">{problems.length}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text-primary">What to do</h2>
              <span className="text-xs text-text-disabled">{actions.length}</span>
            </div>
          </div>

          <div className="space-y-3">
            {problems.map((p) => {
              const action = actionByProblemId.get(p.id);
              const contactSummary =
                summaryByKind && action?.messageKind ? summaryByKind.get(action.messageKind) : undefined;
              return (
                <div key={p.id} className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-6 items-stretch">
                  <ProblemCard problem={p} verdict={verdicts?.get(p.id) ?? null} />
                  {action ? (
                    <ActionCard
                      action={action}
                      contactSummary={contactSummary}
                      completedToday={completedCategories?.has(action.category) ?? false}
                    />
                  ) : (
                    <div aria-hidden />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
