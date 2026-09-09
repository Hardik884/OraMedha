/**
 * lib/dental-chart/sync.ts
 *
 * Shared patient_teeth upsert + history-write logic, used by BOTH:
 *   - actions/dental-chart.ts  → upsertToothState / bulkUpdateTeeth (direct
 *     chart edits made from the Dental Chart UI; failures are fatal and
 *     surfaced to the dentist).
 *   - actions/treatments.ts    → createTreatment / updateTreatment, when the
 *     dentist links a treatment to a tooth (an auxiliary sync; failures are
 *     logged but never block saving the treatment — the same non-fatal
 *     posture as lib/follow-ups/complete-linked.ts and
 *     lib/appointments/history.ts).
 *
 * Kept as a lib helper rather than duplicated in both action files, per
 * CLAUDE.md §13.8 ("if a pattern is used in more than two places, extract it
 * into a shared utility").
 *
 * FIELDS (see migration 20260909000000): a tooth carries two independent,
 * fixed-vocabulary fields — `tooth_condition` (what the tooth IS) and
 * `treatment_stage` (what stage its treatment is at, nullable) — plus a free
 * `notes` field. The legacy `status`/`condition` columns are also written on
 * every save, derived from the new fields, purely so any code that still
 * reads them (or a history row written before this migration) keeps seeing a
 * value consistent with the current state; nothing in the current UI reads
 * them back.
 */

import { writeToothHistory, type ToothHistoryAction } from "@/lib/dental-chart/history";
import { isValidToothNumber } from "@/lib/dental-chart/teeth";
import type { DentitionType, PatientTooth, ToothCondition, ToothStatus, TreatmentStage } from "@/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

/** Best-effort legacy `status` derived from the new fields — see file header. */
function legacyStatusFor(condition: ToothCondition, stage: TreatmentStage | null): ToothStatus {
  if (stage) return stage;
  if (condition === "missing_extracted") return "missing";
  return "normal";
}

/** Best-effort legacy free-text `condition` derived from the new field — see file header. */
function legacyConditionFor(condition: ToothCondition): string | null {
  return condition === "normal" ? null : condition.replace(/_/g, " ");
}

export type UpsertToothRowParams = {
  clinicId: string;
  patientId: string;
  dentitionType: DentitionType;
  toothNumber: number;
  toothCondition: ToothCondition;
  treatmentStage: TreatmentStage | null;
  notes?: string | null;
  performedBy: string | null;
  /** Set when this write originated from linking/saving a treatment. */
  treatmentId?: string | null;
  /**
   * When true, `toothCondition`/`notes` are left exactly as they are on an
   * existing row (only `treatmentStage` and the treatment link are touched)
   * — used by the treatment-linking sync, which only ever knows about a
   * treatment's status, not the dentist's clinical condition or chart notes.
   * Defaults to false: the Dental Chart's own edit form always submits the
   * tooth's complete current state, so a direct chart edit is a full
   * overwrite (including intentionally clearing condition/notes back to
   * "normal"/empty).
   */
  preserveExistingConditionAndNotes?: boolean;
};

export type UpsertToothRowResult =
  | { ok: true; data: PatientTooth }
  | { ok: false; error: string };

/**
 * Insert or update a single patient_teeth row (keyed on
 * patient_id + dentition_type + tooth_number) and append a tooth_history
 * event describing what changed. Runs under the caller's RLS-scoped `db`
 * client — the dentist write policies on patient_teeth allow this directly;
 * only the tooth_history insert (no client write policy) goes through the
 * service-role client inside writeToothHistory.
 */
export async function upsertToothRow(
  db: DbClient,
  params: UpsertToothRowParams
): Promise<UpsertToothRowResult> {
  if (!isValidToothNumber(params.dentitionType, params.toothNumber)) {
    return { ok: false, error: `Tooth ${params.toothNumber} is not valid for ${params.dentitionType} dentition.` };
  }

  const { data: existing } = await db
    .from("patient_teeth")
    .select("*")
    .eq("patient_id", params.patientId)
    .eq("dentition_type", params.dentitionType)
    .eq("tooth_number", params.toothNumber)
    .is("deleted_at", null)
    .maybeSingle();

  const existingRow = existing as PatientTooth | null;
  const nextValue = params.preserveExistingConditionAndNotes
    ? {
        tooth_condition: existingRow?.tooth_condition ?? params.toothCondition,
        treatment_stage: params.treatmentStage,
        notes: existingRow?.notes ?? params.notes ?? null,
      }
    : {
        tooth_condition: params.toothCondition,
        treatment_stage: params.treatmentStage,
        notes: params.notes ?? null,
      };
  const legacyStatus = legacyStatusFor(nextValue.tooth_condition, nextValue.treatment_stage);
  const legacyCondition = legacyConditionFor(nextValue.tooth_condition);

  let row: PatientTooth | null = null;
  let historyAction: ToothHistoryAction;
  let oldValue: Record<string, unknown> | null = null;

  if (existingRow) {
    oldValue = {
      tooth_condition: existingRow.tooth_condition,
      treatment_stage: existingRow.treatment_stage,
      notes: existingRow.notes,
    };

    const { data, error } = await db
      .from("patient_teeth")
      .update({
        tooth_condition: nextValue.tooth_condition,
        treatment_stage: nextValue.treatment_stage,
        notes: nextValue.notes,
        status: legacyStatus,
        condition: legacyCondition,
        updated_by: params.performedBy,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingRow.id)
      .select()
      .single();

    if (error) {
      console.error("[upsertToothRow] update failed", error);
      return { ok: false, error: "Failed to update tooth." };
    }
    row = data as PatientTooth;
    historyAction = params.treatmentId
      ? "treatment_linked"
      : oldValue.treatment_stage !== nextValue.treatment_stage
        ? "status_changed"
        : oldValue.tooth_condition !== nextValue.tooth_condition
          ? "condition_updated"
          : "note_added";
  } else {
    const { data, error } = await db
      .from("patient_teeth")
      .insert({
        clinic_id: params.clinicId,
        patient_id: params.patientId,
        dentition_type: params.dentitionType,
        tooth_number: params.toothNumber,
        tooth_condition: nextValue.tooth_condition,
        treatment_stage: nextValue.treatment_stage,
        notes: nextValue.notes,
        status: legacyStatus,
        condition: legacyCondition,
        updated_by: params.performedBy,
      })
      .select()
      .single();

    if (error) {
      console.error("[upsertToothRow] insert failed", error);
      return { ok: false, error: "Failed to create tooth chart entry." };
    }
    row = data as PatientTooth;
    historyAction = params.treatmentId ? "treatment_linked" : "status_changed";
  }

  // Non-fatal: the tooth row is already saved. A history-write failure is
  // logged (inside writeToothHistory) but never rolls back the chart update.
  await writeToothHistory({
    patientToothId: row.id,
    action: historyAction,
    oldValue,
    newValue: nextValue,
    performedBy: params.performedBy,
    treatmentId: params.treatmentId ?? null,
  });

  return { ok: true, data: row };
}

/**
 * Maps a treatment's lifecycle status to the tooth treatment stage it
 * implies. `cancelled` deliberately returns null — a cancelled treatment
 * shouldn't silently change what the chart says is happening to the tooth.
 * There is no treatment status that implies `recommended`: that stage is set
 * directly from the chart, before any treatment record necessarily exists.
 */
export function treatmentStageForTreatmentStatus(
  treatmentStatus: "planned" | "in_progress" | "completed" | "cancelled"
): TreatmentStage | null {
  switch (treatmentStatus) {
    case "planned":
      return "planned";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "cancelled":
      return null;
  }
}

/**
 * Shared "keep a linked tooth's chart status in step with its treatment"
 * sync, used by:
 *   - actions/treatments.ts   → createTreatment / updateTreatment, whenever
 *     the treatment being saved carries a tooth link (auxiliary side effect
 *     of saving a treatment; failures are logged but never block the save).
 *   - actions/dental-chart.ts → linkTreatmentToTooth, when the dentist
 *     retroactively links an existing (past or current) treatment to a
 *     tooth from the chart itself.
 *
 * `cancelled` treatments are a deliberate no-op — see
 * treatmentStageForTreatmentStatus above. The tooth's own condition and
 * notes are always preserved: a treatment record has no clinical condition
 * of its own to overwrite them with.
 */
export async function syncToothForTreatment(
  db: DbClient,
  params: {
    clinicId: string;
    performedBy: string;
    treatmentId: string;
    patientId: string;
    toothNumber: number | null | undefined;
    dentitionType: DentitionType | null | undefined;
    treatmentStatus: "planned" | "in_progress" | "completed" | "cancelled";
  }
): Promise<void> {
  if (params.toothNumber == null || !params.dentitionType) return;

  const stage = treatmentStageForTreatmentStatus(params.treatmentStatus);
  if (!stage) return; // cancelled — leave the chart's own stage untouched

  try {
    const result = await upsertToothRow(db, {
      clinicId: params.clinicId,
      patientId: params.patientId,
      dentitionType: params.dentitionType,
      toothNumber: params.toothNumber,
      toothCondition: "normal", // ignored — preserveExistingConditionAndNotes keeps the real value
      treatmentStage: stage,
      performedBy: params.performedBy,
      treatmentId: params.treatmentId,
      preserveExistingConditionAndNotes: true,
    });
    if (!result.ok) {
      console.error("[syncToothForTreatment]", result.error);
    }
  } catch (err) {
    console.error("[syncToothForTreatment] unexpected:", err);
  }
}
