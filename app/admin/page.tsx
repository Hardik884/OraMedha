import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  Brain,
  LayoutDashboard,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { SignOutButton } from "@/components/shared/SignOutButton";
import { isBusinessBrainEnabled } from "@/lib/feature-flags";
import {
  readFindingPrecision,
  type FindingPrecision,
} from "@/lib/business-brain/finding-feedback";
import {
  describeJobHealth,
  readJobHealth,
  type JobHealth,
  type JobStatus,
} from "@/lib/business-brain/job-health";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

/**
 * /admin — the platform admin console.
 *
 * WHAT THIS IS
 *   The landing page behind /admin/login. It is deliberately a small console,
 *   not a second product: it confirms who is signed in, shows the shape of the
 *   environment, and hands the admin back into the surfaces it already had.
 *   Admin was added as a separate DOOR, not as a new set of powers, so this
 *   page grants nothing that the account could not already do.
 *
 * WHY requireAdmin() IS CALLED HERE AND NOT ONLY IN MIDDLEWARE
 *   Middleware is a redirect layer for browsers. This call is the actual gate:
 *   it re-resolves the session server-side on every render and bounces any
 *   non-admin, so typing /admin can never render this page for a dentist,
 *   receptionist or patient (CLAUDE.md §13.10).
 *
 * The counts below are read with the service-role client on purpose — an admin
 * overview is inherently cross-clinic, and RLS scopes the ordinary client to a
 * single clinic. Only aggregate counts are read; no patient row ever reaches
 * this page.
 */
export default async function AdminPage() {
  const profile = await requireAdmin();

  const overview = await loadOverview(profile.clinic_id);
  // Whether the scheduled work is actually happening. Null means the health
  // itself could not be read, which renders as unknown — never as healthy.
  const jobs = await readJobHealth(createAdminClient(), new Date().toISOString());
  // Whether the briefing is worth reading, as its readers judge it. Platform
  // wide and counts only — no clinic is named, and nothing here is patient data.
  const precision = await readPlatformPrecision();

  return (
    <div className="min-h-dvh bg-background">
      {/* Header */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#14191A] text-white">
              <ShieldCheck className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold tracking-tight text-text-primary">
                OraMedha Admin
              </h1>
              <p className="truncate text-xs text-text-secondary">
                {profile.full_name ?? "Administrator"}
              </p>
            </div>
          </div>

          <SignOutButton className="w-auto" />
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-5 py-8 sm:px-8 sm:py-10">
        {/* Environment */}
        <section>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Environment
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Clinics" value={overview.clinics} />
            <Stat label="Staff accounts" value={overview.staff} />
            <Stat label="Patient records" value={overview.patients} />
            <Stat label="Portal accounts" value={overview.portalAccounts} />
          </dl>
        </section>

        {/* Scheduled jobs */}
        <section>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Scheduled jobs
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-body">
            Each job records its own run when it finishes. pg_cron reports success
            as soon as it queues the request, so it cannot tell you whether the
            work happened — these rows can.
          </p>
          <div className="mt-3 space-y-3">
            {jobs === null ? (
              <p className="rounded-xl border border-border bg-surface px-4 py-3.5 text-sm text-text-secondary">
                Couldn&apos;t read job health. The jobs may still be running.
              </p>
            ) : (
              jobs.map((job) => <JobRow key={job.job} health={job} />)
            )}
          </div>
        </section>

        {/* Briefing precision */}
        <section>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Briefing precision (30 days)
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-body">
            What dentists said about the findings they were shown. A snooze never
            answered this — a real problem gets snoozed as readily as a wrong one
            — so until now a rule that fired wrongly for a year looked exactly
            like one that fired correctly and was ignored.
          </p>
          <div className="mt-3 space-y-3">
            {precision.length === 0 ? (
              <p className="rounded-xl border border-border bg-surface px-4 py-3.5 text-sm text-text-secondary">
                Nobody has answered yet. That is not 0% precision — it is no
                answer, and the two must not be read as the same thing.
              </p>
            ) : (
              precision.map((row) => <PrecisionRow key={row.group} row={row} />)
            )}
          </div>
        </section>

        {/* Where the admin actually works */}
        <section>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Your workspace
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-body">
            This account is also the dentist for{" "}
            <span className="font-medium text-text-primary">
              {overview.homeClinicName ?? "its clinic"}
            </span>
            . Everything it could do before is still here — admin is an extra
            door, not a different account.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <AdminLink
              href="/dentist"
              icon={LayoutDashboard}
              title="Clinic dashboard"
              description="Today's schedule, queue and KPIs for your clinic."
            />
            {isBusinessBrainEnabled(profile.clinic_id) && (
              <AdminLink
                href="/dentist/business-brain"
                icon={Brain}
                title="Business Brain"
                description="The development analysis surface for this clinic."
              />
            )}
            <AdminLink
              href="/dentist/settings"
              icon={Settings2}
              title="Clinic settings"
              description="Hours, chairs, availability and consent templates."
            />
            <AdminLink
              href="/dentist/analytics"
              icon={Activity}
              title="Analytics"
              description="Appointments, revenue, patients and follow-ups."
            />
          </div>
        </section>

        <p className="text-xs leading-relaxed text-text-secondary">
          Admin access is granted by the <code className="font-mono">is_admin</code>{" "}
          flag on a profile and can only be changed server-side. Clinic data
          remains scoped by row-level security exactly as it is for every other
          account — this page does not bypass it.
        </p>
      </main>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const JOB_LABELS: Record<string, string> = {
  metric_history: "Metric history + clinic memory",
  no_show_detection: "No-show detection",
};

/** Colour says what to do: red needs attention now, amber is worth a look. */
const JOB_TONES: Record<JobStatus, { dot: string; text: string; label: string }> = {
  healthy: { dot: "bg-success", text: "text-success", label: "Healthy" },
  degraded: { dot: "bg-warning", text: "text-warning", label: "Degraded" },
  stale: { dot: "bg-danger", text: "text-danger", label: "Stale" },
  never_run: { dot: "bg-danger", text: "text-danger", label: "Never run" },
};

/** Why a finding was not relevant, in words rather than codes. */
const REASON_LABELS: Record<string, string> = {
  not_true: "not true of the clinic",
  already_knew: "already known",
  not_my_priority: "not a priority",
  cannot_act: "outside their control",
  other: "other",
};

/**
 * One rule's standing with the clinics that see it.
 *
 * The reasons matter more than the percentage: "not true" is a rule to fix,
 * "already knew" is a rule that is right and not worth a card, and "not a
 * priority" is a ranking problem. A bare precision figure hides all three.
 */
function PrecisionRow({ row }: { row: FindingPrecision }) {
  const answered = row.useful + row.notRelevant;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-text-primary">{row.group}</span>
        <span className="text-sm tabular-nums text-text-body">
          {row.precisionPercent === null ? "—" : `${Math.round(row.precisionPercent)}% useful`}
          <span className="text-text-secondary"> · {answered} answered</span>
        </span>
      </div>
      {row.reasons.length > 0 && (
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          {row.reasons
            .map((r) => `${r.count} ${REASON_LABELS[r.reason] ?? r.reason}`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

function JobRow({ health }: { health: JobHealth }) {
  const tone = JOB_TONES[health.status];
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text-primary">
          {JOB_LABELS[health.job] ?? health.job}
        </span>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${tone.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
          {tone.label}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        {describeJobHealth(health)}
        {health.lastSuccessAt !== null && (
          <>
            {" "}
            Last success {formatWhen(health.lastSuccessAt)}.
          </>
        )}
      </p>
      {health.detail !== null && (
        <p className="mt-1 font-mono text-[11px] leading-relaxed text-text-secondary">
          {health.detail}
        </p>
      )}
    </div>
  );
}

/** A short, absolute time — an admin reading this needs the actual moment. */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-text-primary">
        {value ?? "—"}
      </dd>
    </div>
  );
}

function AdminLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: typeof LayoutDashboard;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-4 transition-colors duration-150 hover:border-border-strong hover:bg-surface-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          {title}
          <ArrowUpRight
            className="h-3.5 w-3.5 text-text-secondary transition-colors duration-150 group-hover:text-accent"
            aria-hidden="true"
          />
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">
          {description}
        </span>
      </span>
    </Link>
  );
}

// ── Data ──────────────────────────────────────────────────────────────────────

type Overview = {
  clinics: number | null;
  staff: number | null;
  patients: number | null;
  portalAccounts: number | null;
  homeClinicName: string | null;
};

/**
 * Aggregate counts for the environment panel.
 *
 * Every failure is swallowed into a null so the console still renders: an admin
 * locked out of its own overview because one count errored would be a worse
 * outcome than a dash on a card.
 */
/**
 * Feedback across every clinic, for the last 30 days.
 *
 * Service role, because this is the one question that is only worth asking
 * across the whole platform: one clinic's verdicts are too few to say whether a
 * rule earns its place. Counts and rule names only — no clinic is identified and
 * no patient data is involved.
 *
 * A failed read yields an empty list, which renders as "nobody has answered" —
 * not as perfect precision.
 */
async function readPlatformPrecision(): Promise<readonly FindingPrecision[]> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return await readFindingPrecision(createAdminClient() as never, { since });
  } catch (err) {
    console.error("[admin] precision failed:", err);
    return [];
  }
}

async function loadOverview(homeClinicId: string): Promise<Overview> {
  const empty: Overview = {
    clinics: null,
    staff: null,
    patients: null,
    portalAccounts: null,
    homeClinicName: null,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin: any = createAdminClient();

    const count = async (table: string, apply?: (q: unknown) => unknown) => {
      let query = admin.from(table).select("*", { count: "exact", head: true });
      if (apply) query = apply(query);
      const { count: n, error } = await query;
      return error ? null : (n as number);
    };

    const [clinics, staff, patients, portalAccounts, home] = await Promise.all([
      count("clinics"),
      count("profiles", (q) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (q as any).in("role", ["dentist", "receptionist"])
      ),
      count("patients", (q) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (q as any).is("deleted_at", null)
      ),
      count("patient_portal_links"),
      (async () => {
        const { data } = await admin
          .from("clinics")
          .select("name")
          .eq("id", homeClinicId)
          .maybeSingle();
        return (data as { name: string } | null)?.name ?? null;
      })(),
    ]);

    return {
      clinics,
      staff,
      patients,
      portalAccounts,
      homeClinicName: home,
    };
  } catch (err) {
    console.error("[admin] overview failed:", err);
    return empty;
  }
}
