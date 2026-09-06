/**
 * components/dental-chart/ToothDetailPanel.tsx
 *
 * Click-a-tooth panel: current status/condition/notes (editable), linked
 * treatments (existing treatment records — never duplicated here, just
 * listed and opened via the shared TreatmentDetailDialog), and the tooth's
 * append-only change history.
 *
 * Built on the existing Dialog primitive (centered modal) — there is no
 * Sheet/side-panel component in this codebase to reuse instead.
 */

"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TreatmentDetailDialog } from "@/components/dentist/TreatmentDetailModal";
import { TreatmentFormDialog } from "@/components/dentist/TreatmentFormDialog";
import { upsertToothState, linkTreatmentToTooth, unlinkTreatmentFromTooth } from "@/actions/dental-chart";
import { getTreatmentsForPatient } from "@/actions/treatments";
import { TOOTH_STATUS_LABELS } from "@/lib/dental-chart/status";
import { TOOTH_STATUS_ORDER } from "@/lib/dental-chart/teeth";
import { TREATMENT_STATUS_LABELS, formatCurrency, formatDateTime } from "@/lib/utils";
import { Stethoscope, History as HistoryIcon, Link2, X } from "lucide-react";
import type { ToothChartEntry, ToothHistory, DentitionType, ToothStatus, Treatment } from "@/types";

export type ToothDetailPanelProps = {
  open: boolean;
  onClose: () => void;
  entry: ToothChartEntry | null;
  patientId: string;
  patientName?: string;
  appointmentId?: string;
  dentitionType: DentitionType;
  /** Called after a save (status/condition/notes, or a linked treatment) so the parent can refetch the chart. */
  onSaved: () => void;
};

export function ToothDetailPanel({
  open,
  onClose,
  entry,
  patientId,
  patientName,
  appointmentId,
  dentitionType,
  onSaved,
}: ToothDetailPanelProps) {
  const [status, setStatus] = useState<ToothStatus>("normal");
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingTreatmentId, setViewingTreatmentId] = useState<string | null>(null);

  // ── Link an existing (past or current) treatment to this tooth ──────────
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [patientTreatments, setPatientTreatments] = useState<Treatment[] | null>(null);
  const [loadingTreatments, setLoadingTreatments] = useState(false);
  const [selectedTreatmentId, setSelectedTreatmentId] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) return;
    setStatus(entry.tooth?.status ?? "normal");
    setCondition(entry.tooth?.condition ?? "");
    setNotes(entry.tooth?.notes ?? "");
    setError(null);
    setLinkPickerOpen(false);
    setPatientTreatments(null);
    setSelectedTreatmentId("");
    setLinkError(null);
  }, [entry]);

  if (!entry) return null;

  async function handleSave() {
    if (!entry) return;
    setSaving(true);
    setError(null);
    const result = await upsertToothState({
      patient_id: patientId,
      dentition_type: dentitionType,
      tooth_number: entry.toothNumber,
      status,
      condition,
      notes,
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved();
  }

  async function handleOpenLinkPicker() {
    setLinkPickerOpen((v) => !v);
    setLinkError(null);
    if (patientTreatments !== null) return; // already loaded
    setLoadingTreatments(true);
    const result = await getTreatmentsForPatient(patientId);
    setLoadingTreatments(false);
    if (result.error) {
      setLinkError(result.error);
      return;
    }
    setPatientTreatments((result.data as Treatment[] | null) ?? []);
  }

  async function handleLink() {
    if (!entry || !selectedTreatmentId) return;
    setLinking(true);
    setLinkError(null);
    const result = await linkTreatmentToTooth({
      treatment_id: selectedTreatmentId,
      dentition_type: dentitionType,
      tooth_number: entry.toothNumber,
    });
    setLinking(false);
    if (result.error) {
      setLinkError(result.error);
      return;
    }
    setLinkPickerOpen(false);
    setSelectedTreatmentId("");
    onSaved();
  }

  async function handleUnlink(treatmentId: string) {
    setUnlinkingId(treatmentId);
    setError(null);
    const result = await unlinkTreatmentFromTooth(treatmentId);
    setUnlinkingId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onSaved();
  }

  // Treatments eligible to link: not deleted (already excluded by the
  // action), and not already linked to THIS tooth (those already appear in
  // the Linked Treatments list above — offering them again would just be a
  // confusing no-op). A treatment linked to a DIFFERENT tooth is still
  // offered — selecting it moves the link here, which is a legitimate "I
  // charted the wrong tooth" correction.
  const linkableTreatments = (patientTreatments ?? []).filter(
    (t) => !(t.tooth_number === entry?.toothNumber && t.dentition_type === dentitionType)
  );

  return (
    <>
      <Dialog open={open} onClose={onClose} title={`Tooth ${entry.toothNumber}`} size="md">
        <div className="p-5 space-y-5">
          {error && (
            <div className="rounded-lg bg-danger-bg border border-danger-border px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <Field label="Status" htmlFor="tooth-status">
              <Select
                id="tooth-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ToothStatus)}
              >
                {TOOTH_STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {TOOTH_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Condition" htmlFor="tooth-condition" hint="e.g. Caries, Fractured cusp">
              <Input
                id="tooth-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                placeholder="Optional clinical condition"
              />
            </Field>

            <Field label="Notes" htmlFor="tooth-notes">
              <Textarea
                id="tooth-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional chart note"
              />
            </Field>

            <div className="flex justify-end">
              <Button size="sm" onClick={handleSave} isLoading={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          <div className="border-t border-surface-muted pt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wide flex items-center gap-1.5">
                <Stethoscope className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
                Linked Treatments
              </h3>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="xs" onClick={handleOpenLinkPicker}>
                  <Link2 className="h-3 w-3" aria-hidden />
                  Link Existing
                </Button>
                <TreatmentFormDialog
                  appointmentId={appointmentId}
                  patientId={patientId}
                  toothNumber={entry.toothNumber}
                  dentitionType={dentitionType}
                  title={`Add Treatment — Tooth ${entry.toothNumber}`}
                  triggerVariant="outline"
                  triggerSize="xs"
                  patientName={patientName}
                  onClose={onSaved}
                >
                  Add Treatment
                </TreatmentFormDialog>
              </div>
            </div>

            {linkPickerOpen && (
              <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                {linkError && (
                  <p className="text-xs text-danger">{linkError}</p>
                )}
                {loadingTreatments ? (
                  <p className="text-xs text-text-secondary">Loading this patient&apos;s treatments…</p>
                ) : linkableTreatments.length === 0 ? (
                  <p className="text-xs text-text-disabled">
                    No other treatments to link — every existing treatment for this patient is already linked here.
                  </p>
                ) : (
                  <>
                    <Select
                      value={selectedTreatmentId}
                      onChange={(e) => setSelectedTreatmentId(e.target.value)}
                      aria-label="Select a treatment to link"
                    >
                      <option value="">Select a past or current treatment…</option>
                      {linkableTreatments.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.treatment_type} · {t.performed_at ? formatDateTime(t.performed_at) : "not yet performed"} · {TREATMENT_STATUS_LABELS[t.status]}
                          {t.tooth_number != null ? ` (currently Tooth ${t.tooth_number})` : ""}
                        </option>
                      ))}
                    </Select>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="xs" onClick={() => setLinkPickerOpen(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        onClick={handleLink}
                        isLoading={linking}
                        disabled={!selectedTreatmentId}
                      >
                        {linking ? "Linking…" : "Link"}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {entry.treatments.length === 0 ? (
              <p className="text-xs text-text-disabled">No treatments linked to this tooth yet.</p>
            ) : (
              <ul className="divide-y divide-surface-muted border border-border rounded-lg overflow-hidden">
                {entry.treatments.map((t) => (
                  <li key={t.id} className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => setViewingTreatmentId(t.id)}
                      className="flex-1 min-w-0 flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-background transition-colors"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm text-text-primary truncate">{t.treatment_type}</span>
                        <span className="block text-[11px] text-text-secondary">
                          {t.performed_at ? formatDateTime(t.performed_at) : "Not yet performed"}
                          {" · "}
                          {formatCurrency(Number(t.cost))}
                        </span>
                      </span>
                      <StatusBadge
                        label={TREATMENT_STATUS_LABELS[t.status]}
                        variant={
                          t.status === "completed" ? "success" : t.status === "in_progress" ? "info" : t.status === "cancelled" ? "error" : "default"
                        }
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleUnlink(t.id)}
                      disabled={unlinkingId === t.id}
                      aria-label={`Unlink ${t.treatment_type} from this tooth`}
                      title="Unlink from this tooth"
                      className="px-2.5 min-w-10 flex items-center justify-center text-text-disabled hover:text-danger hover:bg-danger-bg transition-colors border-l border-surface-muted disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-surface-muted pt-4 space-y-2">
            <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wide flex items-center gap-1.5">
              <HistoryIcon className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
              History
            </h3>
            {entry.history.length === 0 ? (
              <p className="text-xs text-text-disabled">No chart history yet.</p>
            ) : (
              <ul className="space-y-2">
                {entry.history.map((h) => (
                  <HistoryRow key={h.id} history={h} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </Dialog>

      <TreatmentDetailDialog
        treatmentId={viewingTreatmentId}
        open={!!viewingTreatmentId}
        onClose={() => setViewingTreatmentId(null)}
      />
    </>
  );
}

function HistoryRow({ history }: { history: ToothHistory }) {
  const oldValue = history.old_value as { status?: string } | null;
  const newValue = history.new_value as { status?: string; condition?: string; notes?: string } | null;

  let summary = "Updated";
  if (history.action === "status_changed" && newValue?.status) {
    summary = oldValue?.status
      ? `Status: ${TOOTH_STATUS_LABELS[oldValue.status as ToothStatus] ?? oldValue.status} → ${TOOTH_STATUS_LABELS[newValue.status as ToothStatus] ?? newValue.status}`
      : `Status set to ${TOOTH_STATUS_LABELS[newValue.status as ToothStatus] ?? newValue.status}`;
  } else if (history.action === "treatment_linked") {
    summary = `Linked to a treatment${newValue?.status ? ` — status ${TOOTH_STATUS_LABELS[newValue.status as ToothStatus] ?? newValue.status}` : ""}`;
  } else if (history.action === "condition_updated") {
    summary = newValue?.condition ? `Condition noted: ${newValue.condition}` : "Condition updated";
  } else if (history.action === "note_added") {
    summary = "Note updated";
  }

  return (
    <li className="text-xs text-text-body flex items-start gap-2">
      <span className="text-text-disabled tabular-nums shrink-0">{formatDateTime(history.timestamp)}</span>
      <span className="min-w-0">{summary}</span>
    </li>
  );
}
