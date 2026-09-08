import Link from "next/link";
import { getFollowUpsForPatient, getAllFollowUps, todayForClinic } from "@/actions/follow-ups";
import { resolveSession } from "@/lib/auth/session";
import { daysBetween } from "@/lib/utils";
import { ConfirmationStatusBadge } from "./ConfirmationStatusBadge";
import { FollowUpFormDialog } from "./FollowUpFormDialog";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ACTION_BUTTON } from "@/lib/ui/action-styles";
import {
  formatDate,
  formatDateTime,
  followUpDisplayStatus,
  FOLLOW_UP_TYPE_LABELS,
} from "@/lib/utils";
import { Calendar, Stethoscope, Bell } from "lucide-react";
import type { FollowUpWithRelations } from "@/types";

interface FollowUpListProps {
  /** If provided, shows follow-ups for this specific patient only. */
  patientId?: string;
  /** If provided, shows only follow-ups with this status. Use 'overdue' for overdue filter. */
  statusFilter?: "pending" | "completed" | "cancelled" | "overdue";
  /** Whether to show the patient name column (used in clinic-wide list) */
  showPatientLink?: boolean;
  /** Base href for follow-up detail links (default: /dentist) */
  baseHref?: string;
}

/**
 * FollowUpList
 *
 * Server Component — renders follow-ups for:
 *   - A specific patient profile (patientId prop)
 *   - Clinic-wide list with optional status filter (no patientId)
 *
 * Each row shows:
 *   - Follow-up type badge
 *   - Patient name (when in clinic-wide view)
 *   - Due date with overdue/remaining indicator
 *   - Related treatment and appointment (if linked)
 *   - Status badge
 */
export async function FollowUpList({
  patientId,
  statusFilter,
  showPatientLink = false,
  baseHref = "/dentist",
}: FollowUpListProps) {
  let followUps: FollowUpWithRelations[] = [];

  if (patientId) {
    const result = await getFollowUpsForPatient(patientId);
    followUps = result.data ?? [];
  } else {
    const result = await getAllFollowUps({ status: statusFilter, limit: 100 });
    followUps = result.data?.followUps ?? [];
  }

  // "Today" in the CLINIC's own timezone, not the server's. This used to be
  // `new Date()` at render time, which on Vercel runs in UTC — for a clinic
  // ahead of UTC that disagreed with the clinic-aware queries `getAllFollowUps`
  // itself already uses about exactly when a day rolls over. Comparing plain
  // "YYYY-MM-DD" strings avoids reintroducing that class of bug: there is no
  // "now" involved in comparing two calendar dates.
  const { db, profile } = await resolveSession();
  const today = profile ? await todayForClinic(db, profile.clinic_id) : "";

  /*
   * Sort: newest first, by the date the follow-up is FOR.
   *
   * This used to hoist overdue items to the top and then sort ascending, which
   * meant the tab opened on the oldest recall in the clinic's history and a
   * follow-up created today was at the bottom. Overdue items are still marked
   * — followUpDisplayStatus gives each row its own badge — and the ones that
   * need chasing are surfaced as a worklist by getOverdueFollowUps and the
   * dashboard Actions card, which is the right place for an ordering by
   * urgency. A browsable list is ordered by recency.
   *
   * `today` is still resolved above: each row uses it for its overdue badge and
   * "days remaining" text.
   */
  const sorted = [...followUps].sort((a, b) =>
    a.due_date > b.due_date ? -1 : a.due_date < b.due_date ? 1 : 0
  );

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Follow-up Appointments</h2>
        {patientId && (
          <FollowUpFormDialog
            patientId={patientId}
            role={baseHref.includes("receptionist") ? "receptionist" : "dentist"}
            hideRelatedFields={false}
            title="New Follow-up Appointment"
            triggerClassName={ACTION_BUTTON}
          >
            <Bell className="h-3 w-3" aria-hidden />
            New Follow-up Appointment
          </FollowUpFormDialog>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="px-4 py-8 text-sm text-text-secondary text-center">
          No follow-up appointments found.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((followUp) => (
            <FollowUpRow
              key={followUp.id}
              followUp={followUp}
              today={today}
              showPatientLink={showPatientLink}
              baseHref={baseHref}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// =============================================================================
// FollowUpRow — single list item
// =============================================================================

function FollowUpRow({
  followUp,
  today,
  showPatientLink,
  baseHref,
}: {
  followUp: FollowUpWithRelations;
  /** Clinic-local "today", "YYYY-MM-DD". */
  today: string;
  showPatientLink: boolean;
  baseHref: string;
}) {
  const isOverdue = followUp.status === "pending" && followUp.due_date < today;
  const diffDays = daysBetween(today, followUp.due_date);

  const followUpType: string = followUp.follow_up_type ?? "";
  const typeLabel = FOLLOW_UP_TYPE_LABELS[followUpType] ?? followUpType ?? "Follow-up";

  return (
    <li className="hover:bg-background transition-colors">
      <Link
        href={`${baseHref}/follow-ups/${followUp.id}`}
        className="block px-4 py-3"
      >
        <div className="flex items-start justify-between gap-3">
          {/* Left: type + patient + dates + relations */}
          <div className="min-w-0 flex-1 space-y-1">
            {/* Row 1: type label + patient name */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-text-primary">{typeLabel}</span>

              {showPatientLink && followUp.patient && (
                <>
                  <span className="text-text-secondary text-xs">·</span>
                  <span className="text-xs font-medium text-accent">
                    {followUp.patient.name}
                  </span>
                  {followUp.patient.phone && (
                    <span className="text-xs text-text-secondary hidden sm:inline">
                      {followUp.patient.phone}
                    </span>
                  )}
                </>
              )}
            </div>

            {/* Row 2: due date + overdue indicator */}
            <p className="text-xs text-text-secondary">
              Due {formatDate(followUp.due_date)}
              {followUp.status === "completed" && followUp.updated_at && (
                <span className="text-success ml-2">
                  · Completed {formatDate(followUp.updated_at)}
                </span>
              )}
              {followUp.status === "pending" && isOverdue && (
                <span className="text-danger font-medium ml-2">
                  · {Math.abs(diffDays)} day{Math.abs(diffDays) !== 1 ? "s" : ""} overdue
                </span>
              )}
              {followUp.status === "pending" && !isOverdue && (
                <span className="text-warning ml-2">
                  · {diffDays === 0 ? "Due today" : `${diffDays} day${diffDays !== 1 ? "s" : ""} remaining`}
                </span>
              )}
            </p>

            {/* Row 3: notes (if present) */}
            {followUp.notes && (
              <p className="text-xs text-text-secondary truncate max-w-sm">
                {followUp.notes}
              </p>
            )}

            {/* Row 4: related appointment + treatment */}
            {(followUp.appointment || followUp.treatment) && (
              <div className="flex items-center gap-3 flex-wrap mt-0.5">
                {followUp.appointment && (
                  <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                    <Calendar className="h-3 w-3 shrink-0" aria-hidden />
                    {formatDateTime(followUp.appointment.scheduled_at)}
                  </span>
                )}
                {followUp.treatment && (
                  <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                    <Stethoscope className="h-3 w-3 shrink-0" aria-hidden />
                    {followUp.treatment.treatment_type}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right: badges */}
          <div className="flex items-center gap-2 shrink-0 mt-0.5">
            <ConfirmationStatusBadge status={followUp.confirmation_status} />
            {(() => {
              const d = followUpDisplayStatus(followUp.status, followUp.due_date, today);
              return <StatusBadge label={d.label} variant={d.variant} />;
            })()}
          </div>
        </div>
      </Link>
    </li>
  );
}
