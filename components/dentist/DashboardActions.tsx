import Link from "next/link";
import { ChevronRight, CheckCircle2, Clock, Bell, IndianRupee, Briefcase } from "lucide-react";

import { getFollowUpStats } from "@/actions/follow-ups";
import { getPatientsWithOutstandingBalance } from "@/actions/payments";
import { getUnpaidConsultationCount } from "@/actions/consultants";

interface DashboardActionsProps {
  /** Patients waiting in today's queue. Passed from the page, which has already
   * loaded the queue — this component fires no queue query of its own. */
  waitingCount: number;
}

/**
 * DashboardActions — the "what needs doing" card on the dashboard's right rail.
 *
 * WHY THIS EXISTS
 *   The KPI row above it is deliberately uniform and quiet (see DashboardKPIs):
 *   a count of today's appointments is information, not a call to action, and
 *   colouring it by value trains people to ignore colour. The things that ARE
 *   actionable are a different, much shorter list — and they were previously
 *   only discoverable by visiting four separate pages.
 *
 * WHAT IT IS NOT
 *   Not a detail panel. Each row is a count and a link; the page it links to is
 *   where the work happens. Rows with nothing to do are hidden entirely, so the
 *   card is short on a normal day and the empty state is a genuine "all clear"
 *   rather than four zeroes.
 *
 * Every figure comes from an existing action — no new aggregation, and the
 * outstanding-balance count reuses the SQL aggregate added in 20260907000200.
 */
export async function DashboardActions({ waitingCount }: DashboardActionsProps) {
  const [followUpStats, outstanding, unpaidConsultations] = await Promise.all([
    getFollowUpStats(),
    getPatientsWithOutstandingBalance(),
    getUnpaidConsultationCount(),
  ]);

  const overdueFollowUps = followUpStats.data?.overdue ?? 0;
  const dueToday = followUpStats.data?.pending ?? 0;
  const owingPatients = outstanding.data?.length ?? 0;
  const unpaidConsults = unpaidConsultations.data ?? 0;

  const items = [
    {
      key: "waiting",
      label: "Waiting in queue",
      count: waitingCount,
      href: "/dentist/queue",
      icon: <Clock className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      key: "overdue",
      label: "Overdue follow-ups",
      count: overdueFollowUps,
      href: "/dentist/follow-ups?status=overdue",
      icon: <Bell className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      key: "pending-followups",
      label: "Follow-ups pending",
      count: dueToday,
      href: "/dentist/follow-ups?status=pending",
      icon: <Bell className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      key: "balances",
      label: "Patients owing",
      count: owingPatients,
      href: "/dentist/payments",
      icon: <IndianRupee className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      key: "consultations",
      label: "Consultations unpaid",
      count: unpaidConsults,
      href: "/dentist/external-consultations",
      icon: <Briefcase className="h-3.5 w-3.5" aria-hidden />,
    },
  ].filter((item) => item.count > 0);

  return (
    <div className="bg-surface border border-border rounded-xl">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary">Actions</h2>
        <p className="text-xs text-text-secondary mt-0.5">
          {items.length > 0 ? "Needs your attention" : "Nothing outstanding"}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="px-4 py-5 flex items-center gap-2.5 text-text-secondary">
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" aria-hidden />
          <p className="text-xs">You&apos;re all caught up.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-muted transition-colors group"
              >
                <span className="h-6 w-6 rounded-lg bg-surface-muted text-text-secondary flex items-center justify-center shrink-0">
                  {item.icon}
                </span>
                <span className="text-xs text-text-body flex-1 min-w-0 truncate">
                  {item.label}
                </span>
                <span className="text-sm font-semibold text-text-primary tabular-nums">
                  {item.count}
                </span>
                <ChevronRight
                  className="h-3.5 w-3.5 text-text-disabled group-hover:text-text-secondary transition-colors shrink-0"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
