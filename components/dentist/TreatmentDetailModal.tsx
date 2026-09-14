"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Dialog } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { MedicationTable } from "@/components/shared/MedicationTable";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { getTreatment, getTreatmentDocuments } from "@/actions/treatments";
import { getMySignature } from "@/actions/signature";
import { getClinicSettings } from "@/actions/clinic-settings";
import {
  TREATMENT_STATUS_LABELS,
  formatDate,
  formatDateTime,
  formatCurrency,
} from "@/lib/utils";
import { FileText } from "lucide-react";
import type {
  TreatmentStatus,
  Treatment,
  TreatmentDocument,
  MedicationInput,
} from "@/types";

const STATUS_VARIANT_MAP: Record<TreatmentStatus, "default" | "info" | "success" | "error"> = {
  planned: "default",
  in_progress: "info",
  completed: "success",
  cancelled: "error",
};

interface TreatmentDetailDialogProps {
  treatmentId: string | null;
  open: boolean;
  onClose: () => void;
  /**
   * Clinic registration number. When omitted, the modal resolves it itself via
   * getClinicSettings so callers that don't already have it stay simple.
   */
  registrationNumber?: string | null;
}

/**
 * TreatmentDetailDialog
 *
 * Shared centered, read-only Treatment detail modal used everywhere a treatment
 * can be opened inline (Past Treatment History, treatment lists on the patient
 * profile + visit page). Lazily loads the full record on open. No editing,
 * no navigation. This is the single source of truth for the read-only view.
 */
export function TreatmentDetailDialog({
  treatmentId,
  open,
  onClose,
  registrationNumber,
}: TreatmentDetailDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Treatment Details" size="xl">
      {treatmentId && (
        <TreatmentDetail treatmentId={treatmentId} registrationNumber={registrationNumber} />
      )}
    </Dialog>
  );
}

// =============================================================================
// TreatmentDetail — read-only detail fetched lazily on open
// =============================================================================

function TreatmentDetail({
  treatmentId,
  registrationNumber,
}: {
  treatmentId: string;
  registrationNumber?: string | null;
}) {
  const [loading, setLoading] = useState(true);
  const [treatment, setTreatment] = useState<Treatment | null>(null);
  const [documents, setDocuments] = useState<Array<TreatmentDocument & { url: string | null }>>([]);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [regNumber, setRegNumber] = useState<string | null>(registrationNumber ?? null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      getTreatment(treatmentId),
      getTreatmentDocuments(treatmentId),
      getMySignature(),
      // Only resolve settings when the caller didn't already supply the number.
      registrationNumber === undefined ? getClinicSettings() : Promise.resolve(null),
    ]).then(([tRes, dRes, sRes, settingsRes]) => {
      if (!active) return;
      setTreatment(tRes.data ?? null);
      setDocuments(dRes.data ?? []);
      setSignatureUrl(sRes.data?.url ?? null);
      if (registrationNumber === undefined && settingsRes) {
        setRegNumber(settingsRes.data?.registration_number ?? null);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [treatmentId, registrationNumber]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-text-secondary">
        <LoadingSpinner size="sm" />
        Loading treatment…
      </div>
    );
  }

  if (!treatment) {
    return <p className="p-8 text-sm text-danger">Treatment could not be loaded.</p>;
  }

  const status = treatment.status as TreatmentStatus;
  const medications: MedicationInput[] = Array.isArray(treatment.medications)
    ? (treatment.medications as unknown as MedicationInput[])
    : [];

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">{treatment.treatment_type}</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            {treatment.performed_at
              ? formatDateTime(treatment.performed_at)
              : `Added ${formatDate(treatment.created_at)}`}
          </p>
        </div>
        <StatusBadge
          label={TREATMENT_STATUS_LABELS[status] ?? status}
          variant={STATUS_VARIANT_MAP[status]}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t border-surface-muted">
        <Detail label="Cost" value={formatCurrency(Number(treatment.cost ?? 0))} />
        <Detail
          label="Performed"
          value={treatment.performed_at ? formatDateTime(treatment.performed_at) : "Not recorded"}
        />
        <Detail label="Added" value={formatDate(treatment.created_at)} />
        {treatment.xray_taken && (
          <Detail
            label="X-ray Cost"
            value={treatment.xray_cost != null ? formatCurrency(Number(treatment.xray_cost)) : "—"}
          />
        )}
      </div>

      {/* Medicines + Instructions */}
      {medications.length > 0 && (
        <div className="pt-4 border-t border-surface-muted">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
            Medicines &amp; Instructions
          </p>
          <MedicationTable medications={medications} />
        </div>
      )}

      {/* Clinical / Patient notes */}
      {treatment.patient_visible_notes && (
        <div className="pt-4 border-t border-surface-muted">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1">
            Notes for patient (shown in portal)
          </p>
          <p className="text-sm text-text-body whitespace-pre-wrap">
            {treatment.patient_visible_notes}
          </p>
        </div>
      )}

      {/* Documents */}
      {documents.length > 0 && (
        <div className="pt-4 border-t border-surface-muted">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
            Documents
          </p>
          <ul className="space-y-1.5">
            {documents.map((doc) => (
              <li key={doc.id}>
                {doc.url ? (
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-accent hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{doc.file_name}</span>
                  </a>
                ) : (
                  <span className="flex items-center gap-2 text-sm text-text-disabled">
                    <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{doc.file_name}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Signature + Registration */}
      {(signatureUrl || regNumber) && (
        <div className="pt-4 border-t border-surface-muted space-y-2">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Signature
          </p>
          {signatureUrl && (
            <div className="relative h-16 w-40">
              <Image
                src={signatureUrl}
                alt="Dentist signature"
                fill
                className="object-contain object-left"
                unoptimized
              />
            </div>
          )}
          {regNumber && (
            <p className="text-xs text-text-body">Registration No: {regNumber}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-text-primary mt-0.5">{value}</p>
    </div>
  );
}
