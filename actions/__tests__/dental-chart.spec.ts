/**
 * Specs for actions/dental-chart.ts.
 *
 * Uses the same lightweight in-memory mock DB pattern as
 * actions/__tests__/payment-allocation.spec.ts: only @/lib/auth/session is
 * mocked to fake the session/RLS identity, and a fake chainable Supabase
 * query builder backs every table read/write. @/lib/dental-chart/history is
 * also mocked so no attempt is made to reach a real (service-role) Supabase
 * client for the tooth_history append-only write — these specs assert
 * history WAS requested via the mock's call log instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ resolveSession: vi.fn() }));
// revalidatePath requires a real Next.js request scope; outside one it throws.
// These are unit tests of the action's own logic, not of cache invalidation.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const writeToothHistoryMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/dental-chart/history", () => ({
  writeToothHistory: (...args: unknown[]) => writeToothHistoryMock(...args),
}));

import { resolveSession } from "@/lib/auth/session";
import {
  getPatientDentalChart,
  upsertToothState,
  bulkUpdateTeeth,
  getToothHistory,
  linkTreatmentToTooth,
  unlinkTreatmentFromTooth,
} from "@/actions/dental-chart";

const CLINIC_A = "clinic-a";
const CLINIC_B = "clinic-b";
type Row = Record<string, unknown>;

/** Minimal fake Supabase query builder covering select/insert/update chains used by actions/dental-chart.ts. */
function makeDb(tables: Record<string, Row[]>) {
  function builder(tableName: string) {
    const table = tables[tableName] ?? (tables[tableName] = []);
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    let orderCol: string | null = null;
    let orderAscending = true;

    function applyFilters(): Row[] {
      return table.filter((r) => filters.every((f) => f(r)));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      is: (col: string, val: null) => {
        filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return api;
      },
      not: (col: string, op: string, val: unknown) => {
        if (op === "is" && val === null) filters.push((r) => r[col] != null);
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAscending = opts?.ascending !== false;
        return api;
      },
      insert: (row: Row) => {
        mode = "insert";
        payload = row;
        return api;
      },
      update: (row: Row) => {
        mode = "update";
        payload = row;
        return api;
      },
      maybeSingle: async () => {
        const rows = applyFilters();
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        if (mode === "insert") {
          const row: Row = {
            id: `id-${table.length + 1}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
            ...payload,
          };
          table.push(row);
          return { data: row, error: null };
        }
        if (mode === "update") {
          const rows = applyFilters();
          if (rows.length === 0) return { data: null, error: { message: "not found" } };
          Object.assign(rows[0], payload);
          return { data: rows[0], error: null };
        }
        const rows = applyFilters();
        return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } };
      },
      then: (onResolve: (v: { data: Row[]; error: null }) => unknown) => {
        let rows = applyFilters();
        if (orderCol) {
          const col = orderCol;
          rows = [...rows].sort((a, b) => {
            const av = a[col] as string | number | null;
            const bv = b[col] as string | number | null;
            if (av === bv) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av > bv ? 1 : -1) * (orderAscending ? 1 : -1);
          });
        }
        return Promise.resolve({ data: rows, error: null }).then(onResolve);
      },
    };
    return api;
  }
  return { from: (table: string) => builder(table) };
}

function asDentist(tables: Record<string, Row[]>, clinicId = CLINIC_A) {
  (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    db: makeDb(tables),
    profile: { id: "dentist-1", clinic_id: clinicId, role: "dentist" },
  });
}

function asRole(tables: Record<string, Row[]>, role: "receptionist" | "patient") {
  (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    db: makeDb(tables),
    profile: { id: "u1", clinic_id: CLINIC_A, role },
  });
}

const PATIENT_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const PATIENT_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function baseTables(): Record<string, Row[]> {
  return {
    patients: [{ id: PATIENT_A, clinic_id: CLINIC_A, deleted_at: null }],
    patient_teeth: [],
    tooth_history: [],
    treatments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPatientDentalChart", () => {
  it("loading a patient's chart returns all 32 adult FDI teeth, defaulting to normal", async () => {
    asDentist(baseTables());
    const result = await getPatientDentalChart(PATIENT_A, "adult");
    expect(result.error).toBeNull();
    expect(result.data?.teeth).toHaveLength(32);
    expect(result.data?.teeth.every((t) => t.tooth === null)).toBe(true);
  });

  it("loading a patient's chart returns all 20 primary FDI teeth", async () => {
    asDentist(baseTables());
    const result = await getPatientDentalChart(PATIENT_A, "primary");
    expect(result.data?.teeth).toHaveLength(20);
  });

  it("merges an existing patient_teeth row into the right tooth slot", async () => {
    const tables = baseTables();
    tables.patient_teeth.push({
      id: "pt-1",
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "root_canal_treated",
      treatment_stage: "completed",
      notes: null,
      deleted_at: null,
    });
    asDentist(tables);
    const result = await getPatientDentalChart(PATIENT_A, "adult");
    const tooth36 = result.data?.teeth.find((t) => t.toothNumber === 36);
    expect(tooth36?.tooth?.treatment_stage).toBe("completed");
    expect(tooth36?.tooth?.tooth_condition).toBe("root_canal_treated");
  });

  it("attaches treatments linked via tooth_number to the correct tooth", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: "tx-1",
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      treatment_type: "Root Canal Treatment",
      status: "completed",
      cost: 5000,
      performed_at: "2026-08-01T00:00:00Z",
      created_at: "2026-08-01T00:00:00Z",
      patient_visible_notes: null,
      appointment_id: "appt-1",
      deleted_at: null,
    });
    asDentist(tables);
    const result = await getPatientDentalChart(PATIENT_A, "adult");
    const tooth36 = result.data?.teeth.find((t) => t.toothNumber === 36);
    expect(tooth36?.treatments).toHaveLength(1);
    expect(tooth36?.treatments[0].treatment_type).toBe("Root Canal Treatment");
    // A different tooth must not see this treatment.
    const tooth37 = result.data?.teeth.find((t) => t.toothNumber === 37);
    expect(tooth37?.treatments).toHaveLength(0);
  });

  it("is forbidden for the receptionist role — matches CLAUDE.md: no clinical treatment access", async () => {
    asRole(baseTables(), "receptionist");
    const result = await getPatientDentalChart(PATIENT_A, "adult");
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/dentist/i);
  });

  it("is forbidden for the patient role", async () => {
    asRole(baseTables(), "patient");
    const result = await getPatientDentalChart(PATIENT_A, "adult");
    expect(result.data).toBeNull();
  });

  it("clinic isolation: a dentist from clinic A cannot load clinic B's patient chart", async () => {
    const tables = baseTables();
    tables.patients.push({ id: "patient-b", clinic_id: CLINIC_B, deleted_at: null });
    asDentist(tables, CLINIC_A);
    const result = await getPatientDentalChart("patient-b", "adult");
    expect(result.data).toBeNull();
    expect(result.error).toBe("Patient not found in this clinic.");
  });
});

describe("upsertToothState", () => {
  it("saving chart changes creates a new patient_teeth row when none exists yet", async () => {
    const tables = baseTables();
    asDentist(tables);
    const result = await upsertToothState({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "caries",
      treatment_stage: "recommended",
    });
    expect(result.error).toBeNull();
    expect(result.data?.tooth_condition).toBe("caries");
    expect(result.data?.treatment_stage).toBe("recommended");
    expect(tables.patient_teeth).toHaveLength(1);
    expect(writeToothHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("tooth state changes: updates the existing row instead of creating a duplicate", async () => {
    const tables = baseTables();
    tables.patient_teeth.push({
      id: "pt-1",
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "caries",
      treatment_stage: "recommended",
      notes: null,
      deleted_at: null,
    });
    asDentist(tables);
    const result = await upsertToothState({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "caries",
      treatment_stage: "planned",
    });
    expect(result.error).toBeNull();
    expect(tables.patient_teeth).toHaveLength(1); // no duplicate row
    expect(tables.patient_teeth[0].treatment_stage).toBe("planned");
  });

  it("appends tooth_history rather than overwriting — history call carries old and new treatment stage", async () => {
    const tables = baseTables();
    tables.patient_teeth.push({
      id: "pt-1",
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "normal",
      treatment_stage: "recommended",
      notes: null,
      deleted_at: null,
    });
    asDentist(tables);
    await upsertToothState({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "normal",
      treatment_stage: "completed",
    });
    expect(writeToothHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "status_changed",
        oldValue: expect.objectContaining({ treatment_stage: "recommended" }),
        newValue: expect.objectContaining({ treatment_stage: "completed" }),
      })
    );
  });

  it("rejects a tooth number that is not valid FDI for the given dentition", async () => {
    asDentist(baseTables());
    const result = await upsertToothState({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 99,
      tooth_condition: "normal",
      treatment_stage: null,
    });
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/not valid/i);
  });

  it("is forbidden for the receptionist role", async () => {
    asRole(baseTables(), "receptionist");
    const result = await upsertToothState({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "normal",
      treatment_stage: null,
    });
    expect(result.error).toMatch(/dentist/i);
  });

  it("clinic isolation: rejects a patient that does not belong to the caller's clinic", async () => {
    const tables = baseTables();
    tables.patients.push({ id: PATIENT_B, clinic_id: CLINIC_B, deleted_at: null });
    asDentist(tables, CLINIC_A);
    const result = await upsertToothState({
      patient_id: PATIENT_B,
      dentition_type: "adult",
      tooth_number: 36,
      tooth_condition: "normal",
      treatment_stage: null,
    });
    expect(result.error).toBe("Patient not found in this clinic.");
  });
});

describe("bulkUpdateTeeth (multi-select)", () => {
  it("applies the same condition/stage to every selected tooth in one call", async () => {
    const tables = baseTables();
    asDentist(tables);
    const result = await bulkUpdateTeeth({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_numbers: [14, 15, 16],
      tooth_condition: "caries",
      treatment_stage: "recommended",
    });
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(3);
    expect(tables.patient_teeth.map((t) => t.tooth_number).sort()).toEqual([14, 15, 16]);
    expect(tables.patient_teeth.every((t) => t.treatment_stage === "recommended")).toBe(true);
    // One history event per tooth.
    expect(writeToothHistoryMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an empty selection before touching the database", async () => {
    const tables = baseTables();
    asDentist(tables);
    const result = await bulkUpdateTeeth({
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_numbers: [],
      tooth_condition: "caries",
      treatment_stage: "recommended",
    });
    expect(result.data).toBeNull();
    expect(tables.patient_teeth).toHaveLength(0);
  });
});

describe("getToothHistory", () => {
  it("returns history rows for a tooth owned by the caller's clinic", async () => {
    const tables = baseTables();
    tables.patient_teeth.push({ id: "pt-1", clinic_id: CLINIC_A, patient_id: PATIENT_A, tooth_number: 36, dentition_type: "adult", status: "normal", deleted_at: null });
    tables.tooth_history.push(
      { id: "h1", patient_tooth_id: "pt-1", action: "status_changed", timestamp: "2026-08-01T00:00:00Z" },
      { id: "h2", patient_tooth_id: "pt-1", action: "note_added", timestamp: "2026-08-02T00:00:00Z" }
    );
    asDentist(tables);
    const result = await getToothHistory("pt-1");
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2);
  });

  it("clinic isolation: rejects a tooth that belongs to another clinic", async () => {
    const tables = baseTables();
    tables.patient_teeth.push({ id: "pt-b", clinic_id: CLINIC_B, patient_id: "patient-b", tooth_number: 36, dentition_type: "adult", status: "normal", deleted_at: null });
    asDentist(tables, CLINIC_A);
    const result = await getToothHistory("pt-b");
    expect(result.data).toBeNull();
    expect(result.error).toBe("Tooth not found in this clinic.");
  });
});

const TREATMENT_1 = "11111111-1111-4111-8111-111111111111";
const TREATMENT_2 = "22222222-2222-4222-8222-222222222222";

describe("linkTreatmentToTooth (past and current treatments)", () => {
  it("links a completed PAST treatment (recorded long before this tooth existed on the chart) to a tooth", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: TREATMENT_1,
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      treatment_type: "Root Canal Treatment",
      status: "completed",
      cost: 8000,
      tooth_number: null,
      dentition_type: null,
      deleted_at: null,
    });
    asDentist(tables);

    const result = await linkTreatmentToTooth({
      treatment_id: TREATMENT_1,
      dentition_type: "adult",
      tooth_number: 36,
    });

    expect(result.error).toBeNull();
    expect(result.data?.tooth_number).toBe(36);
    expect(result.data?.dentition_type).toBe("adult");
    // The tooth's chart status mirrors the (already existing) treatment's
    // status, exactly as if it had been linked at creation time.
    expect(tables.patient_teeth).toHaveLength(1);
    expect(tables.patient_teeth[0].status).toBe("completed");
    expect(writeToothHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "treatment_linked" })
    );
  });

  it("re-links a CURRENT (in-progress) treatment from one tooth to another — a correction, not a duplicate", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: TREATMENT_1,
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      treatment_type: "Filling",
      status: "in_progress",
      cost: 1500,
      tooth_number: 14, // charted against the wrong tooth originally
      dentition_type: "adult",
      deleted_at: null,
    });
    asDentist(tables);

    const result = await linkTreatmentToTooth({
      treatment_id: TREATMENT_1,
      dentition_type: "adult",
      tooth_number: 15,
    });

    expect(result.error).toBeNull();
    expect(result.data?.tooth_number).toBe(15); // moved, not duplicated
    expect(tables.treatments).toHaveLength(1); // still one treatment record
  });

  it("rejects an invalid tooth number for the dentition before touching the database", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: TREATMENT_1,
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      treatment_type: "Cleaning",
      status: "completed",
      cost: 500,
      deleted_at: null,
    });
    asDentist(tables);

    const result = await linkTreatmentToTooth({
      treatment_id: TREATMENT_1,
      dentition_type: "adult",
      tooth_number: 99,
    });

    expect(result.data).toBeNull();
    expect(result.error).toMatch(/not valid/i);
    expect(tables.treatments[0].tooth_number).toBeUndefined();
  });

  it("is forbidden for the receptionist role", async () => {
    const tables = baseTables();
    tables.treatments.push({ id: TREATMENT_1, clinic_id: CLINIC_A, patient_id: PATIENT_A, status: "completed", deleted_at: null });
    asRole(tables, "receptionist");
    const result = await linkTreatmentToTooth({ treatment_id: TREATMENT_1, dentition_type: "adult", tooth_number: 36 });
    expect(result.error).toMatch(/dentist/i);
  });

  it("clinic isolation: rejects a treatment that belongs to another clinic", async () => {
    const tables = baseTables();
    tables.treatments.push({ id: TREATMENT_2, clinic_id: CLINIC_B, patient_id: "patient-b", status: "completed", deleted_at: null });
    asDentist(tables, CLINIC_A);
    const result = await linkTreatmentToTooth({ treatment_id: TREATMENT_2, dentition_type: "adult", tooth_number: 36 });
    expect(result.data).toBeNull();
    expect(result.error).toBe("Treatment not found in this clinic.");
  });
});

describe("unlinkTreatmentFromTooth", () => {
  it("clears the treatment's tooth link and leaves the tooth's own chart status untouched", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: TREATMENT_1,
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      status: "completed",
      tooth_number: 36,
      dentition_type: "adult",
      deleted_at: null,
    });
    tables.patient_teeth.push({
      id: "pt-1",
      clinic_id: CLINIC_A,
      patient_id: PATIENT_A,
      dentition_type: "adult",
      tooth_number: 36,
      status: "completed",
      deleted_at: null,
    });
    asDentist(tables);
    writeToothHistoryMock.mockClear();

    const result = await unlinkTreatmentFromTooth(TREATMENT_1);

    expect(result.error).toBeNull();
    expect(result.data?.tooth_number ?? null).toBeNull();
    expect(result.data?.dentition_type ?? null).toBeNull();
    // Unlinking doesn't rewrite chart history — the tooth's own state stands.
    expect(tables.patient_teeth[0].status).toBe("completed");
    expect(writeToothHistoryMock).not.toHaveBeenCalled();
  });

  it("is forbidden for the receptionist role", async () => {
    const tables = baseTables();
    tables.treatments.push({ id: TREATMENT_1, clinic_id: CLINIC_A, patient_id: PATIENT_A, status: "completed", tooth_number: 36, dentition_type: "adult", deleted_at: null });
    asRole(tables, "receptionist");
    const result = await unlinkTreatmentFromTooth(TREATMENT_1);
    expect(result.error).toMatch(/dentist/i);
  });

  it("clinic isolation: rejects a treatment that belongs to another clinic", async () => {
    const tables = baseTables();
    tables.treatments.push({ id: TREATMENT_2, clinic_id: CLINIC_B, patient_id: "patient-b", status: "completed", tooth_number: 36, dentition_type: "adult", deleted_at: null });
    asDentist(tables, CLINIC_A);
    const result = await unlinkTreatmentFromTooth(TREATMENT_2);
    // No prior existence-check fetch here (matches updateTreatment's existing
    // single-UPDATE convention) — a cross-clinic id hits the same "0 rows
    // matched .single()" error path as any other DB failure. Still safely
    // returns null data; the exact message just isn't the specific
    // not-found string linkTreatmentToTooth gives (it DOES prefetch).
    expect(result.data).toBeNull();
    expect(result.error).toBe("Failed to unlink treatment.");
    expect(tables.treatments[0].clinic_id).toBe(CLINIC_B); // untouched
  });
});
