import type { Metadata } from "next";
import { PageHeader } from "@/components/layouts/PageHeader";
import { DashboardKPIs } from "@/components/dentist/DashboardKPIs";
import { QueueWidget } from "@/components/queue/QueueWidget";
import { DashboardActions } from "@/components/dentist/DashboardActions";
import { UpcomingAppointments } from "@/components/dentist/UpcomingAppointments";
import { ClinicDentistName } from "@/components/shared/ClinicDentistName";
import { NewInquiryButton } from "@/components/dentist/NewInquiryButton";
import { AppointmentFormDialog } from "@/components/shared/AppointmentFormDialog";
import { getTodayQueue } from "@/actions/queue";
import { getConsultancyRevenueToday } from "@/actions/consultants";
import { getClinicSettings } from "@/actions/clinic-settings";
import { getClinicConfig } from "@/lib/clinic/config";
import { getTodayInTimezone, formatCurrency } from "@/lib/utils";
import { Briefcase, Plus } from "lucide-react";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DentistDashboardPage() {
  // clinicId + timezone come from the request-scoped cached resolvers
  // (getClinicConfig → resolveSession). getTodayQueue reuses the same cached
  // session, so auth + profile are resolved once for the whole render — not
  // once per data source. clinicId/timezone are passed down so child
  // components fire no further auth/profile/settings lookups.
  const [{ clinicId, timezone }, queueRes, settingsRes, consultancyTodayRes] =
    await Promise.all([
      getClinicConfig(),
      getTodayQueue(),
      getClinicSettings(),
      getConsultancyRevenueToday(),
    ]);

  // Default the dashboard consultancy card ON when no settings row exists yet.
  const showConsultancy = settingsRes.data?.show_consultancy_on_dashboard ?? true;
  const consultancyRevenueToday = consultancyTodayRes.data ?? 0;

  if (clinicId) {
    const initialQueue = queueRes.data ?? [];
    const today = getTodayInTimezone(timezone);

    return (
      <div className="p-6 lg:p-8 max-w-screen-xl">
        <PageHeader
          title="Today's Dashboard"
          description="Overview of today's clinic activity"
        >
          <NewInquiryButton />
          <AppointmentFormDialog
            clinicToday={today}
            title="Book New Appointment"
            triggerVariant="default"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Book New Appointment
          </AppointmentFormDialog>
        </PageHeader>

        {/* Clinic dentist name (data-driven from clinics.dentist_name) */}
        <ClinicDentistName />

        {/* KPI Cards — receives pre-resolved clinicId + timezone, fires no extra queries */}
        <DashboardKPIs clinicId={clinicId} timezone={timezone} />

        {/* Today's External Consultation Income — hidden when disabled in settings */}
        {showConsultancy && (
          <div className="mt-5">
            <div className="bg-accent-subtle-bg border border-accent-tint-hover rounded-xl p-5 space-y-3 sm:max-w-xs shadow-[0_1px_2px_rgba(21,25,24,0.04)]">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-text-secondary tracking-wide">
                  External Consultation Income
                </p>
                <div className="h-7 w-7 rounded-lg bg-accent-soft flex items-center justify-center text-accent">
                  <Briefcase className="h-3.5 w-3.5" aria-hidden />
                </div>
              </div>
              <div>
                <p className="text-3xl font-bold text-text-primary tracking-tight leading-none">
                  {formatCurrency(consultancyRevenueToday)}
                </p>
                <p className="text-xs text-text-secondary mt-1.5">Today</p>
              </div>
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-6">
          <div className="lg:col-span-2 space-y-4">
            <UpcomingAppointments timezone={timezone} />
          </div>

          <div className="space-y-4">
            {/* Compact "what needs doing" list. Sits above the queue because it
                is the shorter, more urgent of the two, and because the metric
                row above is deliberately uniform — this is where attention is
                directed instead. */}
            <DashboardActions
              waitingCount={
                initialQueue.filter((entry) => entry.status === "waiting").length
              }
            />
            <QueueWidget
              initialQueue={initialQueue}
              clinicId={clinicId}
              queueHref="/dentist/queue"
            />
          </div>
        </div>
      </div>
    );
  }

  // Fallback for unauthenticated (middleware handles redirect, but be defensive)
  const queueResult = queueRes;
  return (
    <div className="p-6 lg:p-8 max-w-screen-xl">
      <PageHeader
        title="Today's Dashboard"
        description="Overview of today's clinic activity"
      >
        <NewInquiryButton />
        <AppointmentFormDialog title="Book New Appointment" triggerVariant="default">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Book New Appointment
        </AppointmentFormDialog>
      </PageHeader>
      <DashboardKPIs />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-6">
        <div className="lg:col-span-2 space-y-4">
          <UpcomingAppointments />
        </div>
        <div className="space-y-4">
          <QueueWidget
            initialQueue={queueResult.data ?? []}
            clinicId={clinicId}
            queueHref="/dentist/queue"
          />
        </div>
      </div>
    </div>
  );
}
