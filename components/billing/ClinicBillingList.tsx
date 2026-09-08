import { Suspense } from "react";
import { FileText } from "lucide-react";
import { getClinicBillsList } from "@/actions/billing";
import { BillPreviewDialog } from "@/components/billing/BillPreviewDialog";
import { BillingSearch } from "@/components/billing/BillingSearch";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { BillStatus } from "@/lib/billing/invoice";

const STATUS_LABEL: Record<BillStatus, string> = {
  paid: "Paid",
  partial: "Partially Paid",
  pending: "Pending",
  no_charge: "No Charge",
};

const STATUS_VARIANT: Record<BillStatus, "success" | "warning" | "danger" | "secondary"> = {
  paid: "success",
  partial: "warning",
  pending: "danger",
  no_charge: "secondary",
};

interface ClinicBillingListProps {
  baseHref: string; // "/dentist" | "/receptionist"
  search?: string;
  page?: number;
}

/**
 * ClinicBillingList — the "Billing" panel inside /dentist/payments and
 * /receptionist/payments. Clinic-wide, one row per APPOINTMENT that has
 * billable financial activity (not per patient, not only the latest visit).
 *
 * Reuses getClinicBillsList, which itself reuses the same canonical
 * treatmentTotalCharge + allocateCollectionsToTreatments every other billing
 * screen is built on — no separate calculation.
 */
export async function ClinicBillingList({ baseHref, search, page = 1 }: ClinicBillingListProps) {
  const limit = 20;
  const result = await getClinicBillsList({ search, page, limit });

  if (result.error) {
    return (
      <p className="text-sm text-danger bg-danger-bg border border-danger-border rounded-md px-3 py-2">
        {result.error}
      </p>
    );
  }

  const bills = result.data?.bills ?? [];
  const total = result.data?.total ?? 0;

  if (bills.length === 0) {
    return (
      <div className="space-y-3">
        <Suspense>
        <BillingSearch initialSearch={search} />
      </Suspense>
        <div className="bg-surface border border-border rounded-xl">
          <EmptyState
            icon={<FileText className="h-5 w-5" aria-hidden />}
            title={search ? "No matching bills" : "No bills yet"}
            description={
              search
                ? `Nothing matched "${search}". Try a different name or phone number.`
                : "Bills appear here for every appointment with a billable charge or payment."
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Suspense>
        <BillingSearch initialSearch={search} />
      </Suspense>

      <p className="text-xs text-text-secondary">
        {total} {total === 1 ? "bill" : "bills"}
        {search ? ` matching "${search}"` : ""}
      </p>

      {bills.map((bill) => (
        <div
          key={bill.appointmentId}
          className="bg-surface border border-border rounded-xl p-4 flex flex-wrap items-center justify-between gap-4"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-text-primary">{bill.patientName}</p>
              <Badge variant={STATUS_VARIANT[bill.status]}>{STATUS_LABEL[bill.status]}</Badge>
            </div>
            <p className="text-xs text-text-secondary mt-0.5">
              {formatDate(bill.appointmentDate)} · {bill.treatmentDescription}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 sm:gap-5">
            <Stat label="Total" value={formatCurrency(bill.total)} />
            <Stat label="Paid" value={formatCurrency(bill.paid)} valueClass="text-success" />
            <Stat
              label={bill.overpayment > 0 ? "Credit" : "Balance"}
              value={formatCurrency(bill.overpayment > 0 ? bill.overpayment : bill.balanceDue)}
              valueClass={bill.balanceDue > 0 ? "text-danger" : "text-success"}
            />
            {/* Opens over the list rather than navigating into the
                Appointments section — see BillPreviewDialog. */}
            <BillPreviewDialog
              appointmentId={bill.appointmentId}
              patientName={bill.patientName}
              baseHref={baseHref}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-text-disabled">{label}</p>
      <p className={`text-sm font-semibold ${valueClass ?? "text-text-primary"}`}>{value}</p>
    </div>
  );
}
