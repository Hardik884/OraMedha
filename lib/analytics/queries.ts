/**
 * Analytics query builders — fully implemented.
 *
 * All functions:
 * - Accept { clinicId, dateFrom, dateTo } filter.
 * - Return typed result objects defined in types/index.ts.
 * - Use the Supabase server client — called from Server Components / Actions.
 * - Are read-only — no mutations.
 * - Accessible to dentist role only (enforced by RLS + layout guard).
 *
 * Note on typing: the @supabase/ssr createServerClient wraps the underlying
 * typed client in a way that causes TypeScript to infer `never` for some table
 * types in strict mode. We follow the same pattern used in actions/*.ts and
 * accept the client as `DbClient = any`. All data arrays are explicitly typed
 * after fetch to retain application-level type safety.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type DbClient = any;

import type {
  AppointmentAnalytics,
  PatientAnalytics,
  TreatmentAnalytics,
  RevenueAnalytics,
  SourceAnalytics,
  FollowUpAnalytics,
  DashboardKPIs,
  AppointmentSource,
  PaymentMethod,
  AppointmentStatus,
} from "@/types";
import { fetchAllRows } from "./fetch-all";
import { computeClinicOutstandingBalance, isBillableTreatment } from "@/lib/billing/balance";
import { treatmentClinicShare } from "@/lib/billing/revenue";
import { sumEarnedConsultantPayouts } from "@/lib/billing/payout";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { countOperatingDays, type AvailabilityRule } from "@/lib/scheduling/slots";

export interface DateRangeFilter {
  clinicId: string;
  dateFrom: string;
  dateTo: string;
  /** IANA timezone for the clinic — e.g. "Asia/Kolkata". Defaults to UTC. */
  timezone?: string;
}

// Range boundaries for a clinic-local calendar date, as UTC instants for
// `timestamptz` comparisons. The `timezone` is REQUIRED so no caller can slip
// back to a naive UTC-midnight boundary that drops or misplaces rows near local
// midnight for a non-UTC clinic (audit A16). Delegates to the same helper the
// dashboard KPIs already use, so every range reads the day the same way.
function startOf(date: string, timezone: string): string {
  return utcBoundariesForLocalDate(date, timezone).start;
}
function endOf(date: string, timezone: string): string {
  return utcBoundariesForLocalDate(date, timezone).end;
}

/**
 * The clinic-local calendar date ("YYYY-MM-DD") of a UTC timestamp. Use this to
 * bucket rows by day so an appointment at 03:30 UTC (09:00 IST) counts on the
 * clinic's day, matching the peak-hours buckets rather than the UTC date that
 * `scheduled_at.split("T")[0]` returns (audit A16).
 */
function localDateInTz(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * utcBoundariesForLocalDate
 *
 * Returns the UTC ISO timestamps for the start and end of a clinic-local date.
 * Delegates to the canonical `getUtcBoundariesForLocalDate` in `lib/utils` so
 * analytics shares ONE timezone implementation with the rest of the app — the
 * previous local copy truncated seconds and folded the end-of-day `.999` ms into
 * a `.998Z` value, overlapping consecutive days by ~1s.
 */
function utcBoundariesForLocalDate(
  localDate: string,
  timezone: string
): { start: string; end: string } {
  return getUtcBoundariesForLocalDate(localDate, timezone);
}

// =============================================================================
// Row shapes — used to type-cast Supabase results
// =============================================================================

interface ApptRow {
  status: AppointmentStatus;
  source: AppointmentSource;
  scheduled_at: string;
  duration_minutes: number;
  patient_id?: string;
}
interface PatientRow {
  id: string;
  name: string;
  created_at: string;
  date_of_birth: string | null;
  gender: string | null;
  total_visits: number;
  last_visit: string | null;
}
interface PaymentRow {
  amount: number;
  method: PaymentMethod;
  payment_date: string;
  patient_id: string;
  appointment_id: string | null;
}
interface TreatmentRow {
  id: string;
  treatment_type: string;
  cost: number;
  clinic_share: number | null;
  consultant_share: number | null;
  consultant_id: string | null;
  status: string;
  // Ancillary charges — part of what the patient owes for this treatment, and
  // settled ahead of treatment cost when crediting a consultant payout.
  opd_charged: boolean | null;
  opd_fee: number | null;
  xray_taken: boolean | null;
  xray_cost: number | null;
  performed_at: string | null;
  created_at: string;
  patient_id: string;
}
interface FollowUpRow {
  status: string;
  due_date: string;
  created_at: string;
  updated_at: string;
}
interface QueueRow {
  status: string;
  checked_in_at: string;
  called_at: string | null;
}

// =============================================================================
// getDashboardKPIs — today-only, used by dentist dashboard
// =============================================================================

export async function getDashboardKPIs(
  supabase: DbClient,
  clinicId: string,
  /** IANA timezone for the clinic — e.g. "Asia/Kolkata". Defaults to UTC. */
  timezone: string = "Asia/Kolkata"
): Promise<DashboardKPIs> {
  // Compute "today" in the clinic's local calendar so a clinic in IST at
  // 01:00 doesn't query against the previous UTC date and miss appointments.
  const todayDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // Convert local day boundaries to UTC ISO strings for timestamptz queries.
  const { start: todayStartIso, end: todayEndIso } = utcBoundariesForLocalDate(
    todayDate,
    timezone
  );

  const [apptRes, queueRes, revenueRes, newPatientsRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("status, source")
      .eq("clinic_id", clinicId)
      .is("deleted_at", null)
      .gte("scheduled_at", todayStartIso)
      .lte("scheduled_at", todayEndIso),

    supabase
      .from("queue_entries")
      .select("status")
      .eq("clinic_id", clinicId)
      .eq("queue_date", todayDate),

    supabase
      .from("payments")
      .select("amount")
      .eq("clinic_id", clinicId)
      .is("deleted_at", null)
      .eq("payment_date", todayDate),

    supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .is("deleted_at", null)
      .gte("created_at", todayStartIso)
      .lte("created_at", todayEndIso),
  ]);

  const appointments = (apptRes.data ?? []) as Pick<ApptRow, "status" | "source">[];
  const queueEntries = (queueRes.data ?? []) as Pick<QueueRow, "status">[];
  const payments = (revenueRes.data ?? []) as Pick<PaymentRow, "amount">[];

  const totalAppointmentsToday = appointments.length;
  const seenPatientsToday = appointments.filter((a) => a.status === "completed").length;
  const noShowsToday = appointments.filter((a) => a.status === "no_show").length;
  const walkInsToday = appointments.filter((a) => a.source === "walk_in").length;
  const waitingPatients = queueEntries.filter((q) => q.status === "waiting").length;
  const revenueToday = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const completionRateToday =
    totalAppointmentsToday > 0
      ? Math.round((seenPatientsToday / totalAppointmentsToday) * 100)
      : 0;

  return {
    totalAppointmentsToday,
    seenPatientsToday,
    completionRateToday,
    waitingPatients,
    noShowsToday,
    revenueToday,
    newPatientsToday: newPatientsRes.count ?? 0,
    walkInsToday,
  };
}

// =============================================================================
// getAnalyticsSummary — all headline KPIs for the analytics dashboard overview
// =============================================================================

export interface AnalyticsSummary {
  totalAppointments: number;
  appointmentsToday: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  totalPatients: number;
  newPatientsThisMonth: number;
  returningPatients: number;
  activePatients: number;
  /** Gross payments collected in range (patients pay the full amount). */
  totalRevenue: number;
  revenueThisMonth: number;
  outstandingBalances: number;
  avgRevenuePerPatient: number;
  /** Total consultant payouts for treatments in range. */
  consultantPayouts: number;
  /** Net clinic revenue = gross payments − consultant payouts. */
  netClinicRevenue: number;
  /** External consultancy income the dentist recorded in range. */
  consultancyIncome: number;
  /** Net clinic revenue + external consultancy income. */
  totalIncome: number;
  pendingFollowUps: number;
  completedFollowUps: number;
  overdueFollowUps: number;
  avgWaitTimeMinutes: number;
  patientsServedToday: number;
  currentWaitingCount: number;
}

export async function getAnalyticsSummary(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<AnalyticsSummary> {
  const { clinicId, dateFrom, dateTo } = filter;
  const timezone = filter.timezone ?? "Asia/Kolkata";

  // Compute "today" in the clinic's local calendar (not server-local or UTC).
  const todayDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  // Build UTC boundaries for today using the clinic timezone so the query
  // doesn't miss appointments on either side of UTC midnight.
  const { start: todayStartIso, end: todayEndIso } = utcBoundariesForLocalDate(todayDate, timezone);

  // First day of the current month in the clinic's local calendar
  const [yr, mo] = todayDate.split("-").map(Number);
  const monthStartDate = `${yr}-${String(mo).padStart(2, "0")}-01`;
  const { start: monthStartIso } = utcBoundariesForLocalDate(monthStartDate, timezone);

  const today = todayDate;

  /*
   * Every row-returning query below goes through fetchAllRows.
   *
   * PostgREST caps a response at max_rows (1000) and truncates SILENTLY past
   * it — 200 OK, no error, fewer rows. Several of these are not even date-
   * bounded (every treatment and every patient in the clinic), so every figure
   * on this dashboard was correct only while the clinic was small and would
   * then have drifted downward with nothing to indicate it. See
   * lib/analytics/fetch-all.ts.
   *
   * newPatientsMonthRes is exempt: it is a head-only exact COUNT, which the cap
   * does not apply to.
   */
  const [
    appointments, appointmentsToday, patients, newPatientsMonthRes,
    payments, treatments, followUps, queueToday,
    consultancyRows, allPayments,
  ] = await Promise.all([
    fetchAllRows<ApptRow>(() =>
      supabase
        .from("appointments")
        // patient_id is needed to scope "returning"/"active" patients to THIS
        // range's completed visits, instead of the lifetime total_visits column
        // (audit B7).
        .select("status, source, scheduled_at, duration_minutes, patient_id")
        .eq("clinic_id", clinicId).is("deleted_at", null)
        .gte("scheduled_at", startOf(dateFrom, timezone)).lte("scheduled_at", endOf(dateTo, timezone)),
      "analytics: appointments in range"),

    fetchAllRows<Pick<ApptRow, "status" | "source">>(() =>
      supabase
        .from("appointments")
        .select("status, source")
        .eq("clinic_id", clinicId).is("deleted_at", null)
        .gte("scheduled_at", todayStartIso).lte("scheduled_at", todayEndIso),
      "analytics: appointments today"),

    fetchAllRows<Pick<PatientRow, "id" | "created_at" | "total_visits" | "last_visit">>(() =>
      supabase
        .from("patients")
        .select("id, created_at, total_visits, last_visit")
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: patients"),

    supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("created_at", monthStartIso),

    fetchAllRows<Pick<PaymentRow, "amount" | "patient_id" | "payment_date">>(() =>
      supabase
        .from("payments")
        .select("amount, patient_id, payment_date")
        .eq("clinic_id", clinicId).is("deleted_at", null)
        .gte("payment_date", dateFrom).lte("payment_date", dateTo),
      "analytics: payments in range"),

    fetchAllRows<Pick<TreatmentRow,
      | "id" | "cost" | "clinic_share" | "consultant_share" | "consultant_id"
      | "patient_id" | "status" | "opd_charged" | "opd_fee" | "xray_taken"
      | "xray_cost" | "performed_at" | "created_at">>(() =>
      supabase
        .from("treatments")
        // id / consultant_id / the ancillary-charge columns / performed_at are
        // required by the payout allocator (lib/billing/payout.ts), which needs
        // to know each treatment's full charge and when it happened.
        .select(
          "id, cost, clinic_share, consultant_share, consultant_id, patient_id, status, " +
            "opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at"
        )
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: treatments"),

    fetchAllRows<Pick<FollowUpRow, "status" | "due_date" | "updated_at">>(() =>
      supabase
        .from("follow_ups")
        // updated_at is needed to scope "completed follow-ups" to this range
        // (audit B7) — status/due_date alone can't tell WHEN a follow-up was
        // completed.
        .select("status, due_date, updated_at")
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: follow-ups"),

    fetchAllRows<QueueRow>(() =>
      supabase
        .from("queue_entries")
        .select("status, checked_in_at, called_at")
        .eq("clinic_id", clinicId)
        .eq("queue_date", todayDate),
      "analytics: queue today"),

    fetchAllRows<{ amount: number; date: string }>(() =>
      supabase
        .from("consultancy_income")
        .select("amount, date")
        .eq("clinic_id", clinicId)
        .gte("date", dateFrom).lte("date", dateTo),
      "analytics: consultancy income"),

    // Deliberately UNBOUNDED by date. Consultant payouts are earned from money
    // collected, so working out what a treatment has been paid needs its whole
    // payment history — a treatment billed last year and settled today is only
    // visible if both ends are in scope. The date range is applied afterwards,
    // by differencing two cumulative positions. Unbounded is exactly why it
    // must be paged.
    fetchAllRows<{ amount: number; treatment_id: string | null; payment_date: string; patient_id: string }>(() =>
      supabase
        .from("payments")
        .select("amount, treatment_id, payment_date, patient_id")
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: all payments"),
  ]);


  const totalAppointments = appointments.length;
  const completedAppointments = appointments.filter((a) => a.status === "completed").length;
  const cancelledAppointments = appointments.filter((a) => a.status === "cancelled").length;
  const noShowAppointments = appointments.filter((a) => a.status === "no_show").length;
  const appointmentsTodayCount = appointmentsToday.length;

  const totalPatients = patients.length;
  const newPatientsThisMonth = newPatientsMonthRes.count ?? 0;

  // "Returning"/"Active" are scoped to the SELECTED range (audit B7), not the
  // lifetime total_visits/last_visit columns — a patient who visited twice
  // three years ago and never since must not read as "active" for this range.
  // Completed visits IN RANGE, grouped by patient.
  const completedVisitsByPatient = new Map<string, number>();
  for (const a of appointments) {
    if (a.status !== "completed" || !a.patient_id) continue;
    completedVisitsByPatient.set(a.patient_id, (completedVisitsByPatient.get(a.patient_id) ?? 0) + 1);
  }
  const returningPatients = [...completedVisitsByPatient.values()].filter((n) => n > 1).length;
  const activePatients = completedVisitsByPatient.size;

  const totalRevenue = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const revenueThisMonth = payments
    .filter((p) => p.payment_date >= monthStartDate)
    .reduce((sum, p) => sum + (p.amount ?? 0), 0);

  // allPayments — the clinic's ENTIRE payment history (unbounded by date) — is
  // resolved by the paged read above. It feeds both the point-in-time
  // outstanding balance below and the consultant-payout differencing further
  // down, and being unbounded is exactly why it must be paged rather than
  // truncated at 1,000 rows.

  // Outstanding = each patient's own max(0, their charges − their payments),
  // summed (audit A5). Two things this MUST get right and the old code did not:
  //  • use ALL payments, not just the ones in the selected date range — a
  //    balance is a point-in-time total, so subtracting only 30 days of
  //    collections from all-time charges over-stated it massively;
  //  • clamp PER PATIENT — one patient's overpayment can't erase another's debt.
  // `treatments` is already all-time. Both carry patient_id, so
  // computeClinicOutstandingBalance reconciles this figure with the sum of the
  // patient-profile balances it summarises.
  const outstandingBalances = computeClinicOutstandingBalance(treatments, allPayments);

  // ── Consultant payouts + net clinic revenue ──────────────────────────────
  // Payouts are EARNED FROM MONEY COLLECTED, not accrued against treatment
  // value. Previously this summed `consultant_share` for treatments created in
  // the range, which booked a ₹4,000 payout on a ₹10,000 treatment the moment
  // it was recorded — before the patient had paid a rupee, and irreversibly if
  // they never returned. See lib/billing/payout.ts.
  //
  // "Payout earned during this range" is the difference between two cumulative
  // positions: what has been earned including payments up to the end of the
  // range, less what had already been earned before it began. That differencing
  // is what confines the figure to the range without ever splitting a single
  // payment across two buckets, so consecutive ranges sum to the whole.
  const paymentsThrough = (endDate: string) =>
    allPayments.filter((p) => p.payment_date <= endDate);
  const paymentsBefore = (startDate: string) =>
    allPayments.filter((p) => p.payment_date < startDate);

  const earnedThroughRangeEnd = sumEarnedConsultantPayouts(treatments, paymentsThrough(dateTo));
  const earnedBeforeRange = sumEarnedConsultantPayouts(treatments, paymentsBefore(dateFrom));
  const consultantPayouts = Math.max(0, earnedThroughRangeEnd - earnedBeforeRange);

  const netClinicRevenue = Math.max(0, totalRevenue - consultantPayouts);
  const consultancyIncome = consultancyRows.reduce((sum, c) => sum + Number(c.amount ?? 0), 0);
  const totalIncome = netClinicRevenue + consultancyIncome;

  const patientsWithPayments = new Set(payments.map((p) => p.patient_id)).size;
  const avgRevenuePerPatient = patientsWithPayments > 0 ? totalRevenue / patientsWithPayments : 0;

  // Pending/overdue are a CURRENT BACKLOG snapshot ("what's outstanding right
  // now"), not activity that happened during the range — legitimately all-time,
  // left as-is (audit B7; the UI carries an explicit "all-time" label for these).
  const pendingFollowUps = followUps.filter((f) => f.status === "pending").length;
  const overdueFollowUps = followUps.filter(
    (f) => f.status === "pending" && f.due_date < today
  ).length;
  // "Completed" IS an activity metric ("how many were resolved"), so it must
  // respect the selected range — mirrors getFollowUpAnalytics's completedInRange
  // exactly (audit B7).
  const completedFollowUps = followUps.filter(
    (f) =>
      f.status === "completed" &&
      f.updated_at >= startOf(dateFrom, timezone) &&
      f.updated_at <= endOf(dateTo, timezone),
  ).length;

  const completedQueueEntries = queueToday.filter((q) => q.status === "completed");
  const patientsServedToday = completedQueueEntries.length;
  const currentWaitingCount = queueToday.filter((q) => q.status === "waiting").length;

  const waitTimes = completedQueueEntries
    .filter((q) => q.called_at && q.checked_in_at)
    .map((q) => (new Date(q.called_at!).getTime() - new Date(q.checked_in_at).getTime()) / 60000);
  const avgWaitTimeMinutes =
    waitTimes.length > 0 ? Math.round(waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length) : 0;

  void todayDate;

  return {
    totalAppointments, appointmentsToday: appointmentsTodayCount,
    completedAppointments, cancelledAppointments, noShowAppointments,
    totalPatients, newPatientsThisMonth, returningPatients, activePatients,
    totalRevenue, revenueThisMonth, outstandingBalances, avgRevenuePerPatient,
    consultantPayouts, netClinicRevenue, consultancyIncome, totalIncome,
    pendingFollowUps, completedFollowUps, overdueFollowUps,
    avgWaitTimeMinutes, patientsServedToday, currentWaitingCount,
  };
}

// =============================================================================
// getAppointmentAnalytics
// =============================================================================

export async function getAppointmentAnalytics(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<AppointmentAnalytics> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const [{ data }, rulesRes, unavailableRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("status, scheduled_at, source")
      .eq("clinic_id", clinicId)
      .is("deleted_at", null)
      .gte("scheduled_at", startOf(dateFrom, tz))
      .lte("scheduled_at", endOf(dateTo, tz)),

    // Operating-day denominator for averagePerDay (audit B6) — same rule/
    // closure shape lib/business-brain/metrics-repository.ts already fetches.
    supabase
      .from("availability_rules")
      .select("day_of_week, start_time, end_time, slot_duration_minutes")
      .eq("clinic_id", clinicId)
      .eq("is_active", true),
    supabase
      .from("unavailable_dates")
      .select("date")
      .eq("clinic_id", clinicId)
      .gte("date", dateFrom)
      .lte("date", dateTo),
  ]);

  const rows = (data ?? []) as ApptRow[];

  // Group by date + status
  const byStatusMap: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const date = localDateInTz(row.scheduled_at, tz);
    if (!byStatusMap[date]) byStatusMap[date] = {};
    byStatusMap[date][row.status] = (byStatusMap[date][row.status] ?? 0) + 1;
  }
  const byStatus: AppointmentAnalytics["byStatus"] = [];
  for (const [date, statuses] of Object.entries(byStatusMap)) {
    for (const [status, count] of Object.entries(statuses)) {
      byStatus.push({ date, status: status as AppointmentStatus, count });
    }
  }
  byStatus.sort((a, b) => a.date.localeCompare(b.date));

  const dailyTotals: Record<string, { total: number; cancelled: number; noShow: number }> = {};
  for (const row of rows) {
    const date = localDateInTz(row.scheduled_at, tz);
    if (!dailyTotals[date]) dailyTotals[date] = { total: 0, cancelled: 0, noShow: 0 };
    dailyTotals[date].total += 1;
    if (row.status === "cancelled") dailyTotals[date].cancelled += 1;
    if (row.status === "no_show") dailyTotals[date].noShow += 1;
  }

  const cancellationRate: AppointmentAnalytics["cancellationRate"] = [];
  const noShowRate: AppointmentAnalytics["noShowRate"] = [];
  for (const [date, counts] of Object.entries(dailyTotals)) {
    cancellationRate.push({
      date,
      rate: counts.total > 0 ? Math.round((counts.cancelled / counts.total) * 100) : 0,
    });
    noShowRate.push({
      date,
      rate: counts.total > 0 ? Math.round((counts.noShow / counts.total) * 100) : 0,
    });
  }

  // Operating days, not calendar days and not "days that happened to have an
  // appointment" — a clinic open 26 days in a 30-day range with bookings on
  // only 20 of them must divide by 26, not 20 (audit B6). A closed day is
  // never counted as a zero-appointment operating day.
  const rulesByDayOfWeek = new Map<number, AvailabilityRule[]>();
  for (const r of (rulesRes.data ?? []) as {
    day_of_week: number;
    start_time: string;
    end_time: string;
    slot_duration_minutes: number;
  }[]) {
    const list = rulesByDayOfWeek.get(r.day_of_week) ?? [];
    list.push({
      startTime: r.start_time.slice(0, 5),
      endTime: r.end_time.slice(0, 5),
      slotDurationMinutes: r.slot_duration_minutes,
    });
    rulesByDayOfWeek.set(r.day_of_week, list);
  }
  const closedDates = new Set(
    ((unavailableRes.data ?? []) as { date: string }[]).map((u) => u.date),
  );
  const operatingDays = countOperatingDays(dateFrom, dateTo, rulesByDayOfWeek, closedDates);
  const averagePerDay = operatingDays > 0 ? Math.round(rows.length / operatingDays) : 0;

  // Build peak hours using the clinic's local timezone so that a 9:00 AM
  // appointment stored as 03:30 UTC (Asia/Kolkata) is bucketed into hour 9,
  // not hour 3. getUTCHours() / getUTCDay() would produce wrong buckets for
  // any timezone that is not UTC. (tz resolved at the top of this function.)
  const peakMap: Record<string, number> = {};
  for (const row of rows) {
    const dt = new Date(row.scheduled_at);
    // Extract local hour and day-of-week using Intl — works for any IANA timezone
    const localParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      weekday: "short",
      hour12: false,
    }).formatToParts(dt);
    const hourStr = localParts.find((p) => p.type === "hour")?.value ?? "0";
    const weekdayStr = localParts.find((p) => p.type === "weekday")?.value ?? "Sun";
    const DOW_MAP: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    // Intl hour12:false returns "24" for midnight on some platforms — normalise
    const hour = parseInt(hourStr) % 24;
    const dayOfWeek = DOW_MAP[weekdayStr] ?? 0;
    const key = `${hour}:${dayOfWeek}`;
    peakMap[key] = (peakMap[key] ?? 0) + 1;
  }
  const peakHours: AppointmentAnalytics["peakHours"] = Object.entries(peakMap).map(([key, count]) => {
    const [hour, dayOfWeek] = key.split(":").map(Number);
    return { hour, dayOfWeek, count };
  });

  return { byStatus, cancellationRate, noShowRate, averagePerDay, peakHours };
}

// =============================================================================
// getPatientAnalytics
// =============================================================================

export async function getPatientAnalytics(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<PatientAnalytics> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const [data, apptRes] = await Promise.all([
    // Unbounded by date — every patient the clinic has. Paged, or it truncates
    // at max_rows and the age/gender distributions quietly describe a subset.
    fetchAllRows<PatientRow>(() =>
      supabase
        .from("patients")
        .select("id, name, created_at, date_of_birth, gender, total_visits")
        .eq("clinic_id", clinicId)
        .is("deleted_at", null),
      "analytics: patient analytics — patients"),
    // Completed visits IN RANGE, per patient — "returning"/"top" patients must
    // reflect the selected period, not the lifetime total_visits column
    // (audit B7).
    supabase
      .from("appointments")
      .select("patient_id, status")
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .eq("status", "completed")
      .gte("scheduled_at", startOf(dateFrom, tz)).lte("scheduled_at", endOf(dateTo, tz)),
  ]);

  const rows = (data ?? []) as PatientRow[];
  const completedInRangeRows = (apptRes.data ?? []) as { patient_id: string; status: string }[];
  const visitsInRangeByPatient = new Map<string, number>();
  for (const a of completedInRangeRows) {
    visitsInRangeByPatient.set(a.patient_id, (visitsInRangeByPatient.get(a.patient_id) ?? 0) + 1);
  }

  const newInRange = rows.filter(
    (p) => p.created_at >= startOf(dateFrom, tz) && p.created_at <= endOf(dateTo, tz)
  );
  const newByDate: Record<string, number> = {};
  for (const p of newInRange) {
    const date = localDateInTz(p.created_at, tz);
    newByDate[date] = (newByDate[date] ?? 0) + 1;
  }
  const newPatientsOverTime = Object.entries(newByDate)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const returningVsNew = {
    returning: [...visitsInRangeByPatient.values()].filter((n) => n > 1).length,
    // "new" here means seen exactly once in this range OR not seen at all in
    // it (a patient with zero completed visits in range is neither new nor
    // returning within it, but the pre-existing shape is a two-way split, so
    // anyone not counted as returning falls to "new" — unchanged from before,
    // just now scoped to the range's own visits instead of lifetime ones).
    new: rows.length - [...visitsInRangeByPatient.values()].filter((n) => n > 1).length,
  };

  const now = new Date();
  const ageGroups: Record<string, number> = {
    "0-17": 0, "18-30": 0, "31-45": 0, "46-60": 0, "61+": 0,
  };
  for (const p of rows) {
    if (!p.date_of_birth) continue;
    const dob = new Date(p.date_of_birth);
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
    if (age < 18) ageGroups["0-17"]++;
    else if (age <= 30) ageGroups["18-30"]++;
    else if (age <= 45) ageGroups["31-45"]++;
    else if (age <= 60) ageGroups["46-60"]++;
    else ageGroups["61+"]++;
  }
  const ageDistribution = Object.entries(ageGroups).map(([ageGroup, count]) => ({ ageGroup, count }));

  const genderMap: Record<string, number> = {};
  for (const p of rows) {
    const g = p.gender ?? "unknown";
    genderMap[g] = (genderMap[g] ?? 0) + 1;
  }
  const genderBreakdown = Object.entries(genderMap).map(([gender, count]) => ({ gender, count }));

  // Ranked by visits WITHIN the range, not lifetime total_visits (audit B7) —
  // a patient who visited heavily years ago but not at all in this range must
  // not outrank one who is genuinely this period's most frequent visitor.
  const topPatients = [...rows]
    .map((p) => ({ patientId: p.id, name: p.name, visits: visitsInRangeByPatient.get(p.id) ?? 0 }))
    .filter((p) => p.visits > 0)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 10);

  return { newPatientsOverTime, returningVsNew, ageDistribution, genderBreakdown, topPatients };
}

// =============================================================================
// getTreatmentAnalytics
// =============================================================================

export async function getTreatmentAnalytics(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<TreatmentAnalytics> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const { data } = await supabase
    .from("treatments")
    .select("treatment_type, cost, clinic_share, consultant_share, status, performed_at")
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .gte("created_at", startOf(dateFrom, tz))
    .lte("created_at", endOf(dateTo, tz));

  const rows = (data ?? []) as TreatmentRow[];

  // totalCost = gross (average treatment price); totalRevenue = net clinic_share.
  // Both are accumulated ONLY over billable (completed/in_progress) treatments
  // (audit B5) — a cancelled or still-planned treatment isn't real delivered
  // work, and letting it into "average cost" or "revenue by type" understated
  // the true average and overstated revenue for types with a lot of no-shows.
  // `count`/`byType` stay all-status: "most common treatment types" is legitimately
  // about what gets BOOKED, not what gets billed.
  const typeMap: Record<
    string,
    { count: number; billableCount: number; totalCost: number; totalRevenue: number; completedCount: number }
  > = {};
  let completedCount = 0;
  for (const t of rows) {
    const tt = t.treatment_type ?? "Other";
    if (!typeMap[tt]) {
      typeMap[tt] = { count: 0, billableCount: 0, totalCost: 0, totalRevenue: 0, completedCount: 0 };
    }
    typeMap[tt].count += 1;
    if (isBillableTreatment(t.status)) {
      typeMap[tt].billableCount += 1;
      typeMap[tt].totalCost += Number(t.cost ?? 0);
      typeMap[tt].totalRevenue += treatmentClinicShare(t);
    }
    if (t.status === "completed") {
      typeMap[tt].completedCount += 1;
      completedCount++;
    }
  }

  const byType = Object.entries(typeMap)
    .map(([treatmentType, v]) => ({ treatmentType, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const avgCostByType = Object.entries(typeMap).map(([treatmentType, v]) => ({
    treatmentType,
    avgCost: v.billableCount > 0 ? Math.round((v.totalCost / v.billableCount) * 100) / 100 : 0,
  }));

  const revenueByType = Object.entries(typeMap)
    .map(([treatmentType, v]) => ({ treatmentType, revenue: v.totalRevenue }))
    .sort((a, b) => b.revenue - a.revenue);

  const completionRate = rows.length > 0 ? Math.round((completedCount / rows.length) * 100) : 0;

  return { byType, avgCostByType, completionRate, revenueByType };
}

// =============================================================================
// getRevenueAnalytics
// =============================================================================

export async function getRevenueAnalytics(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<RevenueAnalytics> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const [paymentsRes, treatmentsRes, appointmentsRes, allPaymentsRes] = await Promise.all([
    supabase
      .from("payments")
      .select("amount, method, payment_date, patient_id, appointment_id")
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("payment_date", dateFrom).lte("payment_date", dateTo),

    // Unbounded by date: an outstanding balance is a point-in-time total, so it
    // needs the whole history. Paged for that reason.
    fetchAllRows<TreatmentRow>(() =>
      supabase
        .from("treatments")
        .select("cost, patient_id, status, opd_charged, opd_fee, xray_taken, xray_cost")
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: revenue — treatments"),

    supabase
      .from("appointments")
      .select("id, source, status")
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("scheduled_at", startOf(dateFrom, tz)).lte("scheduled_at", endOf(dateTo, tz)),

    // Outstanding is a point-in-time balance, so it needs ALL payments, not just
    // the ones in the selected range (audit A5).
    fetchAllRows<{ amount: number; patient_id: string | null }>(() =>
      supabase
        .from("payments")
        .select("amount, patient_id")
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: revenue — all payments"),
  ]);

  const payments = (paymentsRes.data ?? []) as PaymentRow[];
  const treatments = treatmentsRes;
  const allPayments = allPaymentsRes;
  const appts = (appointmentsRes.data ?? []) as Array<{ id: string; source: AppointmentSource; status: AppointmentStatus }>;

  const overTimeMap: Record<string, number> = {};
  for (const p of payments) {
    overTimeMap[p.payment_date] = (overTimeMap[p.payment_date] ?? 0) + (p.amount ?? 0);
  }
  const overTime = Object.entries(overTimeMap)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const methodMap: Record<string, number> = {};
  for (const p of payments) {
    methodMap[p.method] = (methodMap[p.method] ?? 0) + (p.amount ?? 0);
  }
  const byPaymentMethod = Object.entries(methodMap).map(([method, amount]) => ({
    method: method as PaymentMethod,
    amount,
  }));

  const apptSourceMap: Record<string, string> = {};
  for (const a of appts) {
    apptSourceMap[a.id] = a.source;
  }
  const sourceRevenueMap: Record<string, number> = {};
  for (const p of payments) {
    const src = p.appointment_id ? (apptSourceMap[p.appointment_id] ?? "other") : "other";
    sourceRevenueMap[src] = (sourceRevenueMap[src] ?? 0) + (p.amount ?? 0);
  }
  const bySource = Object.entries(sourceRevenueMap).map(([source, amount]) => ({
    source: source as AppointmentSource,
    amount,
  }));

  // Same reasoning as getAnalyticsSummary: outstanding is each patient's own
  // max(0, cost + OPD + X-ray − ALL their payments), summed per patient (A5).
  const outstandingTotal = computeClinicOutstandingBalance(treatments, allPayments);

  // Revenue attributable to completed appointments only (audit B4) — not every
  // payment in range, which can include OPD-only payments, walk-ins with no
  // appointment link, or payments tied to a cancelled/no-show/still-scheduled
  // appointment. Numerator and denominator must describe the same population.
  const completedApptIds = new Set(
    appts.filter((a) => a.status === "completed").map((a) => a.id),
  );
  const completedAppts = completedApptIds.size;
  const revenueFromCompletedAppts = payments
    .filter((p) => p.appointment_id && completedApptIds.has(p.appointment_id))
    .reduce((s, p) => s + (p.amount ?? 0), 0);
  const avgPerCompletedAppointment =
    completedAppts > 0 ? revenueFromCompletedAppts / completedAppts : 0;

  const now = new Date();
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [tYr, tMo] = todayStr.split("-").map(Number);
  const currentMonthStart = `${tYr}-${String(tMo).padStart(2, "0")}-01`;
  const prevMo = tMo === 1 ? 12 : tMo - 1;
  const prevYr = tMo === 1 ? tYr - 1 : tYr;
  const prevMonthStart = `${prevYr}-${String(prevMo).padStart(2, "0")}-01`;
  const prevMonthEnd = new Date(tYr, tMo - 1, 0).toLocaleDateString("en-CA");

  const [curRes, prevRes] = await Promise.all([
    supabase.from("payments").select("amount").eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("payment_date", currentMonthStart),
    supabase.from("payments").select("amount").eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("payment_date", prevMonthStart).lte("payment_date", prevMonthEnd),
  ]);

  const curTotal = ((curRes.data ?? []) as { amount: number }[]).reduce((s, p) => s + p.amount, 0);
  const prevTotal = ((prevRes.data ?? []) as { amount: number }[]).reduce((s, p) => s + p.amount, 0);
  const momGrowth = prevTotal > 0 ? Math.round(((curTotal - prevTotal) / prevTotal) * 100) : 0;

  return { overTime, byPaymentMethod, bySource, outstandingTotal, avgPerCompletedAppointment, momGrowth };
}

// =============================================================================
// getSourceAnalytics
// =============================================================================

export async function getSourceAnalytics(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<SourceAnalytics> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const { data } = await supabase
    .from("appointments")
    .select("source, status, scheduled_at")
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .gte("scheduled_at", startOf(dateFrom, tz))
    .lte("scheduled_at", endOf(dateTo, tz));

  const rows = (data ?? []) as ApptRow[];

  const breakdownMap: Record<string, number> = {};
  for (const a of rows) {
    breakdownMap[a.source] = (breakdownMap[a.source] ?? 0) + 1;
  }
  const breakdown = Object.entries(breakdownMap).map(([source, count]) => ({
    source: source as AppointmentSource,
    count,
  }));

  const trendMap: Record<string, Record<string, number>> = {};
  for (const a of rows) {
    const date = localDateInTz(a.scheduled_at, tz);
    if (!trendMap[date]) trendMap[date] = {};
    trendMap[date][a.source] = (trendMap[date][a.source] ?? 0) + 1;
  }
  const trendOverTime: SourceAnalytics["trendOverTime"] = [];
  for (const [date, sources] of Object.entries(trendMap)) {
    for (const [source, count] of Object.entries(sources)) {
      trendOverTime.push({ date, source: source as AppointmentSource, count });
    }
  }
  trendOverTime.sort((a, b) => a.date.localeCompare(b.date));

  const convMap: Record<string, { booked: number; completed: number; noShow: number }> = {};
  for (const a of rows) {
    if (!convMap[a.source]) convMap[a.source] = { booked: 0, completed: 0, noShow: 0 };
    convMap[a.source].booked += 1;
    if (a.status === "completed") convMap[a.source].completed += 1;
    if (a.status === "no_show") convMap[a.source].noShow += 1;
  }
  const conversionBySource = Object.entries(convMap).map(([source, v]) => ({
    source: source as AppointmentSource,
    ...v,
  }));

  return { breakdown, trendOverTime, conversionBySource };
}

// =============================================================================
// getFollowUpAnalytics
// =============================================================================

export async function getFollowUpAnalytics(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<FollowUpAnalytics> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  // Both unbounded by date — follow-up completion rate is a lifetime figure.
  const [followUps, withTreatmentRes] = await Promise.all([
    fetchAllRows<FollowUpRow>(() =>
      supabase
        .from("follow_ups")
        .select("status, due_date, created_at, updated_at")
        .eq("clinic_id", clinicId).is("deleted_at", null),
      "analytics: follow-up analytics"),

    fetchAllRows<{ status: string; treatment_id: string | null; treatments: unknown }>(() =>
      supabase
        .from("follow_ups")
        .select("status, treatment_id, treatments(treatment_type)")
        .eq("clinic_id", clinicId).is("deleted_at", null)
        .not("treatment_id", "is", null),
      "analytics: follow-ups by treatment"),
  ]);
  const withTreatments = withTreatmentRes as Array<{
    status: string;
    treatment_id: string | null;
    treatments: { treatment_type: string } | { treatment_type: string }[] | null;
  }>;

  // Pending/Overdue are a CURRENT BACKLOG snapshot ("what's outstanding right
  // now"), not activity that happened during the range — genuinely all-time
  // by nature, left as-is (audit B7; the UI labels these "All-time").
  const pendingCount = followUps.filter((f) => f.status === "pending").length;
  const overdueCount = followUps.filter(
    (f) => f.status === "pending" && f.due_date < today
  ).length;

  // Completion Rate now respects the selected range (audit B7): of the
  // follow-ups DUE within [dateFrom, dateTo], what share are completed.
  // Both numerator and denominator are scoped by the same field (due_date),
  // so they describe one consistent population — unlike scoping the
  // numerator by `updated_at` (when it was actually completed) against a
  // due_date-scoped denominator, which would undercount anything finished
  // early or late relative to its own due date.
  const dueInRange = followUps.filter((f) => f.due_date >= dateFrom && f.due_date <= dateTo);
  const completionRate =
    dueInRange.length > 0
      ? Math.round(
          (dueInRange.filter((f) => f.status === "completed").length / dueInRange.length) * 100,
        )
      : 0;

  const completedInRange = followUps.filter(
    (f) => f.status === "completed" &&
      f.updated_at >= startOf(dateFrom, tz) && f.updated_at <= endOf(dateTo, tz)
  );
  const completedByDate: Record<string, number> = {};
  for (const f of completedInRange) {
    const date = localDateInTz(f.updated_at, tz);
    completedByDate[date] = (completedByDate[date] ?? 0) + 1;
  }
  const completedOverTime = Object.entries(completedByDate)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const ttMap: Record<string, number> = {};
  for (const f of withTreatments) {
    const treatmentData = f.treatments;
    const tt = Array.isArray(treatmentData)
      ? (treatmentData[0]?.treatment_type ?? "Unknown")
      : (treatmentData?.treatment_type ?? "Unknown");
    ttMap[tt] = (ttMap[tt] ?? 0) + 1;
  }
  const byTreatmentType = Object.entries(ttMap)
    .map(([treatmentType, count]) => ({ treatmentType, count }))
    .sort((a, b) => b.count - a.count);

  return { pendingCount, overdueCount, completedOverTime, completionRate, byTreatmentType };
}

// =============================================================================
// getSourcePatientRevenueBreakdown
// =============================================================================

export interface SourceBreakdownItem {
  source: AppointmentSource;
  label: string;
  patientCount: number;
  revenue: number;
}

export async function getSourcePatientRevenueBreakdown(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<SourceBreakdownItem[]> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const [apptRes, paymentsRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, source, patient_id")
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("scheduled_at", startOf(dateFrom, tz)).lte("scheduled_at", endOf(dateTo, tz)),

    supabase
      .from("payments")
      .select("amount, appointment_id")
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("payment_date", dateFrom).lte("payment_date", dateTo),
  ]);

  const appointments = (apptRes.data ?? []) as Array<{
    id: string; source: AppointmentSource; patient_id: string;
  }>;
  const payments = (paymentsRes.data ?? []) as Array<{
    amount: number; appointment_id: string | null;
  }>;

  const apptSourceMap: Record<string, string> = {};
  const sourcePatients: Record<string, Set<string>> = {};
  for (const a of appointments) {
    apptSourceMap[a.id] = a.source;
    if (!sourcePatients[a.source]) sourcePatients[a.source] = new Set();
    sourcePatients[a.source].add(a.patient_id);
  }

  const sourceRevenue: Record<string, number> = {};
  for (const p of payments) {
    const src = p.appointment_id ? (apptSourceMap[p.appointment_id] ?? "other") : "other";
    sourceRevenue[src] = (sourceRevenue[src] ?? 0) + (p.amount ?? 0);
  }

  const SOURCE_LABELS: Record<string, string> = {
    walk_in: "Walk-in", phone_call: "Phone Call", website: "Website",
    referral: "Referral", other: "Other",
  };

  const allSources: AppointmentSource[] = ["walk_in", "phone_call", "website", "referral", "other"];
  return allSources.map((source) => ({
    source,
    label: SOURCE_LABELS[source],
    patientCount: sourcePatients[source]?.size ?? 0,
    revenue: sourceRevenue[source] ?? 0,
  }));
}

// =============================================================================
// generateBasicInsights — rule-based insights (no AI)
// =============================================================================

export interface Insight {
  title: string;
  value: string;
  description: string;
}

export async function generateBasicInsights(
  supabase: DbClient,
  filter: DateRangeFilter
): Promise<Insight[]> {
  const { clinicId, dateFrom, dateTo } = filter;
  const tz = filter.timezone ?? "Asia/Kolkata";

  const [apptRes, treatmentsRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("source, status, scheduled_at, duration_minutes")
      .eq("clinic_id", clinicId).is("deleted_at", null)
      .gte("scheduled_at", startOf(dateFrom, tz)).lte("scheduled_at", endOf(dateTo, tz)),

    supabase
      .from("treatments")
      .select("treatment_type, cost, clinic_share, consultant_share, status")
      .eq("clinic_id", clinicId).is("deleted_at", null),
  ]);

  const appts = (apptRes.data ?? []) as ApptRow[];
  const treatments = (treatmentsRes.data ?? []) as TreatmentRow[];

  const insights: Insight[] = [];

  // Most common patient source
  const sourceCount: Record<string, number> = {};
  for (const a of appts) sourceCount[a.source] = (sourceCount[a.source] ?? 0) + 1;
  const topSourceEntry = Object.entries(sourceCount).sort((a, b) => b[1] - a[1])[0];
  if (topSourceEntry) {
    const LABELS: Record<string, string> = {
      walk_in: "Walk-in", phone_call: "Phone Call", website: "Website",
      referral: "Referral", other: "Other",
    };
    insights.push({
      title: "Most Common Patient Source",
      value: LABELS[topSourceEntry[0]] ?? topSourceEntry[0],
      description: `${topSourceEntry[1]} appointments came from this source in the selected period.`,
    });
  }

  // Highest revenue treatment
  const treatmentRevenue: Record<string, number> = {};
  for (const t of treatments) {
    if (t.status === "completed") {
      const tt = t.treatment_type ?? "Other";
      treatmentRevenue[tt] = (treatmentRevenue[tt] ?? 0) + treatmentClinicShare(t);
    }
  }
  const topTreatmentEntry = Object.entries(treatmentRevenue).sort((a, b) => b[1] - a[1])[0];
  if (topTreatmentEntry) {
    insights.push({
      title: "Highest Revenue Treatment",
      value: topTreatmentEntry[0],
      description: `Generated ₹${topTreatmentEntry[1].toLocaleString("en-IN")} in total revenue.`,
    });
  }

  // Average appointment duration
  const completedAppts = appts.filter((a) => a.status === "completed" && a.duration_minutes);
  if (completedAppts.length > 0) {
    const avgDuration = Math.round(
      completedAppts.reduce((s, a) => s + (a.duration_minutes ?? 30), 0) / completedAppts.length
    );
    insights.push({
      title: "Average Appointment Duration",
      value: `${avgDuration} min`,
      description: `Based on ${completedAppts.length} completed appointments.`,
    });
  }

  // NOTE: The follow-up completion/creation rate is intentionally NOT surfaced
  // here. It belongs with the other follow-up metrics in the Follow-Up
  // Analytics section, keeping Insights focused on the most important KPIs.

  return insights;
}
