/**
 * The clinic ledger graph, over literal slices.
 *
 * What these specs defend is not that a lookup returns a row — any Map does
 * that — but that the graph never lets an absence read as an answer:
 *
 *   - a complete slice says "none" with confidence (`known`, empty)
 *   - a partial slice — wrong scope, truncated read, row not live — says it
 *     cannot see (`outside_slice`), never "none"
 *   - a relationship OraMedha has nowhere to record says so by name
 *     (`not_recorded`), before any data is consulted
 *
 * and that a slice which crosses tenants, or carries a deleted patient's rows,
 * is refused outright rather than joined.
 */

import { describe, expect, it } from "vitest";

import { LedgerFactKind } from "../ledger-facts";
import { buildLedgerGraph, LedgerIntegrityError, type Traversal } from "../ledger-graph";
import { LEDGER_CAPABILITIES } from "../ledger-capabilities";
import {
  appointments,
  CLINIC,
  OTHER_CLINIC,
  P1,
  P2,
  patients,
  payments,
  queueVisits,
  slice,
  windowScope,
} from "./ledger-fixtures";

function value<T>(t: Traversal<T>): T {
  if (t.status !== "known") throw new Error(`expected known, got ${t.status}`);
  return t.value;
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe("walking one patient's whole chain", () => {
  const graph = buildLedgerGraph(slice());

  it("patient → appointments, in scheduled order", () => {
    expect(ids(value(graph.appointmentsOfPatient(P1)))).toEqual(["A1", "A2"]);
  });

  it("appointment → queue visit, with the recorded timings", () => {
    const visit = value(graph.queueVisitForAppointment("A1"));
    expect(visit?.id).toBe("Q1");
    expect(visit?.calledAt).toBe("2026-05-12T04:05:00.000Z");
    expect(visit?.completedAt).toBe("2026-05-12T04:50:00.000Z");
  });

  it("appointment → treatments recorded at it", () => {
    expect(ids(value(graph.treatmentsRecordedAtAppointment("A1")))).toEqual(["T1", "T2"]);
  });

  it("treatment → payment linked to it", () => {
    expect(ids(value(graph.paymentsLinkedToTreatment("T1")))).toEqual(["PAY1"]);
  });

  it("treatment → follow-up it raised → appointment booked from that follow-up", () => {
    expect(ids(value(graph.followUpsRaisedByTreatment("T1")))).toEqual(["F1"]);
    expect(ids(value(graph.appointmentsBookedFromFollowUp("F1")))).toEqual(["A2"]);
    expect(value(graph.originFollowUpOfAppointment("A2"))?.id).toBe("F1");
  });

  it("patient → action completions that targeted them, once each", () => {
    expect(ids(value(graph.completionsTargetingPatient(P1)))).toEqual(["AC1"]);
    expect(value(graph.completionsTargetingPatient(P2))).toEqual([]);
  });

  it("treatment → the visit it was RECORDED at, which is not a booking", () => {
    // T2 is planned. Its recording visit is the past consultation; the visit that
    // will deliver it is unrecorded, and the graph must say so rather than
    // offering A1 as though it answered that question.
    expect(value(graph.recordingAppointmentOfTreatment("T2")).id).toBe("A1");
    expect(graph.bookingForPlannedTreatment("T2")).toMatchObject({
      status: "not_recorded",
      capability: LEDGER_CAPABILITIES.PLANNED_TREATMENT_BOOKING.key,
    });
  });
});

describe("known and empty really means none", () => {
  const graph = buildLedgerGraph(slice());

  it("reports a patient with no payments as known and empty in a complete slice", () => {
    expect(graph.paymentsOfPatient(P2)).toEqual({ status: "known", value: [] });
  });

  it("reports a visit nobody checked in as known null, not as a zero-minute visit", () => {
    expect(graph.queueVisitForAppointment("A3")).toEqual({ status: "known", value: null });
  });

  it("reports an appointment not booked from a follow-up as known null", () => {
    expect(graph.originFollowUpOfAppointment("A1")).toEqual({ status: "known", value: null });
  });
});

describe("a partial slice never answers 'none'", () => {
  it("declines every patient-level list from an appointment-window slice", () => {
    const graph = buildLedgerGraph(slice({ scope: windowScope() }));
    for (const t of [
      graph.appointmentsOfPatient(P1),
      graph.treatmentsOfPatient(P1),
      graph.queueVisitsOfPatient(P1),
      graph.followUpsOfPatient(P1),
      graph.paymentsOfPatient(P2),
      graph.reminderSendsToPatient(P1),
      graph.completionsTargetingPatient(P1),
    ]) {
      expect(t.status).toBe("outside_slice");
    }
    // A booked visit can fall outside any window.
    expect(graph.appointmentsBookedFromFollowUp("F1").status).toBe("outside_slice");
    // Appointment-level questions are still answerable: the window loads them.
    expect(value(graph.queueVisitForAppointment("A1"))?.id).toBe("Q1");
  });

  it("declines a truncated kind and still answers the kinds read in full", () => {
    const graph = buildLedgerGraph(
      slice({ truncated: [LedgerFactKind.PAYMENT], payments: [] }),
    );
    expect(graph.paymentsOfPatient(P1).status).toBe("outside_slice");
    expect(graph.paymentsLinkedToTreatment("T1").status).toBe("outside_slice");
    expect(ids(value(graph.appointmentsOfPatient(P1)))).toEqual(["A1", "A2"]);
  });

  it("declines a kind the session did not read, instead of calling it empty", () => {
    // RLS returns zero rows for a table a session may not read. A receptionist's
    // slice marks completions withheld, and "no action targeted this patient"
    // must not be the answer.
    const graph = buildLedgerGraph(
      slice({ withheld: [LedgerFactKind.ACTION_COMPLETION], actionCompletions: [] }),
    );
    const t = graph.completionsTargetingPatient(P1);
    expect(t.status).toBe("outside_slice");
    if (t.status === "outside_slice") expect(t.reason).toContain("not read by this session");
    expect(ids(value(graph.paymentsOfPatient(P1)))).toEqual(["PAY1"]);
  });

  it("declines follow-up bookings when the appointment read was cut", () => {
    const graph = buildLedgerGraph(slice({ truncated: [LedgerFactKind.APPOINTMENT] }));
    expect(graph.appointmentsBookedFromFollowUp("F1").status).toBe("outside_slice");
    expect(graph.appointmentsOfPatient(P1).status).toBe("outside_slice");
  });

  it("declines a patient who is not live in the slice rather than calling their history empty", () => {
    const graph = buildLedgerGraph(slice({ unresolvedPatientIds: ["p_deleted"] }));
    expect(graph.appointmentsOfPatient("p_deleted").status).toBe("outside_slice");
    expect(graph.paymentsOfPatient("p_deleted").status).toBe("outside_slice");
  });

  it("declines a forward link to a row the slice does not hold", () => {
    // A1 soft-deleted: the treatment recorded at it survives, its visit does not.
    const graph = buildLedgerGraph(
      slice({
        appointments: appointments.filter((a) => a.id !== "A1"),
        queueVisits: [],
      }),
    );
    expect(graph.recordingAppointmentOfTreatment("T1").status).toBe("outside_slice");
    expect(graph.queueVisitForAppointment("A1").status).toBe("outside_slice");
  });
});

describe("what OraMedha does not record", () => {
  const graph = buildLedgerGraph(slice());

  it.each([
    ["bookingForPlannedTreatment", () => graph.bookingForPlannedTreatment("T2"), "planned_treatment_booking"],
    ["planOfTreatment", () => graph.planOfTreatment("T1"), "treatment_plan"],
    ["followUpCompletedAt", () => graph.followUpCompletedAt("F1"), "follow_up_completion_time"],
    ["contactOutcomeOfReminder", () => graph.contactOutcomeOfReminder("R1"), "contact_outcome"],
  ] as const)("%s is not_recorded, naming its capability", (_name, call, capability) => {
    const t = call();
    expect(t.status).toBe("not_recorded");
    if (t.status === "not_recorded") {
      expect(t.capability).toBe(capability);
      expect(t.reason.length).toBeGreaterThan(20);
    }
  });

  it("never turns an unrecorded relationship into known, even for an empty slice", () => {
    const empty = buildLedgerGraph(
      slice({
        patients: [],
        appointments: [],
        appointmentEvents: [],
        treatments: [],
        treatmentEvents: [],
        queueVisits: [],
        followUps: [],
        payments: [],
        reminderSends: [],
        actionCompletions: [],
      }),
    );
    expect(empty.bookingForPlannedTreatment("T2").status).toBe("not_recorded");
    expect(empty.planOfTreatment("T2").status).toBe("not_recorded");
  });
});

describe("integrity: the graph refuses slices it must not reason over", () => {
  it("refuses a fact from another clinic", () => {
    expect(() =>
      buildLedgerGraph(slice({ payments: [...payments, { ...payments[0], id: "FOREIGN", clinicId: OTHER_CLINIC }] })),
    ).toThrow(LedgerIntegrityError);
  });

  it("refuses a kind marked withheld that nonetheless carries rows", () => {
    expect(() => buildLedgerGraph(slice({ withheld: [LedgerFactKind.PAYMENT] }))).toThrow(LedgerIntegrityError);
  });

  it("refuses a slice whose clinic does not match its scope", () => {
    expect(() => buildLedgerGraph(slice({ clinicId: OTHER_CLINIC }))).toThrow(LedgerIntegrityError);
  });

  it("refuses an appointment event whose appointment is not in the slice", () => {
    // appointment_history has no clinic_id; an event is only as tenant-safe as
    // the appointment it hangs from.
    expect(() =>
      buildLedgerGraph(slice({ appointments: appointments.filter((a) => a.id !== "A3") })),
    ).toThrow(LedgerIntegrityError);
  });

  it("refuses, in a patient scope, rows belonging to a patient who is not live", () => {
    expect(() =>
      buildLedgerGraph(slice({ patients: patients.filter((p) => p.id !== P1) })),
    ).toThrow(LedgerIntegrityError);
  });

  it("does not require patient liveness in a window scope, where patients are loaded by reference", () => {
    // Integrity there is the adapter's job (it drops appointments of non-live
    // patients); the graph still answers patient lookups as outside_slice.
    const graph = buildLedgerGraph(
      slice({ scope: windowScope(), patients: patients.filter((p) => p.id !== P2) }),
    );
    expect(graph.patientOfAppointment("A3").status).toBe("outside_slice");
  });
});

describe("purity", () => {
  it("does not mutate the slice it indexes", () => {
    const frozen = slice({
      appointments: Object.freeze([...appointments].reverse()) as never,
      queueVisits: Object.freeze([...queueVisits]) as never,
    });
    const graph = buildLedgerGraph(Object.freeze(frozen));
    expect(ids(value(graph.appointmentsOfPatient(P1)))).toEqual(["A1", "A2"]);
    expect(ids(frozen.appointments)).toEqual(["A3", "A2", "A1"]);
  });

  it("answers identically for the same slice", () => {
    const a = buildLedgerGraph(slice());
    const b = buildLedgerGraph(slice());
    expect(a.appointmentsOfPatient(P1)).toEqual(b.appointmentsOfPatient(P1));
    expect(a.eventsForAppointment("A3")).toEqual(b.eventsForAppointment("A3"));
    expect(a.eventsForTreatment("T2")).toEqual(b.eventsForTreatment("T2"));
    expect(a.slice.clinicId).toBe(CLINIC);
  });
});
