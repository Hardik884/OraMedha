import type { Metadata } from "next";
import { PageHeader } from "@/components/layouts/PageHeader";
import { ExternalConsultationDialog } from "@/components/dentist/ExternalConsultationDialog";
import { ConsultationPaymentControl } from "@/components/dentist/ConsultationPaymentControl";
import { getConsultancyIncome } from "@/actions/consultants";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Plus } from "lucide-react";
import type { ConsultancyIncome } from "@/types";

export const metadata: Metadata = {
  title: "External Consultations",
};

/**
 * /dentist/external-consultations
 *
 * Dedicated module for external consultancy income — earnings the dentist made
 * at other clinics. Fully separate from clinic Payments. Dentist role only
 * (enforced in getConsultancyIncome). Entries are shown newest first and are
 * added via the shared centered dialog, reusing recordConsultancyIncome.
 */
export default async function ExternalConsultationsPage() {
  const { data, error } = await getConsultancyIncome();
  const entries = (data ?? []) as ConsultancyIncome[];

  // An unpriced consultation (amount NULL) contributes nothing rather than
  // zero-ing the total — the two are different states and only one is a fact.
  const total = entries.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
  const unpaidTotal = entries
    .filter((e) => !e.is_paid)
    .reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
  const unpaidCount = entries.filter((e) => !e.is_paid).length;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="External Consultations">
        <ExternalConsultationDialog triggerVariant="default">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add External Consultation
        </ExternalConsultationDialog>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Total External Income
          </p>
          <p className="text-2xl font-semibold text-text-primary mt-1">
            {formatCurrency(total)}
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Consultations Recorded
          </p>
          <p className="text-2xl font-semibold text-text-primary mt-1">{entries.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Awaiting Payment
          </p>
          <p className="text-2xl font-semibold text-text-primary mt-1">
            {formatCurrency(unpaidTotal)}
          </p>
          <p className="text-xs text-text-secondary mt-1">
            {unpaidCount} {unpaidCount === 1 ? "consultation" : "consultations"}
          </p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-danger bg-danger-bg border border-danger-border rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {entries.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <p className="text-sm text-text-secondary">No external consultations recorded yet.</p>
          <p className="text-xs text-text-disabled mt-1">
            Use “Add External Consultation” to record income earned at another clinic.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-muted bg-background text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Clinic Name</th>
                  <th className="px-4 py-3">Treatment Performed</th>
                  <th className="px-4 py-3 text-right">Amount / Payment</th>
                  <th className="px-4 py-3">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-muted">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-background transition-colors">
                    <td className="px-4 py-3 text-text-body whitespace-nowrap">
                      {formatDate(e.date)}
                    </td>
                    <td className="px-4 py-3 text-text-body whitespace-nowrap">
                      {e.start_time && e.end_time ? (
                        <span title="This time is blocked for appointments">
                          {e.start_time.slice(0, 5)}–{e.end_time.slice(0, 5)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary">
                      {e.external_clinic ? e.external_clinic : "—"}
                    </td>
                    <td className="px-4 py-3 text-text-body">
                      {e.description ? e.description : "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <ConsultationPaymentControl
                        consultationId={e.id}
                        amount={e.amount == null ? null : Number(e.amount)}
                        isPaid={e.is_paid}
                      />
                    </td>
                    <td className="px-4 py-3 text-text-body">
                      {e.notes ? e.notes : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
