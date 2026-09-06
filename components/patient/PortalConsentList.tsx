"use client";

import { useState } from "react";
import { FileText, ImageIcon, FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { formatDate } from "@/lib/utils";
import { ConsentDocument } from "@/components/consent/ConsentDocument";
import { ConsentActions } from "@/components/consent/ConsentActions";
import { consentStatusLabel, type ConsentStatus, type ConsentSource } from "@/lib/consents/status";
import type { ConsentSnapshot } from "@/lib/consents/content";
import type { ConsentListItem } from "@/actions/consents";
import { getPortalConsentDetail, getPortalConsentFileUrl } from "@/actions/consents";

const STATUS_VARIANT: Record<ConsentStatus, "default" | "info" | "success" | "error"> = {
  draft: "default",
  ready_to_sign: "info",
  signed: "success",
  cancelled: "error",
};

/**
 * PortalConsentList — consent history for the authenticated patient.
 *
 * Shows ALL non-cancelled consents (draft, ready_to_sign, signed, uploaded).
 * Patients can view, download, and print ANY consent regardless of signing
 * status — digital signing is optional. A valid workflow is: view the draft,
 * download/print it, sign physically, and have the clinic upload the copy.
 */
export function PortalConsentList({ consents }: { consents: ConsentListItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (consents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
        <FileSignature className="mx-auto h-6 w-6 text-text-disabled" aria-hidden />
        <p className="mt-2 text-sm text-text-secondary">You have no consent forms yet.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-surface-muted rounded-lg border border-border bg-surface">
        {consents.map((c) => {
          const source = c.source as ConsentSource;
          const status = c.status as ConsentStatus;
          return (
            <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {c.treatment_type || c.template_name}
                  </p>
                  {source === "uploaded" ? (
                    <ImageIcon className="h-3 w-3 text-text-disabled" aria-hidden />
                  ) : (
                    <FileText className="h-3 w-3 text-text-disabled" aria-hidden />
                  )}
                </div>
                <p className="text-xs text-text-secondary mt-0.5">
                  {c.signed_at ? `Signed ${formatDate(c.signed_at)}` : formatDate(c.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge
                  label={consentStatusLabel(status, source)}
                  variant={STATUS_VARIANT[status]}
                />
                <Button variant="outline" size="xs" onClick={() => setOpenId(c.id)}>
                  View
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {openId && <PortalConsentDetail consentId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function PortalConsentDetail({ consentId, onClose }: { consentId: string; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ConsentSnapshot | null>(null);
  const [meta, setMeta] = useState<{
    source: string;
    status: string;
    signed_at: string | null;
    patient_signed_name: string | null;
    patient_signature: string | null;
    file_name: string | null;
  } | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    setLoaded(true);
    getPortalConsentDetail(consentId).then(async (res) => {
      if (res.error || !res.data) {
        setError(res.error ?? "Not found");
        return;
      }
      setSnapshot(res.data.snapshot);
      setMeta({
        source: res.data.source,
        status: res.data.status,
        signed_at: res.data.signed_at,
        patient_signed_name: res.data.patient_signed_name,
        patient_signature: res.data.patient_signature,
        file_name: res.data.file_name,
      });
      if (res.data.source === "uploaded") {
        const f = await getPortalConsentFileUrl(consentId);
        if (f.data) setFileUrl(f.data.url);
      }
    });
  }

  const clinicName = snapshot?.clinic.name ?? "the clinic";
  const isUploaded = meta?.source === "uploaded";
  const status = (meta?.status as ConsentStatus | undefined) ?? "draft";

  return (
    <Dialog open onClose={onClose} size="xl" title="Consent Form" description={snapshot?.templateName}>
      <div className="p-5 space-y-4">
        {error && <p className="text-sm text-danger">{error}</p>}
        {!snapshot && !error && <p className="text-sm text-text-secondary">Loading…</p>}

        {snapshot && isUploaded && (
          <div className="space-y-3">
            <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2">
              <p className="text-xs font-medium text-warning-strong">Uploaded Signed Consent</p>
              <p className="text-[11px] text-warning-strong">
                This was signed on paper and uploaded by the clinic.
              </p>
            </div>
            <ConsentActions
              targetId="portal-consent-file"
              fileName={meta?.file_name ?? "consent"}
              patientName={snapshot.patient.name}
              clinicName={clinicName}
              patientPhone={null}
              showWhatsApp={false}
              directFileUrl={fileUrl}
            />
            <div id="portal-consent-file" className="rounded-md border border-border p-3">
              {!fileUrl ? (
                <p className="text-sm text-text-secondary">Loading file…</p>
              ) : (meta?.file_name ?? "").match(/\.(png|jpe?g)$/i) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl} alt="Signed consent" className="max-w-full mx-auto" />
              ) : (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-info underline"
                >
                  Open / Download document
                </a>
              )}
            </div>
          </div>
        )}

        {snapshot && !isUploaded && (
          <>
            {/* Download / Print always available, regardless of signing status */}
            <ConsentActions
              targetId="consent-document"
              fileName={`Consent-${snapshot.patient.name.replace(/\s+/g, "_")}.pdf`}
              patientName={snapshot.patient.name}
              clinicName={clinicName}
              patientPhone={null}
              showWhatsApp={false}
            />

            {/* Hint for unsigned consents */}
            {status !== "signed" && (
              <div className="rounded-md border border-info-border bg-info-bg px-3 py-2">
                <p className="text-xs text-info-strong">
                  This consent has not been signed yet. You can download or print it, sign it
                  physically, and return the signed copy to the clinic.
                </p>
              </div>
            )}

            {/* The document itself (also the PDF/print capture target) */}
            <div className="rounded-md border border-border overflow-hidden">
              <ConsentDocument
                snapshot={snapshot}
                status={status}
                patientSignature={meta?.patient_signature}
                patientSignedName={meta?.patient_signed_name}
                signedAt={meta?.signed_at}
              />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
