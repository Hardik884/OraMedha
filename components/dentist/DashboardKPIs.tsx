import { getDashboardKPIs } from "@/lib/analytics/queries";
import { createServerClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CalendarDays,
  UserCheck,
  TrendingUp,
  Clock,
  AlertCircle,
  DollarSign,
  UserPlus,
  Footprints,
} from "lucide-react";

/*
 * One card style, deliberately.
 *
 * These cards used four tinted variants (mint / amber / cool / neutral), two of
 * them assigned by value — "Waiting Now" and "No-Shows" turned amber above
 * zero. That reads as severity, and severity is the one thing a count of
 * today's appointments cannot tell you: a busy clinic is not a clinic in
 * trouble, and eight amber cards on a normal Tuesday train people to ignore
 * the colour.
 *
 * So the metric row is uniform and quiet, and the things that ARE actionable
 * live in <DashboardActions>, which shows only what needs attention. Status
 * colour still means status elsewhere — queue badges, appointment states,
 * balances owed — where it distinguishes one row from another rather than
 * decorating all of them.
 */

interface KPICardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
}

function KPICard({ label, value, icon, sub }: KPICardProps) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3 sm:p-4 space-y-2 shadow-[0_1px_2px_rgba(21,25,24,0.04)] transition-shadow duration-200 hover:shadow-[0_4px_12px_-2px_rgba(21,25,24,0.06)]">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-secondary tracking-wide">{label}</p>
        <div className="h-6 w-6 rounded-lg flex items-center justify-center shrink-0 bg-surface-muted text-text-secondary">
          {icon}
        </div>
      </div>
      <div>
        <p className="text-xl sm:text-2xl font-bold text-text-primary tracking-tight leading-none">{value}</p>
        {sub && <p className="text-xs text-text-secondary mt-1">{sub}</p>}
      </div>
    </div>
  );
}

interface DashboardKPIsProps {
  /** Pre-resolved clinic ID — passed from the page to avoid a redundant auth lookup. */
  clinicId?: string;
  /** Pre-resolved clinic timezone — passed from the page to avoid a redundant settings lookup. */
  timezone?: string;
}

/**
 * DashboardKPIs — today's KPI cards for the dentist dashboard.
 *
 * When clinicId + timezone are passed as props (from the dashboard page that
 * already resolved them), no additional DB queries are fired. Falls back to
 * its own resolution for standalone use cases.
 */
export async function DashboardKPIs({ clinicId: propClinicId, timezone: propTimezone }: DashboardKPIsProps = {}) {
  const supabase = await createServerClient();

  let clinicId = propClinicId ?? "";
  let timezone = propTimezone ?? "Asia/Kolkata";

  // Only query if not provided — avoids duplicate auth+profile+settings lookups
  // when the parent page already resolved these values.
  if (!clinicId) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profileData } = user
      ? await supabase.from("profiles").select("clinic_id").eq("id", user.id).single()
      : { data: null };

    const profile = profileData as { clinic_id: string } | null;
    clinicId = profile?.clinic_id ?? "";

    if (clinicId && !propTimezone) {
      const { data: settings } = await supabase
        .from("clinic_settings")
        .select("timezone")
        .eq("clinic_id", clinicId)
        .maybeSingle();
      timezone = (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
    }
  }

  const kpis = await getDashboardKPIs(
    supabase as unknown as SupabaseClient,
    clinicId,
    timezone
  );

  const completionPct = Math.round(kpis.completionRateToday);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <KPICard
        label="Appointments"
        value={kpis.totalAppointmentsToday.toString()}
        icon={<CalendarDays className="h-3.5 w-3.5" aria-hidden />}
        sub="Today"
      />
      <KPICard
        label="Patients Seen"
        value={kpis.seenPatientsToday.toString()}
        icon={<UserCheck className="h-3.5 w-3.5" aria-hidden />}
        sub="Completed"
      />
      <KPICard
        label="Completion Rate"
        value={`${completionPct}%`}
        icon={<TrendingUp className="h-3.5 w-3.5" aria-hidden />}
        sub={kpis.totalAppointmentsToday > 0 ? `${kpis.seenPatientsToday} of ${kpis.totalAppointmentsToday}` : undefined}
      />
      <KPICard
        label="Waiting Now"
        value={kpis.waitingPatients.toString()}
        icon={<Clock className="h-3.5 w-3.5" aria-hidden />}
        sub="In queue"
      />
      <KPICard
        label="No-Shows"
        value={kpis.noShowsToday.toString()}
        icon={<AlertCircle className="h-3.5 w-3.5" aria-hidden />}
        sub="Today"
      />
      <KPICard
        label="Revenue"
        value={formatCurrency(kpis.revenueToday)}
        icon={<DollarSign className="h-3.5 w-3.5" aria-hidden />}
        sub="Today"
      />
      <KPICard
        label="New Patients"
        value={kpis.newPatientsToday.toString()}
        icon={<UserPlus className="h-3.5 w-3.5" aria-hidden />}
        sub="Registered today"
      />
      <KPICard
        label="Walk-ins"
        value={kpis.walkInsToday.toString()}
        icon={<Footprints className="h-3.5 w-3.5" aria-hidden />}
        sub="Today"
      />
    </div>
  );
}
