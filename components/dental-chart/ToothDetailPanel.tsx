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
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TreatmentDetailDialog } from "@/components/dentist/TreatmentDetailModal";
import { TreatmentFormDialog } from "@/components/dentist/TreatmentFormDialog";
import { upsertToothState, unlinkTreatmentFromTooth } from "@/actions/dental-chart";
import { TOOTH_STATUS_LABELS, TOOTH_CONDITION_LABELS, TREATMENT_STAGE_LABELS } from "@/lib/dental-chart/status";
import { TOOTH_CONDITION_ORDER, TREATMENT_STAGE_ORDER } from "@/types";
import { TREATMENT_STATUS_LABELS, formatCurrency, formatDateTime } from "@/lib/utils";
import { Stethoscope, History as HistoryIcon, X } from "lucide-react";
import type { ToothChartEntry, ToothHistory, DentitionType, ToothStatus, ToothCondition, TreatmentStage } from "@/types";

/** Value the Treatment Status <select> uses for "no stage set" — Select's DOM value is always a string, so `null` needs a sentinel. */
const NO_STAGE = "__none__";

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
  const [condition, setCondition] = useState<ToothCondition>("normal");
  const [stage, setStage] = useState<TreatmentStage | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingTreatmentId, setViewingTreatmentId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) return;
    setCondition(entry.tooth?.tooth_condition ?? "normal");
    setStage(entry.tooth?.treatment_stage ?? null);
    setNotes(entry.tooth?.notes ?? "");
    setError(null);
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
      tooth_condition: condition,
      treatment_stage: stage,
      notes,
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
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
            <Field label="Condition" htmlFor="tooth-condition">
              <Select
                id="tooth-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as ToothCondition)}
              >
                {TOOTH_CONDITION_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {TOOTH_CONDITION_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Treatment Status" htmlFor="tooth-stage" hint="Leave as “No treatment underway” when nothing is planned for this tooth.">
              <Select
                id="tooth-stage"
                value={stage ?? NO_STAGE}
                onChange={(e) => setStage(e.target.value === NO_STAGE ? null : (e.target.value as TreatmentStage))}
              >
                <option value={NO_STAGE}>No treatment underway</option>
                {TREATMENT_STAGE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {TREATMENT_STAGE_LABELS[s]}
                  </option>
                ))}
              </Select>
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

type HistoryValue = {
  // New shape (from 20260909000000 onward).
  tooth_condition?: ToothCondition;
  treatment_stage?: TreatmentStage | null;
  // Legacy shape (rows written before this migration) — still rendered
  // correctly so existing history keeps displaying rather than going blank.
  status?: string;
  condition?: string;
  notes?: string;
};

/** A stage/condition label, tolerating either the current or the legacy vocabulary so old and new history rows both render sensibly. */
function stageOrStatusLabel(v: HistoryValue | null): string | null {
  if (!v) return null;
  if (v.treatment_stage) return TREATMENT_STAGE_LABELS[v.treatment_stage];
  if (v.status) return TOOTH_STATUS_LABELS[v.status as ToothStatus] ?? v.status;
  return null;
}

function conditionLabel(v: HistoryValue | null): string | null {
  if (!v) return null;
  if (v.tooth_condition) return TOOTH_CONDITION_LABELS[v.tooth_condition];
  if (v.condition) return v.condition;
  return null;
}

function HistoryRow({ history }: { history: ToothHistory }) {
  const oldValue = history.old_value as HistoryValue | null;
  const newValue = history.new_value as HistoryValue | null;

  let summary = "Updated";
  if (history.action === "status_changed") {
    const from = stageOrStatusLabel(oldValue);
    const to = stageOrStatusLabel(newValue) ?? "No treatment underway";
    summary = from ? `Treatment status: ${from} → ${to}` : `Treatment status set to ${to}`;
  } else if (history.action === "treatment_linked") {
    const stage = stageOrStatusLabel(newValue);
    summary = `Linked to a treatment${stage ? ` — status ${stage}` : ""}`;
  } else if (history.action === "condition_updated") {
    const condition = conditionLabel(newValue);
    summary = condition ? `Condition set to ${condition}` : "Condition updated";
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
