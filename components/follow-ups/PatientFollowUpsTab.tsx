import { getFollowUpsForPatient, todayForClinic } from "@/actions/follow-ups";
import { resolveSession } from "@/lib/auth/session";
import { FollowUpFormDialog } from "./FollowUpFormDialog";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ACTION_BUTTON } from "@/lib/ui/action-styles";
import {
  daysBetween,
  formatDate,
  formatDateTime,
  followUpDisplayFromFlags,
  FOLLOW_UP_TYPE_LABELS,
} from "@/lib/utils";
import { Calendar, Stethoscope, Bell } from "lucide-react";
import type { FollowUpWithRelations } from "@/types";

interface PatientFollowUpsTabProps {
  patientId: string;
  patientName?: string;
  /** base href — controls where "New" and detail links go */
  baseHref: string;
  /** role — controls whether create button is shown */
  role: "dentist" | "receptionist";
}

/**
 * PatientFollowUpsTab
 *
 * Server Component — follow-up timeline panel on patient profile pages.
 *
 * Shows upcoming / overdue / completed / cancelled follow-ups, in that order,
 * latest due date to oldest — upcoming's dates are always later than overdue's,
 * so upcoming leads. Clicking any follow-up opens the shared inline Follow-up
 * dialog (no navigation).
 *
 * Dentist: sees "+ New Follow-Up" button.
 * Receptionist: read-only create is hidden.
 */
export async function PatientFollowUpsTab({
  patientId,
  patientName,
  role,
}: PatientFollowUpsTabProps) {
  const result = await getFollowUpsForPatient(patientId);
  const followUps: FollowUpWithRelations[] = result.data ?? [];

  // Clinic-local "today", not the server's. See the identical note in
  // FollowUpList.tsx — this used to be `new Date()` at render time, which on
  // Vercel is UTC regardless of which clinic the patient belongs to.
  const { db, profile } = await resolveSession();
  const today = profile ? await todayForClinic(db, profile.clinic_id) : "";

  const overdue  = followUps.filter((f) => f.status === "pending" && f.due_date < today);
  const upcoming = followUps.filter((f) => f.status === "pending" && f.due_date >= today);
  const completed = followUps.filter((f) => f.status === "completed");
  const cancelled = followUps.filter((f) => f.status === "cancelled");

  const dialogRole = role;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-text-primary">Follow-Ups</h3>
          {followUps.length > 0 && (
            <p className="text-xs text-text-secondary mt-0.5">
              {followUps.length} total ·{" "}
              {overdue.length > 0 && (
                <span className="text-danger font-medium">{overdue.length} overdue · </span>
              )}
              {upcoming.length} upcoming · {completed.length} completed
            </p>
          )}
        </div>
        {role === "dentist" && (
          <FollowUpFormDialog
            patientId={patientId}
            patientName={patientName}
            role={dialogRole}
            hideRelatedFields={false}
            title="New Follow-up Appointment"
            triggerClassName={ACTION_BUTTON}
          >
            <Bell className="h-3 w-3" aria-hidden />
            New Follow-Up
          </FollowUpFormDialog>
        )}
      </div>

      {result.error && (
        <p className="text-sm text-danger bg-danger-bg border border-danger-border rounded-md px-3 py-2">
          {result.error}
        </p>
      )}

      {followUps.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl px-4 py-8 text-center">
          <p className="text-sm text-text-secondary">No follow-ups recorded for this patient.</p>
          {role === "dentist" && (
            <div className="mt-3 flex justify-center">
              <FollowUpFormDialog
                patientId={patientId}
                patientName={patientName}
                role={dialogRole}
                hideRelatedFields={false}
                title="New Follow-up Appointment"
                triggerClassName={ACTION_BUTTON}
              >
                <Bell className="h-3 w-3" aria-hidden />
                Create the first follow-up
              </FollowUpFormDialog>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/*
           * Upcoming BEFORE Overdue.
           *
           * followUps arrives sorted latest-due-date-first (getFollowUpsForPatient),
           * matching the clinic-wide /dentist/follow-ups list. Every upcoming due_date
           * is >= today and every overdue one is < today, so upcoming is always the
           * chronologically LATER half of the two — rendering it first is what keeps
           * this tab's visible order latest-to-oldest instead of splitting the list at
           * "today" and inverting it.
           */}
          {/* Upcoming */}
          {upcoming.length > 0 && (
            <TimelineSection title="Upcoming">
              {upcoming.map((f) => {
                const diffDays = daysBetween(today, f.due_date);
                return (
                  <FollowUpTimelineRow
                    key={f.id}
                    followUp={f}
                    diffLabel={
                      diffDays === 0
                        ? "Due today"
                        : `${diffDays} day${diffDays !== 1 ? "s" : ""} remaining`
                    }
                    patientId={patientId}
                    patientName={patientName}
                    role={dialogRole}
                  />
                );
              })}
            </TimelineSection>
          )}

          {/* Overdue */}
          {overdue.length > 0 && (
            <TimelineSection title="Overdue" titleClass="text-danger">
              {overdue.map((f) => {
                const diffDays = daysBetween(f.due_date, today);
                return (
                  <FollowUpTimelineRow
                    key={f.id}
                    followUp={f}
                    isOverdue
                    diffLabel={`${diffDays} day${diffDays !== 1 ? "s" : ""} overdue`}
                    patientId={patientId}
                    patientName={patientName}
                    role={dialogRole}
                  />
                );
              })}
            </TimelineSection>
          )}

          {/* Completed */}
          {completed.length > 0 && (
            <TimelineSection title="Completed">
              {completed.map((f) => (
                <FollowUpTimelineRow
                  key={f.id}
                  followUp={f}
                  patientId={patientId}
                  patientName={patientName}
                  role={dialogRole}
                />
              ))}
            </TimelineSection>
          )}

          {/* Cancelled */}
          {cancelled.length > 0 && (
            <TimelineSection title="Cancelled" titleClass="text-text-secondary">
              {cancelled.map((f) => (
                <FollowUpTimelineRow
                  key={f.id}
                  followUp={f}
                  patientId={patientId}
                  patientName={patientName}
                  role={dialogRole}
                />
              ))}
            </TimelineSection>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function TimelineSection({
  title,
  titleClass = "text-text-primary",
  children,
}: {
  title: string;
  titleClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${titleClass}`}>
        {title}
      </p>
      <div className="bg-surface border border-border rounded-xl divide-y divide-border overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function FollowUpTimelineRow({
  followUp,
  isOverdue = false,
  diffLabel,
  patientId,
  patientName,
  role,
}: {
  followUp: FollowUpWithRelations;
  isOverdue?: boolean;
  diffLabel?: string;
  patientId: string;
  patientName?: string;
  role: "dentist" | "receptionist";
}) {
  const followUpType: string = followUp.follow_up_type ?? "";
  const typeLabel = FOLLOW_UP_TYPE_LABELS[followUpType] ?? followUpType ?? "Follow-up";

  return (
    <FollowUpFormDialog
      followUpId={followUp.id}
      initialData={followUp}
      patientId={patientId}
      patientName={patientName}
      role={role}
      title="Follow-up Appointment"
      triggerClassName="w-full flex items-start justify-between px-4 py-3 hover:bg-background transition-colors gap-3 text-left"
    >
      <span className="min-w-0 flex-1 space-y-1">
        {/* Type label */}
        <span className="block text-sm font-semibold text-text-primary">{typeLabel}</span>

        {/* Due date + urgency */}
        <span className="block text-xs text-text-secondary">
          Due {formatDate(followUp.due_date)}
          {followUp.status === "completed" && (
            <span className="text-success ml-2">
              · Completed {formatDate(followUp.updated_at)}
            </span>
          )}
          {diffLabel && (
            <span
              className={`ml-2 font-medium ${
                isOverdue ? "text-danger" : "text-warning"
              }`}
            >
              · {diffLabel}
            </span>
          )}
        </span>

        {/* Notes */}
        {followUp.notes && (
          <span className="block text-xs text-text-secondary truncate">{followUp.notes}</span>
        )}

        {/* Related appointment + treatment */}
        {(followUp.appointment || followUp.treatment) && (
          <span className="flex items-center gap-3 flex-wrap">
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
          </span>
        )}
      </span>

      <span className="flex items-center gap-2 shrink-0 mt-0.5">
        {(() => {
          const d = followUpDisplayFromFlags(followUp.status, isOverdue, diffLabel === "Due today");
          return <StatusBadge label={d.label} variant={d.variant} />;
        })()}
      </span>
    </FollowUpFormDialog>
  );
}
