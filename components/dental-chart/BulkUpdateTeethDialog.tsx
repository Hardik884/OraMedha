/**
 * components/dental-chart/BulkUpdateTeethDialog.tsx
 *
 * Multi-select action: apply the same status/condition/notes to every
 * selected tooth in one call — useful for procedures spanning multiple
 * teeth (e.g. scaling across a quadrant, a bridge span). Deliberately kept
 * to chart-state fields only, not a form for creating N separate treatment
 * records — that stays a per-tooth action from the detail panel so cost,
 * medications, and billing are never silently duplicated across teeth.
 */

"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { bulkUpdateTeeth } from "@/actions/dental-chart";
import { TOOTH_CONDITION_LABELS, TREATMENT_STAGE_LABELS } from "@/lib/dental-chart/status";
import { TOOTH_CONDITION_ORDER, TREATMENT_STAGE_ORDER } from "@/types";
import type { DentitionType, ToothCondition, TreatmentStage } from "@/types";

/** Value the Treatment Status <select> uses for "no stage set" — Select's DOM value is always a string, so `null` needs a sentinel. */
const NO_STAGE = "__none__";

export type BulkUpdateTeethDialogProps = {
  open: boolean;
  onClose: () => void;
  patientId: string;
  dentitionType: DentitionType;
  toothNumbers: number[];
  onSaved: () => void;
};

export function BulkUpdateTeethDialog({
  open,
  onClose,
  patientId,
  dentitionType,
  toothNumbers,
  onSaved,
}: BulkUpdateTeethDialogProps) {
  const [condition, setCondition] = useState<ToothCondition>("normal");
  const [stage, setStage] = useState<TreatmentStage | null>("recommended");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const result = await bulkUpdateTeeth({
      patient_id: patientId,
      dentition_type: dentitionType,
      tooth_numbers: toothNumbers,
      tooth_condition: condition,
      treatment_stage: stage,
      notes,
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNotes("");
    onSaved();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Update ${toothNumbers.length} Selected Teeth`}
      description={toothNumbers.slice().sort((a, b) => a - b).join(", ")}
      size="sm"
    >
      <div className="p-5 space-y-4">
        {error && (
          <div className="rounded-lg bg-danger-bg border border-danger-border px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <Field label="Condition" htmlFor="bulk-condition">
          <Select id="bulk-condition" value={condition} onChange={(e) => setCondition(e.target.value as ToothCondition)}>
            {TOOTH_CONDITION_ORDER.map((c) => (
              <option key={c} value={c}>
                {TOOTH_CONDITION_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Treatment Status" htmlFor="bulk-stage">
          <Select
            id="bulk-stage"
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

        <Field label="Notes" htmlFor="bulk-notes">
          <Textarea
            id="bulk-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional — applied to every selected tooth"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} isLoading={saving}>
            {saving ? "Saving…" : `Apply to ${toothNumbers.length} Teeth`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
