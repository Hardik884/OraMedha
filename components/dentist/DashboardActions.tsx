import Link from "next/link";
import { ChevronRight, CheckCircle2 } from "lucide-react";

import { getFollowUpStats } from "@/actions/follow-ups";
import { getPatientsWithOutstandingBalance } from "@/actions/payments";
import { getUnpaidConsultationCount } from "@/actions/consultants";
import { summarizeDashboardActions } from "@/actions/business-brain";
import { loadBusinessBrainDashboardItems } from "@/lib/business-brain/dashboard-actions";
import type { DashboardActionItem } from "@/lib/business-brain/dashboard-actions";

interface DashboardActionsProps {
  /** Patients waiting in today's queue. Passed from the page, which has already
   * loaded the queue — this component fires no queue query of its own. */
  waitingCount: number;
}

/**
 * DashboardActions — the compact "what needs doing" card on the dashboard's
 * right rail.
 *
 * SOURCE OF DATA
 *   Every item here is something an existing system already computed — no new
 *   aggregation and no new recommendation logic lives in this file:
 *     - Where the Business Brain is enabled for this clinic (a dev/pilot-only
 *       allow-list, see lib/feature-flags.ts), items come straight from
 *       buildBriefing's `actions` list — the SAME data behind the full
 *       "Actions" page at /dentist/business-brain — and the chevron on every
 *       row opens that page.
 *     - Otherwise, items come from this card's own long-standing counts
 *       (overdue/pending follow-ups, outstanding balances, unpaid
 *       consultations, queue), exactly as before, and each chevron still opens
 *       that item's own page.
 *
 * AI PHRASING, NOT AI ANALYSIS
 *   Each item already carries a correct, deterministic sentence (`fact`) —
 *   that IS the card's content. summarizeDashboardActions asks Gemini to
 *   rephrase those sentences more clearly, one per item, in a single batched
 *   call; verification (lib/ai/dashboard-action-summary.ts) discards any
 *   rewrite that invents a number or gives advice, and a rejected or failed
 *   call always falls back to the item's own `fact` — so the card degrades to
 *   its plain deterministic wording rather than to an error (CLAUDE.md §13.11).
 *   No patient name, phone number or other identifier is ever part of a
 *   `fact` — every source item is an aggregate count.
 *
 * Rows with nothing to do are hidden entirely, so the card is short on a
 * normal day and the empty state is a genuine "all clear" rather than
 * several zeroes.
 */
export async function DashboardActions({ waitingCount }: DashboardActionsProps) {
  const items = await loadActionItems(waitingCount);

  const summaries =
    items.length > 0
      ? await summarizeDashboardActions(items.map((item) => ({ id: item.id, fact: item.fact })))
      : { data: [], error: null };
  const textById = new Map((summaries.data ?? []).map((s) => [s.id, s.text]));

  return (
    <div className="bg-surface border border-border rounded-xl">
      <div className="px-4 py-2.5 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary">Actions</h2>
        <p className="text-xs text-text-secondary mt-0.5">
          {items.length > 0 ? "Needs your attention" : "Nothing outstanding"}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="px-4 py-4 flex items-center gap-2.5 text-text-secondary">
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" aria-hidden />
          <p className="text-xs">You&apos;re all caught up.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className="flex items-center gap-2 px-4 py-2.5 hover:bg-surface-muted transition-colors group"
              >
                <span className="text-xs leading-snug text-text-body flex-1 min-w-0 line-clamp-2">
                  {textById.get(item.id) ?? item.fact}
                </span>
                <ChevronRight
                  className="h-3.5 w-3.5 text-text-disabled group-hover:text-text-secondary transition-colors shrink-0"
                  aria-hidden
                  aria-label="View details"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

/**
 * Legacy (non-Business-Brain) item set — unchanged in substance from before
 * this card was redesigned, just reshaped into {id, fact, href}. Only used
 * for clinics where the Business Brain is not enabled.
 */
async function loadLegacyActionItems(waitingCount: number): Promise<DashboardActionItem[]> {
  const [followUpStats, outstanding, unpaidConsultations] = await Promise.all([
    getFollowUpStats(),
    getPatientsWithOutstandingBalance(),
    getUnpaidConsultationCount(),
  ]);

  const overdueFollowUps = followUpStats.data?.overdue ?? 0;
  const pendingFollowUps = followUpStats.data?.pending ?? 0;
  const owingPatients = outstanding.data?.length ?? 0;
  const unpaidConsults = unpaidConsultations.data ?? 0;

  return [
    {
      id: "waiting",
      fact: plural(waitingCount, "1 patient is waiting in today's queue.", "{n} patients are waiting in today's queue."),
      href: "/dentist/queue",
      count: waitingCount,
    },
    {
      id: "overdue",
      fact: plural(overdueFollowUps, "1 follow-up is overdue and needs attention.", "{n} follow-ups are overdue and need attention."),
      href: "/dentist/follow-ups?status=overdue",
      count: overdueFollowUps,
    },
    {
      id: "pending-followups",
      fact: plural(pendingFollowUps, "1 follow-up is still pending.", "{n} follow-ups are still pending."),
      href: "/dentist/follow-ups?status=pending",
      count: pendingFollowUps,
    },
    {
      id: "balances",
      fact: plural(owingPatients, "1 patient has an outstanding balance.", "{n} patients have an outstanding balance."),
      href: "/dentist/payments",
      count: owingPatients,
    },
    {
      id: "consultations",
      fact: plural(unpaidConsults, "1 external consultation is unpaid.", "{n} external consultations are unpaid."),
      href: "/dentist/external-consultations",
      count: unpaidConsults,
    },
  ]
    .filter((item) => item.count > 0)
    .map(({ id, fact, href }) => ({ id, fact, href }));
}

async function loadActionItems(waitingCount: number): Promise<DashboardActionItem[]> {
  const businessBrainItems = await loadBusinessBrainDashboardItems();
  if (businessBrainItems !== null) return businessBrainItems;
  return loadLegacyActionItems(waitingCount);
}
