/**
 * Specs for the treatment ⇄ dental-chart sync wired into
 * actions/treatments.ts (createTreatment / updateTreatment).
 *
 * Covers CLAUDE.md's explicit requirement: "Existing treatments without a
 * tooth must continue working" — plus the auto-sync that keeps a linked
 * tooth's chart status in step with its treatment's lifecycle status.
 *
 * Same mock-DB pattern as actions/__tests__/dental-chart.spec.ts.
 * @/lib/dental-chart/history is mocked so no service-role network call is
 * attempted for the tooth_history append-only write, and @/lib/supabase/admin
 * is mocked for the same reason — see the note above that mock.
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

/*
 * updateTreatment reads the PRE-UPDATE row through the service role, because
 * 20260907000100 withholds treatments.internal_notes from `authenticated` and
 * the treatment_history diff has to see it. That is a second service-role call
 * this file did not have when it was written.
 *
 * Unmocked it makes these unit tests environment-dependent in the worst way:
 * with the variables unset createAdminClient() THROWS and the action returns
 * "Unexpected error"; with them set it issues a real request for a fixture id
 * that is not a uuid, whose error the action deliberately ignores — so the
 * suite passes by accident rather than by design. Pointing it at the same
 * in-memory tables makes the "before" row the one the test actually seeded.
 */
const adminTables: { current: Record<string, Row[]> } = { current: {} };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeDb(adminTables.current),
}));

import { resolveSession } from "@/lib/auth/session";
import { createTreatment, updateTreatment } from "@/actions/treatments";

const CLINIC = "clinic-1";
const PATIENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const APPOINTMENT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
  function builder(tableName: string) {
    const table = tables[tableName] ?? (tables[tableName] = []);
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;

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
      maybeSingle: async () => {
        const rows = applyFilters();
        return { data: rows[0] ?? null, error: null };
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
    };
    return api;
  }
  return { from: (table: string) => builder(table) };
}

function baseTables(): Record<string, Row[]> {
  return { treatments: [], patient_teeth: [], tooth_history: [] };
}

function asDentist(tables: Record<string, Row[]>) {
  adminTables.current = tables;
  (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    db: makeDb(tables),
    profile: { id: "dentist-1", clinic_id: CLINIC, role: "dentist" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createTreatment — dental chart linking", () => {
  it("existing-shape treatments without a tooth continue to work unchanged", async () => {
    const tables = baseTables();
    asDentist(tables);

    const result = await createTreatment({
      appointment_id: APPOINTMENT_ID,
      patient_id: PATIENT_ID,
      treatment_type: "Cleaning",
      cost: 500,
      status: "planned",
    });

    expect(result.error).toBeNull();
    expect(result.data?.tooth_number ?? null).toBeNull();
    // No tooth was linked, so the chart must be untouched.
    expect(tables.patient_teeth).toHaveLength(0);
    expect(writeToothHistoryMock).not.toHaveBeenCalled();
  });

  it("linking a treatment to a tooth creates/updates that tooth's chart entry", async () => {
    const tables = baseTables();
    asDentist(tables);

    const result = await createTreatment({
      appointment_id: APPOINTMENT_ID,
      patient_id: PATIENT_ID,
      treatment_type: "Root Canal Treatment",
      cost: 8000,
      status: "planned",
      tooth_number: 36,
      dentition_type: "adult",
    });

    expect(result.error).toBeNull();
    expect(result.data?.tooth_number).toBe(36);
    expect(tables.patient_teeth).toHaveLength(1);
    expect(tables.patient_teeth[0].tooth_number).toBe(36);
    expect(tables.patient_teeth[0].status).toBe("planned"); // mirrors the treatment's own status
    expect(writeToothHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "treatment_linked" })
    );
  });

  it("a cancelled treatment never sets the tooth's chart status", async () => {
    const tables = baseTables();
    asDentist(tables);

    const result = await createTreatment({
      appointment_id: APPOINTMENT_ID,
      patient_id: PATIENT_ID,
      treatment_type: "Extraction",
      cost: 1200,
      status: "cancelled",
      tooth_number: 47,
      dentition_type: "adult",
    });

    expect(result.error).toBeNull();
    // toothStatusForTreatmentStatus("cancelled") is null — sync is a no-op.
    expect(tables.patient_teeth).toHaveLength(0);
    expect(writeToothHistoryMock).not.toHaveBeenCalled();
  });
});

describe("updateTreatment — dental chart linking", () => {
  it("re-syncs the tooth's status when only the treatment's status changes (tooth link not resent)", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: "tx-1",
      clinic_id: CLINIC,
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      treatment_type: "Root Canal Treatment",
      status: "planned",
      cost: 8000,
      tooth_number: 36,
      dentition_type: "adult",
      deleted_at: null,
    });
    tables.patient_teeth.push({
      id: "pt-1",
      clinic_id: CLINIC,
      patient_id: PATIENT_ID,
      dentition_type: "adult",
      tooth_number: 36,
      status: "planned",
      condition: "caries",
      tooth_condition: "caries",
      treatment_stage: "planned",
      notes: "Sensitive to cold",
      deleted_at: null,
    });
    asDentist(tables);

    const result = await updateTreatment("tx-1", { status: "completed" });

    expect(result.error).toBeNull();
    expect(tables.patient_teeth).toHaveLength(1); // no duplicate row
    expect(tables.patient_teeth[0].treatment_stage).toBe("completed");
    expect(tables.patient_teeth[0].status).toBe("completed"); // legacy mirror
    // The sync only knows about the treatment's stage — the dentist's own
    // chart condition and notes must survive a treatment-driven sync untouched.
    expect(tables.patient_teeth[0].tooth_condition).toBe("caries");
    expect(tables.patient_teeth[0].notes).toBe("Sensitive to cold");
  });

  it("cancelling a linked treatment leaves the tooth's existing chart status alone", async () => {
    const tables = baseTables();
    tables.treatments.push({
      id: "tx-1",
      clinic_id: CLINIC,
      patient_id: PATIENT_ID,
      appointment_id: APPOINTMENT_ID,
      treatment_type: "Extraction",
      status: "in_progress",
      cost: 1200,
      tooth_number: 47,
      dentition_type: "adult",
      deleted_at: null,
    });
    tables.patient_teeth.push({
      id: "pt-2",
      clinic_id: CLINIC,
      patient_id: PATIENT_ID,
      dentition_type: "adult",
      tooth_number: 47,
      status: "completed", // e.g. a prior unrelated treatment already completed
      condition: null,
      notes: null,
      deleted_at: null,
    });
    asDentist(tables);
    writeToothHistoryMock.mockClear();

    const result = await updateTreatment("tx-1", { status: "cancelled" });

    expect(result.error).toBeNull();
    expect(tables.patient_teeth[0].status).toBe("completed"); // untouched
    expect(writeToothHistoryMock).not.toHaveBeenCalled();
  });
});
