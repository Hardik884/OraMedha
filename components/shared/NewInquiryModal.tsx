"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { PatientForm } from "@/components/shared/PatientForm";
import type { Patient } from "@/types";

interface NewInquiryModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * NewInquiryModal
 *
 * Opens the existing PatientForm for quick patient creation. Uses the shared
 * centered Dialog component — identical animation, spacing, width and styling
 * to the Appointments / Treatments / Payments / Follow-up dialogs.
 *
 * Design decisions:
 * - Reuses PatientForm unchanged — no duplicate logic, no duplicate validation.
 * - `onSuccess` callback: closes the modal, fires a toast, then calls
 *   router.refresh() so the calling page (Server Component) re-fetches and the
 *   newly created patient is immediately available for booking.
 * - clinic_id is never passed from the client — createPatient() always sources
 *   it from the authenticated user's profile (server-side RLS).
 * - Patients cannot open this modal (the button is only rendered for
 *   dentist/receptionist roles in the page-level guard).
 */
export function NewInquiryModal({ open, onClose }: NewInquiryModalProps) {
  const router = useRouter();

  function handleSuccess(patient: Patient) {
    onClose();
    toast.success(`Patient "${patient.name}" created successfully.`, {
      description: "They are now available for appointment booking.",
    });
    // Refresh the server-rendered page so the new patient shows up immediately
    // in any patient search or booking flow.
    //
    // This call was missing. `router` was obtained and never used — which lint
    // reported as an unused variable, and which meant the behaviour the comment
    // above describes simply did not happen: a patient created here stayed
    // invisible to the surrounding page until someone reloaded it. The toast
    // said the record existed while the list still said it did not.
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add New Inquiry"
      description="Create a new patient record for this clinic."
      size="lg"
    >
      <div className="p-4">
        <PatientForm onSuccess={handleSuccess} hideCancel />
      </div>
    </Dialog>
  );
}
