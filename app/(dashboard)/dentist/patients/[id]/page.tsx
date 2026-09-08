import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layouts/PageHeader";
import { PatientProfileHeader } from "@/components/dentist/PatientProfileHeader";
import { PatientSummaryCard } from "@/components/ai/PatientSummaryCard";
import { PatientFollowUpsTab } from "@/components/follow-ups/PatientFollowUpsTab";
import { PatientTreatmentsTab } from "@/components/dentist/PatientTreatmentsTab";
import { BillingPaymentsTab } from "@/components/billing/BillingPaymentsTab";
import { PatientDentalChartSection } from "@/components/dental-chart/PatientDentalChartSection";
import { PatientConsentFormsTab } from "@/components/consent/PatientConsentFormsTab";
import { getPatient } from "@/actions/patients";
import { getClinicSettings } from "@/actions/clinic-settings";

export const metadata: Metadata = {
  title: "Patient Profile",
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}

type Tab = "overview" | "dental-chart" | "treatments" | "payments" | "follow-ups" | "consent-forms";

/**
 * /dentist/patients/[id]
 *
 * Full patient profile — dentist view.
 * Tabs: Overview (AI summary) | Dental Chart | Follow-Ups | Treatments | Billing & Payments
 *
 * The "payments" tab (query value unchanged for link stability) now renders
 * <BillingPaymentsTab>, a [Payments]/[Bill] toggle (Payments default). Its Payments panel is the
 * pre-existing <PatientPaymentsTab>, reused unmodified.
 */
export default async function DentistPatientProfilePage({ params, searchParams }: Props) {
  const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);

  if (!id) notFound();

  // Fetch patient name for use in "New Follow-Up" links so the form can
  // pre-populate the selected-patient chip without a client round-trip.
  const [patientResult, clinicSettingsResult] = await Promise.all([
    getPatient(id),
    getClinicSettings(),
  ]);
  const patientName = patientResult.data?.name;

  // Patient Consent Forms is a per-clinic pilot rollout — the tab is hidden
  // entirely (not just empty) for a clinic that doesn't have it enabled yet.
  const consentFormsEnabled = clinicSettingsResult.data?.consent_forms_enabled === true;

  const rawTabIsValid =
    rawTab === "dental-chart" ||
    rawTab === "treatments" ||
    rawTab === "payments" ||
    rawTab === "follow-ups" ||
    (rawTab === "consent-forms" && consentFormsEnabled);
  const tab: Tab = rawTabIsValid ? (rawTab as Tab) : "overview";

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Patient Profile" backHref="/dentist/patients" />

      {/* Demographics, stats, balance, actions */}
      <PatientProfileHeader
        patientId={id}
        role="dentist"
        baseHref="/dentist"
      />

      {/* Tab navigation */}
      <div className="border-b flex gap-0 overflow-x-auto no-scrollbar">
        <TabLink href={`/dentist/patients/${id}`} active={tab === "overview"}>
          Overview
        </TabLink>
        <TabLink href={`/dentist/patients/${id}?tab=dental-chart`} active={tab === "dental-chart"}>
          Dental Chart
        </TabLink>
        <TabLink href={`/dentist/patients/${id}?tab=follow-ups`} active={tab === "follow-ups"}>
          Follow-Ups
        </TabLink>
        <TabLink href={`/dentist/patients/${id}?tab=treatments`} active={tab === "treatments"}>
          Treatments
        </TabLink>
        <TabLink href={`/dentist/patients/${id}?tab=payments`} active={tab === "payments"}>
          Billing &amp; Payments
        </TabLink>
        {consentFormsEnabled && (
          <TabLink href={`/dentist/patients/${id}?tab=consent-forms`} active={tab === "consent-forms"}>
            Consent Forms
          </TabLink>
        )}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Quick follow-up summary on overview */}
            <PatientFollowUpsTab
              patientId={id}
              patientName={patientName}
              baseHref="/dentist"
              role="dentist"
            />
          </div>
          <div className="space-y-6">
            {/* AI Patient Summary — non-blocking, fails gracefully */}
            <PatientSummaryCard patientId={id} />
          </div>
        </div>
      )}

      {tab === "dental-chart" && (
        <PatientDentalChartSection
          patientId={id}
          patientName={patientName}
          fullViewHref={`/dentist/patients/${id}/dental-chart`}
        />
      )}

      {tab === "follow-ups" && (
        <PatientFollowUpsTab
          patientId={id}
          patientName={patientName}
          baseHref="/dentist"
          role="dentist"
        />
      )}

      {tab === "treatments" && (
        <PatientTreatmentsTab
          patientId={id}
          role="dentist"
          baseHref="/dentist"
        />
      )}

      {tab === "payments" && (
        <BillingPaymentsTab
          patientId={id}
          patientName={patientName}
          role="dentist"
          baseHref="/dentist"
        />
      )}

      {tab === "consent-forms" && (
        <PatientConsentFormsTab patientId={id} role="dentist" baseHref="/dentist" />
      )}
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
        active
          ? "border-accent text-accent"
          : "border-transparent text-text-secondary hover:text-text-secondary hover:border-border-strong"
      }`}
    >
      {children}
    </a>
  );
}
