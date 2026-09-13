import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { resolveSession } from "@/lib/auth/session";
import { isBusinessBrainEnabled, isWhatsAppEnabled } from "@/lib/feature-flags";
import { runDashboardBrain } from "@/lib/business-brain/dashboard-data";
import {
  compareClinicHealth,
  computeClinicHealth,
  withDelta,
} from "@/lib/business-brain/clinic-health";
import { buildWins } from "@/lib/business-brain/wins-view";
import { buildBriefing } from "@/lib/business-brain/briefing-view";
import { readActiveDismissals, isSuppressed } from "@/lib/business-brain/dismissals";
import { readReminderOutcomes } from "@/lib/business-brain/reminder-outcomes";
import { loadActionOutcomes } from "@/lib/business-brain/action-outcomes";
import { buildOutcomeViews } from "@/lib/business-brain/outcomes-view";
import { ActionHistory } from "@/components/business-brain/ActionHistory";
import { ReminderOutcomes } from "@/components/business-brain/ReminderOutcomes";
import { createServerClient } from "@/lib/supabase/server";
import { getReminderSummaries } from "@/actions/messaging";
import type { ReminderSummary } from "@/lib/messaging/reminder-types";
import { BRIEFING_MESSAGE_KINDS } from "@/lib/messaging/templates";
import { formatDate } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { MorningBriefing } from "@/components/business-brain/MorningBriefing";

export const metadata: Metadata = {
  title: "Actions",
};

/**
 * /dentist/business-brain — the Morning Briefing.
 *
 * One job: a busy dentist understands their clinic, and what to do about it,
 * within a minute of opening this page. Four things, in order:
 *
 *   1. Clinic Health    — one number, its movement, and what's behind it.
 *   2. What's going well — at most three measured improvements, collapsed.
 *   3. Needs attention  — the problems, worst first, in plain language.
 *   4. What to do        — a checklist and the buttons to act on each one.
 *
 * The wins sit second deliberately: above the work, so the page opens with where
 * the clinic stands rather than with a list of demands — and below the score,
 * because the score is the summary and a win is one line of the detail behind it.
 *
 * Everything the old page showed around this — metrics walls, coverage lines,
 * confidence labels, the pipeline audit trail — is gone. None of it helped a
 * dentist decide anything before their first patient.
 */
export default async function BusinessBrainPage() {
  const { profile } = await resolveSession();

  if (!profile || profile.role !== "dentist") notFound();
  if (!isBusinessBrainEnabled(profile.clinic_id)) notFound();

  let run: Awaited<ReturnType<typeof runDashboardBrain>>;
  try {
    run = await runDashboardBrain();
  } catch {
    return (
      <PageShell subtitle="Your daily clinic check-up">
        <div className="bg-surface border border-border rounded-xl">
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Couldn't check your clinic today"
            description="Something went wrong reading your records. Everything else in OraMedha still works — try refreshing in a minute."
          />
        </div>
      </PageShell>
    );
  }

  const { result, date } = run;
  const whatsappEnabled = isWhatsAppEnabled(profile.clinic_id);

  // The distinct-patient reminder populations. `total` (patients with the
  // problem) aligns the plain problem counts on the left; `actionable` (patients
  // we can message, not already reminded) drives the WhatsApp actions and equals
  // each send list's length. Both come from one source so the numbers agree.
  const reminderSummaries: ReminderSummary[] = whatsappEnabled
    ? (await getReminderSummaries()).data ?? []
    : [];

  // Map kind → category so the projection can state distinct-patient counts.
  const kindToCategory = Object.fromEntries(
    Object.entries(BRIEFING_MESSAGE_KINDS).map(([category, kind]) => [kind, category]),
  ) as Record<string, string>;
  const patientCounts: Record<string, number> = {};
  for (const s of reminderSummaries) {
    const category = kindToCategory[s.kind];
    if (category) patientCounts[category] = s.total;
  }

  // The health breakdown shares the same distinct-patient counts, so its
  // "N patients" lines match the problem cards and the action list rather than
  // inflating to a treatment/follow-up row count.
  const healthContext = {
    patientCounts: {
      noNextVisit: patientCounts["treatment_acceptance"] ?? null,
      overdueFollowups: patientCounts["retention"] ?? null,
    },
    // This clinic's own normal range per metric, for the credit side of the
    // score. Absent for a clinic with too little history, and the score is then
    // exactly the deduction ledger it has always been.
    baselines: new Map(result.baselines.map((b) => [b.key, b])),
  };
  const today = computeClinicHealth(result.metrics, healthContext);

  // The movement, recomputed rather than stored. The earlier day's score comes
  // from running the SAME rubric over that day's stored metrics, so the two sides
  // are always comparable and there is no saved number able to drift from the
  // data.
  //
  // The earlier day gets ITS OWN baseline positions, supplied by the run. Reusing
  // today's would judge last week against this morning's readings and hand the
  // earlier day today's credits, which would make the "previous score" on screen
  // untrue even though the difference happened to cancel out.
  const health =
    result.comparison === undefined
      ? today
      : withDelta(
          today,
          compareClinicHealth(
            today,
            computeClinicHealth(result.comparison.metrics, {
              ...healthContext,
              baselines: new Map(result.comparison.baselines.map((b) => [b.key, b])),
            }),
            { date: result.comparison.date, daysAgo: result.comparison.daysAgo },
          ),
        );

  const supabase = await createServerClient();
  const now = new Date().toISOString();

  // What the clinic has already done, and what its own records say followed.
  // Read before the wins so a win can show the action that sits alongside it.
  const outcomes = await loadActionOutcomes(
    supabase as never,
    profile.clinic_id,
    result.metrics,
    now,
  );

  // Measured improvements against this clinic's own normal. Capped at three by
  // the Achievement Engine; empty for a clinic running inside its usual range,
  // which renders nothing rather than a placeholder.
  const wins = buildWins(result.achievements, outcomes, now);
  const outcomeViews = buildOutcomeViews(outcomes, now);

  // Which cards to acknowledge as done. Server-resolved so it survives a refresh,
  // and scoped to today so yesterday's completion does not silently mark today's
  // card — the problem may well have returned.
  const completedCategories = new Set(
    outcomeViews.filter((o) => o.whenLabel === "Today").map((o) => o.category),
  );

  // Problems the clinic has snoozed and that have not since got worse. Resolved
  // here rather than inside the projection: it needs the database, and the
  // escalation check needs each constraint's CURRENT severity, so this is the
  // only place that has both. A read failure yields an empty set, which shows
  // everything — the safe direction.
  const dismissals = await readActiveDismissals(
    supabase as never,
    profile.clinic_id,
    now,
  );
  const suppressedCategories = new Set(
    result.constraints
      .filter((c) => isSuppressed(dismissals.get(c.category), c.severity))
      .map((c) => c.category),
  );

  const { problems, actions } = buildBriefing(
    result,
    result.metrics,
    patientCounts,
    suppressedCategories,
  );

  // Only meaningful where reminders can actually be sent, so it shares the
  // WhatsApp gate rather than appearing as an empty panel for clinics that have
  // never had the affordance.
  const reminderOutcomes = whatsappEnabled
    ? await readReminderOutcomes(supabase as never, profile.clinic_id, now)
    : [];

  return (
    <PageShell subtitle={formatDate(date)}>
      <MorningBriefing
        health={health}
        problems={problems}
        actions={actions}
        wins={wins}
        completedCategories={completedCategories}
        whatsappEnabled={whatsappEnabled}
        reminderSummaries={reminderSummaries}
      />
      {/* A look back, below everything that needs action. Renders nothing when
          the clinic has completed nothing. */}
      <ActionHistory outcomes={outcomeViews} />
      {/* Last, and deliberately: the page's job is what to do today. This is a
          look back, useful but never the headline. */}
      <ReminderOutcomes outcomes={reminderOutcomes} />
    </PageShell>
  );
}

function PageShell({
  subtitle,
  children,
}: {
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-screen-xl">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary tracking-tight">Actions</h1>
        <p className="text-sm text-text-secondary mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
