"use client";

import { useState, useTransition } from "react";
import { FileText, ExternalLink } from "lucide-react";

import { getStaffBill, type BillDocument } from "@/actions/billing";
import { Dialog } from "@/components/ui/dialog";
import { InvoiceDocument } from "@/components/billing/InvoiceDocument";
import { InvoiceActions } from "@/components/billing/InvoiceActions";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";

interface BillPreviewDialogProps {
  appointmentId: string;
  patientName: string;
  /** "/dentist" | "/receptionist" — for the printable-page link and Add Phone. */
  baseHref: string;
}

const INVOICE_TARGET_ID = "invoice-document";

/**
 * BillPreviewDialog — "View Bill", opened where the user already is.
 *
 * WHAT THIS REPLACES
 *   The Billing list's View Bill was a <Link> to
 *   /dentist/appointments/<id>/bill. That route is correct and still exists,
 *   but reaching it from Billing navigated INTO the Appointments section: the
 *   URL, the page chrome and the sidebar's active item all said Appointments,
 *   and getting back meant a Back button rather than simply closing something.
 *   Staff checking several bills in a row paid that round trip each time.
 *
 *   The bill now opens over the list. Nothing about the document changes —
 *   same getStaffBill, same InvoiceDocument, same InvoiceActions, so Print,
 *   Download PDF and Send on WhatsApp all capture the identical node they
 *   always did. "Open full page" is still offered for anyone who wants the
 *   standalone printable route.
 *
 * The bill is fetched when the dialog opens, not with the list: a clinic-wide
 * billing page would otherwise resolve a full invoice for every row on screen
 * to show none of them.
 */
export function BillPreviewDialog({
  appointmentId,
  patientName,
  baseHref,
}: BillPreviewDialogProps) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<BillDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleOpen() {
    setOpen(true);
    // Already loaded — reopening the same bill should not re-fetch it.
    if (doc || isPending) return;

    setError(null);
    startTransition(async () => {
      const result = await getStaffBill(appointmentId);
      if (result.error || !result.data) {
        setError(result.error ?? "This bill could not be loaded.");
        return;
      }
      setDoc(result.data);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="text-xs font-medium px-3 py-1.5 rounded-md border border-border text-text-primary hover:bg-surface-muted transition-colors shrink-0"
      >
        View Bill
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Bill"
        description={patientName}
        size="xl"
      >
        {isPending && (
          <div className="flex items-center justify-center gap-2 py-12 text-text-secondary">
            <LoadingSpinner size="sm" />
            <span className="text-sm">Loading bill…</span>
          </div>
        )}

        {error && (
          <p className="text-sm text-danger bg-danger-bg border border-danger-border rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {doc && !isPending && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <InvoiceActions
                targetId={INVOICE_TARGET_ID}
                fileName={`Bill-${patientName.replace(/\s+/g, "-")}`}
                patientName={patientName}
                clinicName={doc.clinic.name}
                patientPhone={doc.patient.phone}
                showWhatsApp
                addPhoneHref={`${baseHref}/patients/${doc.patient.id}/edit`}
              />

              <a
                href={`${baseHref}/appointments/${appointmentId}/bill?from=billing`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                <ExternalLink className="h-3 w-3" aria-hidden />
                Open full page
              </a>
            </div>

            {/* The invoice scrolls inside the dialog body; the document keeps
                its fixed A4 width so the captured PDF is unaffected by the
                dialog it happens to be rendered in. */}
            <div className="overflow-x-auto">
              <InvoiceDocument
                document={doc}
                audience="staff"
                timezone={doc.timezone}
              />
            </div>
          </div>
        )}

        {!doc && !isPending && !error && (
          <div className="flex items-center gap-2 py-12 text-text-secondary">
            <FileText className="h-4 w-4" aria-hidden />
            <span className="text-sm">No bill available for this visit.</span>
          </div>
        )}
      </Dialog>
    </>
  );
}
