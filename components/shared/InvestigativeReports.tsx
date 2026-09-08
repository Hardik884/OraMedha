"use client";

import { useRef, useState, useTransition } from "react";
import {
  uploadAppointmentDocument,
  deleteAppointmentDocument,
} from "@/actions/treatments";
import { INVESTIGATIVE_DOCUMENT_TYPES, type TreatmentDocument } from "@/types";
import { Select } from "@/components/ui/select";
import { FileText, ImageIcon, Upload, Trash2, Download } from "lucide-react";

type DocWithUrl = TreatmentDocument & { url: string | null };

interface InvestigativeReportsProps {
  appointmentId: string;
  patientId: string;
  documents: DocWithUrl[];
  /** When false, upload + delete controls are hidden (view-only). */
  canManage: boolean;
}

const ACCEPTED_FILE_TYPES = ".pdf,.jpg,.jpeg,.png";
const ACCEPTED_MIME = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * InvestigativeReports
 *
 * Appointment-scoped manager for the investigative and diagnostic documents a
 * visit produces — radiographs (IOPA / OPG / CBCT), pathology and lab results,
 * and other diagnostic reports.
 *
 * Renamed from RadiographicDocuments: the section always accepted any PDF or
 * image, so the old name described the commonest case rather than the scope,
 * and staff filed pathology results under "Other" because nothing said they
 * belonged here.
 *
 * NOTHING ABOUT STORAGE CHANGED. Same server actions, same patient-documents
 * bucket, same `document_type` free-text column — existing documents keep their
 * stored type and remain listed, downloadable and removable exactly as before.
 *
 * Upload → Preview → Download → Remove. View-only when `canManage` is false.
 */
export function InvestigativeReports({
  appointmentId,
  patientId,
  documents,
  canManage,
}: InvestigativeReportsProps) {
  const [isPending, startTransition] = useTransition();
  const [docType, setDocType] = useState<string>(INVESTIGATIVE_DOCUMENT_TYPES[0]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!ACCEPTED_MIME.includes(file.type)) {
      setError(`"${file.name}" is not a supported type (PDF, JPG, JPEG, PNG).`);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(`"${file.name}" exceeds the 10 MB limit.`);
      return;
    }

    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("appointment_id", appointmentId);
    fd.append("patient_id", patientId);
    fd.append("document_type", docType);

    uploadAppointmentDocument(fd).then((res) => {
      setUploading(false);
      if (res.error) {
        setError(res.error);
        return;
      }
    });
  }

  function handleDelete(id: string) {
    if (!confirm("Remove this document? This cannot be undone.")) return;
    startTransition(async () => {
      const res = await deleteAppointmentDocument(id);
      if (res.error) {
        setError(res.error);
        return;
      }
    });
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Investigative and Diagnostic Reports</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          Attach radiographs, pathology and other diagnostic reports (PDF, JPG,
          JPEG, PNG — max 10 MB each).
        </p>
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Document type"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            disabled={uploading}
            className="w-32"
          >
            {INVESTIGATIVE_DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>

          <label className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-dashed border-border-strong rounded-lg cursor-pointer hover:bg-background text-text-body">
            <Upload className="h-3.5 w-3.5" aria-hidden />
            {uploading ? "Uploading…" : "Upload"}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileSelect}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      )}

      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {documents.length === 0 ? (
        <p className="text-sm text-text-disabled">No documents uploaded.</p>
      ) : (
        <ul className="divide-y divide-surface-muted">
          {documents.map((doc) => {
            const isImage = doc.file_type.startsWith("image/");
            return (
              <li key={doc.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  {isImage ? (
                    <ImageIcon className="h-4 w-4 shrink-0 text-text-disabled" aria-hidden />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-text-disabled" aria-hidden />
                  )}
                  {doc.document_type && (
                    <span className="shrink-0 rounded-md bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-body">
                      {doc.document_type}
                    </span>
                  )}
                  <a
                    href={doc.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-sm text-text-primary hover:underline"
                    title={doc.file_name}
                  >
                    {doc.file_name}
                  </a>
                  {doc.file_size != null && (
                    <span className="shrink-0 text-xs text-text-disabled">
                      {formatSize(doc.file_size)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {doc.url && (
                    <a
                      href={doc.url}
                      download={doc.file_name}
                      className="p-1.5 -m-1.5 text-text-disabled hover:text-text-primary"
                      aria-label={`Download ${doc.file_name}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleDelete(doc.id)}
                      disabled={isPending}
                      className="p-1.5 -m-1.5 text-text-disabled hover:text-danger disabled:opacity-50"
                      aria-label={`Remove ${doc.file_name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
