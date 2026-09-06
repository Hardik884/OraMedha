/**
 * actions/billing.ts — unit tests with a lightweight mock DB (no database).
 *
 * Covers what the Billing & Payments spec calls "extremely important":
 *   - clinic isolation on the staff path (getStaffBill)
 *   - patient isolation on the portal path (getPortalTreatmentBill /
 *     getPortalBillsList never resolve another patient's data, and never
 *     trust a client-supplied patient id)
 *   - digital signature retrieval (present / missing). Since 20260903000400 the
 *     bucket is private, so the stored value is an object PATH and the bill
 *     carries a freshly SIGNED url — the mock storage below is what proves the
 *     signing step actually happens rather than the raw path leaking through
 *   - per-treatment vs. whole-visit scoping reuses the same data path
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ resolveSession: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServerClient: vi.fn() }));
// The dentist named on a bill is resolved through the service role since
// migration 20260905090000 — a portal patient can no longer read a staff
// profiles row at all, so reading it with the caller's own client would work
// for staff and silently return nothing for the patient the bill is FOR.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { resolveSession } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getStaffBill,
  getPatientBillsList,
  getClinicBillsList,
  getPortalBillsList,
  getPortalTreatmentBill,
} from "@/actions/billing";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

/** Generic query-builder mock: supports eq/is/in/order + single/maybeSingle/then. */
function makeGenericDb(tables: Tables, currentUserId = "portal-user-1") {
  function builder(table: string) {
    const predicates: Array<(r: Row) => boolean> = [];
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        predicates.push((r) => r[col] === val);
        return api;
      },
      is: (col: string, val: unknown) => {
        predicates.push((r) => (r[col] ?? null) === val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        predicates.push((r) => vals.includes(r[col]));
        return api;
      },
      order: () => api,
      single: () => {
        const rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
        return Promise.resolve(
          rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } }
        );
      },
      maybeSingle: () => {
        const rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: (onResolve: (v: unknown) => unknown) => {
        const rows = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
        return Promise.resolve({ data: rows, error: null }).then(onResolve);
      },
    };
    return api;
  }
  const client = {
    from: (table: string) => builder(table),
    auth: { getUser: async () => ({ data: { user: { id: currentUserId } } }) },
    // The dentist-signatures bucket is private, so a stored path has to be
    // signed before it can be rendered. The stub returns a URL that is
    // recognisably NOT the stored value, so a test asserting on it cannot pass
    // if the signing step were skipped and the raw path passed through.
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => ({
          data: { signedUrl: `https://signed.example/${bucket}/${path}?exp=${ttl}` },
          error: null,
        }),
      }),
    },
  };

  // The same fixture also answers as the service-role client, so the dentist
  // lookup in fetchDentistInfo resolves against the `profiles` rows each test
  // declares. Registering it here rather than per test keeps every existing
  // test body unchanged — they already pass this object to resolveSession.
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(client);

  return client;
}

beforeEach(() => vi.clearAllMocks());

const CLINIC_A = "clinic-a";
const CLINIC_B = "clinic-b";

describe("getStaffBill", () => {
  it("clinic isolation: an appointment belonging to another clinic is not found", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        // Appointment exists, but for CLINIC_B — the caller is CLINIC_A.
        appointments: [
          { id: "appt-1", clinic_id: CLINIC_B, patient_id: "p1", dentist_id: "d1", scheduled_at: "2026-08-10T09:00:00Z" },
        ],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getStaffBill("appt-1");
    expect(result.data).toBeNull();
    expect(result.error).toBe("Appointment not found.");
  });

  it("is forbidden for the patient role", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({}),
      profile: { id: "u1", clinic_id: CLINIC_A, role: "patient" },
    });

    const result = await getStaffBill("appt-1");
    expect(result.data).toBeNull();
    expect(result.error).toBe("Forbidden");
  });

  it("builds a whole-visit bill and signs the dentist's stored signature", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        appointments: [
          { id: "appt-1", clinic_id: CLINIC_A, patient_id: "p1", dentist_id: "d1", scheduled_at: "2026-08-10T09:00:00Z" },
        ],
        patients: [{ id: "p1", clinic_id: CLINIC_A, name: "Asha Menon", phone: "9876543210" }],
        treatments: [
          {
            id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A,
            treatment_type: "Root Canal", cost: 8000, status: "completed",
            opd_charged: true, opd_fee: 300, xray_taken: true, xray_cost: 400,
            performed_at: "2026-08-10T00:00:00Z", created_at: "2026-08-10T00:00:00Z",
          },
        ],
        // A ₹5,000 payment recorded against this visit (appointment_id set),
        // as recordPayment does when paying an appointment's balance.
        payments: [{ amount: 5000, appointment_id: "appt-1", treatment_id: null, patient_id: "p1", clinic_id: CLINIC_A }],
        clinic_settings: [
          { clinic_id: CLINIC_A, clinic_name: "Dr. Liying's Dental Care", address: "12 MG Road", phone: "0123456789", email: "clinic@example.com", registration_number: "REG-1", timezone: "Asia/Kolkata" },
        ],
        // What the column holds since the bucket went private: an object path.
        profiles: [
          { id: "d1", full_name: "Dr. Liying", signature_url: `${CLINIC_A}/d1/signature.png` },
        ],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getStaffBill("appt-1");
    expect(result.error).toBeNull();
    expect(result.data?.bill.total).toBe(8700); // 8000 + 300 + 400
    expect(result.data?.bill.paid).toBe(5000);
    expect(result.data?.bill.balanceDue).toBe(3700);
    expect(result.data?.bill.status).toBe("partial");
    // Signed, not passed through: a private-bucket path is unusable in an
    // <img> and would render as a broken signature on the invoice.
    expect(result.data?.dentist.signatureUrl).toBe(
      `https://signed.example/dentist-signatures/${CLINIC_A}/d1/signature.png?exp=3600`
    );
    expect(result.data?.clinic.name).toBe("Dr. Liying's Dental Care");
  });

  it("shows a null signature when the dentist has none configured", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        appointments: [
          { id: "appt-1", clinic_id: CLINIC_A, patient_id: "p1", dentist_id: "d1", scheduled_at: "2026-08-10T09:00:00Z" },
        ],
        patients: [{ id: "p1", clinic_id: CLINIC_A, name: "Asha Menon", phone: null }],
        treatments: [],
        payments: [],
        clinic_settings: [{ clinic_id: CLINIC_A, clinic_name: "Clinic", timezone: "Asia/Kolkata" }],
        profiles: [{ id: "d1", full_name: "Dr. Liying", signature_url: null }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getStaffBill("appt-1");
    expect(result.data?.dentist.signatureUrl).toBeNull();
    expect(result.data?.bill.status).toBe("no_charge");
  });

  it("scopes to a single treatment when treatmentId is passed", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        appointments: [
          { id: "appt-1", clinic_id: CLINIC_A, patient_id: "p1", dentist_id: "d1", scheduled_at: "2026-08-10T09:00:00Z" },
        ],
        patients: [{ id: "p1", clinic_id: CLINIC_A, name: "Asha Menon", phone: null }],
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 8000, status: "completed", performed_at: "2026-08-10T00:00:00Z", created_at: "2026-08-10T00:00:00Z" },
          { id: "t2", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Crown", cost: 5000, status: "completed", performed_at: "2026-08-10T00:00:00Z", created_at: "2026-08-10T00:00:00Z" },
        ],
        payments: [],
        clinic_settings: [{ clinic_id: CLINIC_A, clinic_name: "Clinic", timezone: "Asia/Kolkata" }],
        profiles: [{ id: "d1", full_name: "Dr. Liying", signature_url: null }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getStaffBill("appt-1", "t2");
    expect(result.error).toBeNull();
    expect(result.data?.bill.total).toBe(5000);
    expect(result.data?.bill.lineItems).toHaveLength(1);
    expect(result.data?.bill.lineItems[0].treatmentId).toBe("t2");
  });

  it("a treatmentId that doesn't belong to this visit returns an error, not another visit's data", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        appointments: [
          { id: "appt-1", clinic_id: CLINIC_A, patient_id: "p1", dentist_id: "d1", scheduled_at: "2026-08-10T09:00:00Z" },
        ],
        patients: [{ id: "p1", clinic_id: CLINIC_A, name: "Asha Menon", phone: null }],
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 8000, status: "completed" },
        ],
        payments: [],
        clinic_settings: [{ clinic_id: CLINIC_A, clinic_name: "Clinic", timezone: "Asia/Kolkata" }],
        profiles: [{ id: "d1", full_name: "Dr. Liying", signature_url: null }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getStaffBill("appt-1", "does-not-exist");
    expect(result.data).toBeNull();
    expect(result.error).toBe("Treatment not found on this visit.");
  });
});

describe("getPatientBillsList", () => {
  it("is forbidden for the patient role", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({}),
      profile: { id: "u1", clinic_id: CLINIC_A, role: "patient" },
    });
    const result = await getPatientBillsList("p1");
    expect(result.error).toBe("Forbidden");
  });
});

describe("Patient portal billing — patient isolation", () => {
  it("getPortalTreatmentBill never returns another patient's treatment (same error either way)", async () => {
    (createServerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGenericDb({
        patient_portal_links: [
          { user_id: "portal-user-1", patient_id: "p1", patients: { clinic_id: CLINIC_A } },
        ],
        // The requested treatment belongs to a DIFFERENT patient (p2), even
        // though it exists in the same clinic.
        treatments: [
          { id: "t-other", patient_id: "p2", appointment_id: "appt-x", clinic_id: CLINIC_A, treatment_type: "Crown", cost: 5000, status: "completed" },
        ],
      })
    );

    const result = await getPortalTreatmentBill("t-other");
    expect(result.data).toBeNull();
    expect(result.error).toBe("Bill not found.");
  });

  it("getPortalTreatmentBill returns the same 'not found' for a nonexistent id as for someone else's — never confirms existence", async () => {
    (createServerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGenericDb({
        patient_portal_links: [
          { user_id: "portal-user-1", patient_id: "p1", patients: { clinic_id: CLINIC_A } },
        ],
        treatments: [],
      })
    );

    const result = await getPortalTreatmentBill("does-not-exist");
    expect(result.error).toBe("Bill not found.");
  });

  it("getPortalTreatmentBill returns the caller's OWN treatment bill", async () => {
    (createServerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGenericDb({
        patient_portal_links: [
          { user_id: "portal-user-1", patient_id: "p1", patients: { clinic_id: CLINIC_A } },
        ],
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Cleaning", cost: 2000, status: "completed", performed_at: "2026-08-10T00:00:00Z", created_at: "2026-08-10T00:00:00Z" },
        ],
        payments: [{ amount: 2000, treatment_id: "t1", patient_id: "p1", clinic_id: CLINIC_A }],
        appointments: [
          { id: "appt-1", patient_id: "p1", clinic_id: CLINIC_A, dentist_id: "d1", scheduled_at: "2026-08-10T09:00:00Z" },
        ],
        patients: [{ id: "p1", name: "Asha Menon", phone: "9876543210" }],
        clinic_settings: [{ clinic_id: CLINIC_A, clinic_name: "Clinic", timezone: "Asia/Kolkata" }],
        profiles: [{ id: "d1", full_name: "Dr. Liying", signature_url: null }],
      })
    );

    const result = await getPortalTreatmentBill("t1");
    expect(result.error).toBeNull();
    expect(result.data?.bill.total).toBe(2000);
    expect(result.data?.bill.status).toBe("paid");
    expect(result.data?.patient.id).toBe("p1");
  });

  it("getPortalBillsList never trusts a patient id from anywhere but the session", async () => {
    (createServerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGenericDb({
        patient_portal_links: [
          { user_id: "portal-user-1", patient_id: "p1", patients: { clinic_id: CLINIC_A } },
        ],
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Cleaning", cost: 2000, status: "completed", performed_at: "2026-08-10T00:00:00Z", created_at: "2026-08-10T00:00:00Z" },
          // A treatment for a different patient in the SAME clinic must never
          // appear — getPortalBillsList takes no id argument at all.
          { id: "t-other", patient_id: "p2", appointment_id: "appt-2", clinic_id: CLINIC_A, treatment_type: "Extraction", cost: 3000, status: "completed" },
        ],
        payments: [],
      })
    );

    const result = await getPortalBillsList();
    expect(result.error).toBeNull();
    expect(result.data?.map((b) => b.treatmentId)).toEqual(["t1"]);
  });

  it("returns Unauthorized when there is no portal session", async () => {
    (createServerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: () => ({}),
      auth: { getUser: async () => ({ data: { user: null } }) },
    });

    const result = await getPortalBillsList();
    expect(result.data).toBeNull();
    expect(result.error).toBe("Unauthorized");
  });
});

describe("getClinicBillsList", () => {
  it("is forbidden for the patient role", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({}),
      profile: { id: "u1", clinic_id: CLINIC_A, role: "patient" },
    });
    const result = await getClinicBillsList();
    expect(result.data).toBeNull();
    expect(result.error).toBe("Forbidden");
  });

  it("clinic isolation: never includes another clinic's appointments", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          { id: "t-a", patient_id: "p1", appointment_id: "appt-a", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 8000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
          // Same shape, but a DIFFERENT clinic — must never appear for CLINIC_A.
          { id: "t-b", patient_id: "p2", appointment_id: "appt-b", clinic_id: CLINIC_B, treatment_type: "Crown", cost: 6000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
        ],
        payments: [],
        appointments: [
          { id: "appt-a", patient_id: "p1", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_A },
          { id: "appt-b", patient_id: "p2", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_B },
        ],
        patients: [
          { id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A },
          { id: "p2", name: "Kriti", phone: "9990000002", clinic_id: CLINIC_B },
        ],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getClinicBillsList();
    expect(result.error).toBeNull();
    expect(result.data?.bills.map((b) => b.appointmentId)).toEqual(["appt-a"]);
    expect(result.data?.bills[0].patientName).toBe("Hardik");
  });

  it("shows multiple appointments for the SAME patient as separate rows, including historical ones", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          // Older, historical appointment.
          { id: "t-old", patient_id: "p1", appointment_id: "appt-old", clinic_id: CLINIC_A, treatment_type: "Cleaning", cost: 1000, status: "completed", performed_at: "2025-01-10T00:00:00Z", created_at: "2025-01-10T00:00:00Z" },
          // Recent appointment.
          { id: "t-new", patient_id: "p1", appointment_id: "appt-new", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 9000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
        ],
        payments: [
          { amount: 1000, treatment_id: "t-old", appointment_id: "appt-old", patient_id: "p1", clinic_id: CLINIC_A },
          { amount: 4000, treatment_id: "t-new", appointment_id: "appt-new", patient_id: "p1", clinic_id: CLINIC_A },
        ],
        appointments: [
          { id: "appt-old", patient_id: "p1", scheduled_at: "2025-01-10T09:00:00Z", clinic_id: CLINIC_A },
          { id: "appt-new", patient_id: "p1", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [{ id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getClinicBillsList();
    expect(result.error).toBeNull();
    expect(result.data?.total).toBe(2);
    // Newest first.
    expect(result.data?.bills.map((b) => b.appointmentId)).toEqual(["appt-new", "appt-old"]);
    const oldBill = result.data?.bills.find((b) => b.appointmentId === "appt-old");
    expect(oldBill).toMatchObject({ total: 1000, paid: 1000, balanceDue: 0, status: "paid" });
    const newBill = result.data?.bills.find((b) => b.appointmentId === "appt-new");
    expect(newBill).toMatchObject({ total: 9000, paid: 4000, balanceDue: 5000, status: "partial" });
  });

  it("includes an appointment paid entirely via an unlinked payment, even with no treatment row", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [],
        payments: [
          { amount: 300, treatment_id: null, appointment_id: "appt-opd", patient_id: "p1", clinic_id: CLINIC_A },
        ],
        appointments: [
          { id: "appt-opd", patient_id: "p1", scheduled_at: "2026-08-10T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [{ id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getClinicBillsList();
    expect(result.data?.bills).toHaveLength(1);
    expect(result.data?.bills[0]).toMatchObject({
      appointmentId: "appt-opd",
      total: 0,
      paid: 300,
      balanceDue: 0,
      treatmentDescription: "Payment",
    });
  });

  it("excludes an appointment with treatments but no charge and no payment", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-planned", clinic_id: CLINIC_A, treatment_type: "Consult (planned)", cost: 5000, status: "planned", performed_at: null, created_at: "2026-08-01T00:00:00Z" },
        ],
        payments: [],
        appointments: [
          { id: "appt-planned", patient_id: "p1", scheduled_at: "2026-08-01T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [{ id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getClinicBillsList();
    expect(result.data?.bills).toEqual([]);
  });

  it("attributes each payment to its OWN appointment — a bill reflects the money paid on that visit, no cross-appointment pooling", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          { id: "A", patient_id: "p1", appointment_id: "appt-A", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 10000, status: "completed", performed_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z" },
          { id: "B", patient_id: "p1", appointment_id: "appt-B", clinic_id: CLINIC_A, treatment_type: "Crown", cost: 5000, status: "completed", performed_at: "2026-08-05T00:00:00Z", created_at: "2026-08-05T00:00:00Z" },
        ],
        // Money paid ON each visit: fully against appt-A, partially against appt-B.
        // These are the real appointment_id/treatment_id links recordPayment writes.
        payments: [
          { amount: 10000, treatment_id: "A", appointment_id: "appt-A", patient_id: "p1", clinic_id: CLINIC_A },
          { amount: 2000, treatment_id: "B", appointment_id: "appt-B", patient_id: "p1", clinic_id: CLINIC_A },
        ],
        appointments: [
          { id: "appt-A", patient_id: "p1", scheduled_at: "2026-08-01T09:00:00Z", clinic_id: CLINIC_A },
          { id: "appt-B", patient_id: "p1", scheduled_at: "2026-08-05T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [{ id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getClinicBillsList();
    const billA = result.data?.bills.find((b) => b.appointmentId === "appt-A");
    const billB = result.data?.bills.find((b) => b.appointmentId === "appt-B");
    expect(billA).toMatchObject({ total: 10000, paid: 10000, balanceDue: 0 });
    expect(billB).toMatchObject({ total: 5000, paid: 2000, balanceDue: 3000 });
  });

  it("REGRESSION: an appointment-scoped payment is counted ONCE (list Paid matches the true amount, not the doubled ₹9,200)", async () => {
    // The exact reported case: ₹8,000 visit, ₹6,200 treatment payment +
    // ₹1,500 appointment-scoped payment = ₹7,700 truly paid. The old list
    // double-counted the ₹1,500 (pool + unassigned) → ₹9,200 / balance ₹0.
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 8000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
        ],
        payments: [
          { amount: 6200, treatment_id: "t1", appointment_id: "appt-1", patient_id: "p1", clinic_id: CLINIC_A },
          { amount: 1500, treatment_id: null, appointment_id: "appt-1", patient_id: "p1", clinic_id: CLINIC_A },
        ],
        appointments: [
          { id: "appt-1", patient_id: "p1", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [{ id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const list = await getClinicBillsList();
    const listRow = list.data?.bills.find((b) => b.appointmentId === "appt-1");
    expect(listRow).toMatchObject({ total: 8000, paid: 7700, balanceDue: 300, overpayment: 0 });

    // And the individual bill detail for the same appointment MUST agree.
    const detail = await getStaffBill("appt-1");
    expect(detail.data?.bill).toMatchObject({ total: 8000, paid: 7700, balanceDue: 300 });
  });

  it("REGRESSION: genuine overpayment (paid ₹9,200 on ₹8,000) shows balance ₹0 and credit ₹1,200 — list and detail agree", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 8000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
        ],
        payments: [
          { amount: 7700, treatment_id: "t1", appointment_id: "appt-1", patient_id: "p1", clinic_id: CLINIC_A },
          { amount: 1500, treatment_id: null, appointment_id: "appt-1", patient_id: "p1", clinic_id: CLINIC_A },
        ],
        appointments: [
          { id: "appt-1", patient_id: "p1", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [{ id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A }],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const list = await getClinicBillsList();
    const listRow = list.data?.bills.find((b) => b.appointmentId === "appt-1");
    expect(listRow).toMatchObject({ total: 8000, paid: 9200, balanceDue: 0, overpayment: 1200 });

    const detail = await getStaffBill("appt-1");
    expect(detail.data?.bill).toMatchObject({ total: 8000, paid: 9200, balanceDue: 0, overpayment: 1200 });
  });

  it("search filters by patient name/phone", async () => {
    (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      db: makeGenericDb({
        treatments: [
          { id: "t1", patient_id: "p1", appointment_id: "appt-1", clinic_id: CLINIC_A, treatment_type: "Root Canal", cost: 8000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
          { id: "t2", patient_id: "p2", appointment_id: "appt-2", clinic_id: CLINIC_A, treatment_type: "Crown", cost: 6000, status: "completed", performed_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" },
        ],
        payments: [],
        appointments: [
          { id: "appt-1", patient_id: "p1", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_A },
          { id: "appt-2", patient_id: "p2", scheduled_at: "2026-08-14T09:00:00Z", clinic_id: CLINIC_A },
        ],
        patients: [
          { id: "p1", name: "Hardik", phone: "9990000001", clinic_id: CLINIC_A },
          { id: "p2", name: "Kriti", phone: "9990000002", clinic_id: CLINIC_A },
        ],
      }),
      profile: { id: "staff-1", clinic_id: CLINIC_A, role: "dentist" },
    });

    const result = await getClinicBillsList({ search: "kriti" });
    expect(result.data?.bills.map((b) => b.patientName)).toEqual(["Kriti"]);
  });
});
