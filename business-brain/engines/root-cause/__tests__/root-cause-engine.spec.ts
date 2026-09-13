/**
 * The Root-Cause Engine: where a detected problem is concentrated, and when the
 * data cannot say.
 *
 * Every scenario is a literal appointment book, so each expected rate, median
 * and sample size can be counted by hand from the fixture.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory, RootCauseDimension } from "../../../domain";
import { LedgerIntegrityError, type AppointmentFact } from "../../../ledger";
import { RootCauseIntegrityError } from "../root-cause-engine";
import {
  allText,
  appt,
  book,
  capacityWindow,
  CLINIC,
  DATE,
  dayOfWeek,
  explain,
  NOW,
  one,
  OTHER,
  PARENT,
  subject,
  treatmentAt,
  visit,
  weekdays,
} from "./root-cause-fixtures";

const S = ConstraintCategory.SCHEDULING;
const CAUSAL = /\bcaused by\b|\bbecause of\b|\bwill cause\b|\bdue to\b|\bleads? to\b|\bresults? in\b/i;

// ── attrition scenarios ─────────────────────────────────────────────────────

/** 60 morning visits (2 cancelled) and 20 evening ones (12 cancelled). */
function eveningCancellations(): AppointmentFact[] {
  const out: AppointmentFact[] = [];
  let eveningIndex = 0;
  weekdays().forEach((d, i) => {
    ["09:00", "09:30", "10:00"].forEach((t, j) => {
      out.push(appt(`m${i}_${j}`, d, t, (i === 3 && j === 0) || (i === 11 && j === 2) ? "cancelled" : "completed"));
    });
    out.push(appt(`e${i}`, d, "18:00", eveningIndex++ < 12 ? "cancelled" : "completed"));
  });
  return out;
}

/** Cancellations concentrated on Mondays and, separately, in same-day bookings on other days. */
function twoSeparateConcentrations(): AppointmentFact[] {
  const out: AppointmentFact[] = [];
  let mondayCancels = 0;
  let sameDayCancels = 0;
  weekdays().forEach((d, i) => {
    const monday = dayOfWeek(d) === 1;
    ["09:00", "09:30", "10:00", "10:30"].forEach((t, j) => {
      const sameDay = !monday && j === 3;
      const cancelled = monday ? mondayCancels++ % 2 === 0 : sameDay ? sameDayCancels++ % 2 === 0 : false;
      const a = appt(`a${i}_${j}`, d, t, cancelled ? "cancelled" : "completed");
      out.push(sameDay ? { ...a, bookedAt: new Date(Date.parse(a.scheduledAt) - 2 * 3_600_000).toISOString() } : a);
    });
  });
  return out;
}

describe("attrition: sufficient evidence", () => {
  const analysis = one({ subjects: [subject(S)], schedule: book({ appointments: eveningCancellations() }) });

  it("locates the concentration, with both groups, their sizes and the gap", () => {
    expect(analysis.outcome).toBe("explained");
    expect(analysis.parentFindingId).toBe(PARENT[S]);
    expect(analysis.population).toMatchObject({ n: 80, events: 14 });
    expect(analysis.associations).toHaveLength(1);
    const [evening] = analysis.associations;
    expect(evening.dimension).toBe(RootCauseDimension.SESSION);
    expect(evening.group).toMatchObject({ label: "Evening (17:00 onwards)", n: 20, events: 12, rate: 60 });
    expect(evening.comparison).toMatchObject({ label: "All other appointments", n: 60, events: 2, rate: 3.3 });
    expect(evening.gap).toBe(56.7);
    expect(evening.ratio).toBe(18);
    expect(evening.shareOfEvents).toBe(85.7);
    expect(evening.shareOfPopulation).toBe(25);
    expect(evening.statement).toBe(
      "Lost appointments are concentrated in evening appointments (17:00 onwards): 60% (12 of 20) versus 3.3% (2 of 60) across all other appointments in the last 30 days.",
    );
    expect(analysis.statement).toBe(evening.statement);
    expect(analysis.competing).toBe(false);
  });

  it("reports every dimension it looked at, including those with nothing to say", () => {
    const status = Object.fromEntries(analysis.dimensions.map((d) => [d.dimension, d.status]));
    expect(status).toEqual({
      [RootCauseDimension.DAY_OF_WEEK]: "no_meaningful_difference",
      [RootCauseDimension.SESSION]: "association_found",
      [RootCauseDimension.BOOKED_DURATION]: "no_variation",
      [RootCauseDimension.BOOKING_LEAD_TIME]: "no_variation",
      [RootCauseDimension.BOOKING_ORIGIN]: "no_variation",
    });
    expect(analysis.dimensions.every((d) => d.coverage === 1)).toBe(true);
  });

  it("uses association wording only", () => {
    for (const text of allText(analysis)) expect(text).not.toMatch(CAUSAL);
    expect(analysis.limitations.join(" ")).toMatch(/not causes/);
  });

  it("names no patient", () => {
    const json = JSON.stringify(analysis);
    expect(json).not.toMatch(/p_[a-z]\d/);
    expect(json).not.toContain("patientId");
  });

  it("focuses on cancellations or no-shows when the parent is about one of them", () => {
    const noShows = one({ subjects: [subject(S, "no_show")], schedule: book({ appointments: eveningCancellations() }) });
    expect(noShows.outcome).toBe("insufficient_evidence");
    expect(noShows.statement).toMatch(/^Insufficient evidence to explain where this is concentrated: only 0 missed appointments/);
  });
});

describe("attrition: too little to say", () => {
  it("refuses a population of a dozen appointments", () => {
    const appointments = weekdays().slice(0, 12).map((d, i) => appt(`a${i}`, d, "18:00", i < 8 ? "cancelled" : "completed"));
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    expect(analysis.outcome).toBe("insufficient_evidence");
    expect(analysis.associations).toEqual([]);
    expect(analysis.confidence).toBe(0.05);
    expect(analysis.statement).toBe(
      "Insufficient evidence to explain where this is concentrated: only 12 appointments with a recorded outcome in the last 30 days (at least 30 are needed).",
    );
  });

  it("refuses to locate three lost appointments", () => {
    const appointments = weekdays().flatMap((d, i) => [appt(`a${i}`, d, "09:00", i < 3 ? "cancelled" : "completed"), appt(`b${i}`, d, "10:00")]);
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    expect(analysis.outcome).toBe("insufficient_evidence");
    expect(analysis.statement).toMatch(/only 3 lost appointments/);
  });

  it("does not turn one cancelled Saturday into a 100% concentration", () => {
    const appointments = weekdays().flatMap((d, i) => [
      appt(`a${i}`, d, "09:00", i % 5 === 0 || i % 5 === 3 ? "cancelled" : "completed"),
      appt(`b${i}`, d, "10:00"),
    ]);
    appointments.push(appt("sat", "2026-09-05", "10:00", "cancelled"));
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    expect(analysis.outcome).not.toBe("explained");
    const saturday = analysis.dimensions
      .find((d) => d.dimension === RootCauseDimension.DAY_OF_WEEK)
      ?.groups.find((g) => g.label === "Saturday");
    // Counted, never turned into a percentage.
    expect(saturday).toMatchObject({ n: 1, events: 1, rate: null });
    expect(analysis.associations).toEqual([]);
  });
});

describe("attrition: competing explanations", () => {
  it("keeps two separate concentrations as two, and says so", () => {
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments: twoSeparateConcentrations() }) });
    expect(analysis.outcome).toBe("explained");
    expect(analysis.competing).toBe(true);
    expect(analysis.associations.map((a) => [a.dimension, a.group.label]).sort()).toEqual([
      [RootCauseDimension.BOOKING_LEAD_TIME, "Booked the same day"],
      [RootCauseDimension.DAY_OF_WEEK, "Monday"],
    ]);
    for (const a of analysis.associations) {
      expect(a.group).toMatchObject({ n: 16, events: 8, rate: 50 });
      expect(a.comparison).toMatchObject({ n: 64, events: 8, rate: 12.5 });
      // Disjoint cancellations: not flagged as overlapping. Near the minimum: 0.9 − 0.15.
      expect(a.overlapsWith).toEqual([]);
      expect(a.confidence).toBe(0.75);
    }
    expect(analysis.statement).toMatch(/^More than one concentration fits the data, and each is kept: /);
    expect(analysis.limitations.join(" ")).toMatch(/cannot say which description fits best/);
  });

  it("flags two descriptions of largely the same appointments as overlapping", () => {
    // Evening appointments only on Mondays: "Monday" and "evening" describe the same cancellations.
    const appointments: AppointmentFact[] = [];
    weekdays().forEach((d, i) => {
      ["09:00", "09:30", "10:00"].forEach((t, j) => appointments.push(appt(`m${i}_${j}`, d, t, j === 0 && i % 4 === 1 ? "cancelled" : "completed")));
      if (dayOfWeek(d) === 1) {
        ["17:00", "17:30", "18:00"].forEach((t, j) => appointments.push(appt(`e${i}_${j}`, d, t, j < 2 ? "cancelled" : "completed")));
      }
    });
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    const byDimension = new Map(analysis.associations.map((a) => [a.dimension, a]));
    const monday = byDimension.get(RootCauseDimension.DAY_OF_WEEK);
    const evening = byDimension.get(RootCauseDimension.SESSION);
    expect(monday).toBeDefined();
    expect(evening).toBeDefined();
    expect(monday?.overlapsWith.map((o) => o.associationId)).toEqual([evening?.id]);
    expect(evening?.overlapsWith[0].sharedShare).toBe(1);
    expect(analysis.competing).toBe(true);
    expect(evening?.confidence).toBeLessThan(0.9);
  });
});

describe("attrition: flat differences", () => {
  it("finds no concentration when every group loses at the same rate", () => {
    const appointments: AppointmentFact[] = [];
    weekdays().forEach((d, i) => {
      ["09:00", "09:30", "10:00"].forEach((t, j) => appointments.push(appt(`m${i}_${j}`, d, t, j === 0 && i % 2 === 0 ? "cancelled" : "completed")));
      appointments.push(appt(`e${i}`, d, "18:00", i % 6 === 1 ? "cancelled" : "completed"));
    });
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    expect(analysis.outcome).toBe("no_concentration");
    expect(analysis.associations).toEqual([]);
    expect(analysis.dimensions.find((d) => d.dimension === RootCauseDimension.SESSION)?.status).toBe("no_meaningful_difference");
    expect(analysis.statement).toMatch(/^No concentration stands out: /);
    expect(analysis.confidence).toBe(0.6);
  });
});

describe("attrition: missing and future outcomes", () => {
  it("leaves out appointments with no recorded outcome, and says how many", () => {
    const appointments = [
      ...eveningCancellations(),
      appt("stale", "2026-09-10", "11:00", "scheduled"),
      appt("later", DATE, "23:30", "scheduled"),
      appt("tonight_done", DATE, "08:00", "completed"),
    ];
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    expect(analysis.population.n).toBe(81);
    expect(analysis.population.excluded).toEqual([
      { reason: "not yet happened", count: 1 },
      { reason: "outcome not recorded (still marked scheduled)", count: 1 },
    ]);
  });

  it("treats a back-dated booking's lead time as not recorded, not negative", () => {
    const appointments = eveningCancellations().map((a, i) => (i < 30 ? { ...a, bookedAt: new Date(Date.parse(a.scheduledAt) + 3_600_000).toISOString() } : a));
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    const lead = analysis.dimensions.find((d) => d.dimension === RootCauseDimension.BOOKING_LEAD_TIME);
    expect(lead?.status).toBe("not_recorded");
    expect(lead?.coverage).toBe(0.63);
  });

  it("refuses a truncated appointment book rather than analysing part of it", () => {
    const analysis = one({ subjects: [subject(S)], schedule: book({ appointments: eveningCancellations(), truncated: ["appointment"] }) });
    expect(analysis.outcome).toBe("insufficient_evidence");
    expect(analysis.statement).toMatch(/row limit/);
  });

  it("says why when the ledger could not be read at all", () => {
    const analysis = one({ subjects: [subject(S)], schedule: null, unavailableReason: "the clinic ledger could not be read for this run" });
    expect(analysis.outcome).toBe("insufficient_evidence");
    expect(analysis.statement).toBe("Insufficient evidence to explain where this is concentrated: the clinic ledger could not be read for this run.");
  });
});

// ── overrun ─────────────────────────────────────────────────────────────────

describe("overrun: treatment type and booked duration", () => {
  function treatmentMix() {
    const appointments: AppointmentFact[] = [];
    const queueVisits = [];
    const treatments = [];
    for (const [i, d] of weekdays().slice(0, 16).entries()) {
      for (const [j, t] of ["09:00", "14:00"].entries()) {
        const a = appt(`v${i}_${j}`, d, t);
        const rootCanal = (i + j) % 2 === 0;
        appointments.push(a);
        queueVisits.push(visit(a, { wait: 5, minutesInChair: rootCanal ? 55 : 30 }));
        treatments.push(treatmentAt(a, rootCanal ? (i % 3 === 0 ? " Root Canal " : "root canal") : "Cleaning"));
      }
    }
    return { appointments, queueVisits, treatments };
  }

  it("locates overruns in one recorded treatment type", () => {
    const analysis = one({ subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)], schedule: book(treatmentMix()) });
    expect(analysis.outcome).toBe("explained");
    expect(analysis.associations).toHaveLength(1);
    const [rc] = analysis.associations;
    expect(rc.dimension).toBe(RootCauseDimension.TREATMENT_TYPE);
    expect(rc.group).toMatchObject({ n: 16, unit: "visits", median: 25, lowerQuartile: 25, rate: null, events: null });
    expect(rc.comparison).toMatchObject({ n: 16, median: 0 });
    expect(rc.gap).toBe(25);
    expect(rc.gapUnit).toBe("minutes");
    expect(rc.statement).toBe(
      "Overruns are concentrated in root canal visits: a median of 25 minutes over the booked time (16 visits) versus 0 minutes (16 other visits).",
    );
  });

  it("leaves visits with several treatment types, or none recorded, out of that dimension only", () => {
    const mix = treatmentMix();
    const extra = mix.appointments.slice(0, 2).map((a) => treatmentAt(a, "X-ray", 1));
    const analysis = one({
      subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)],
      schedule: book({ ...mix, treatments: [...mix.treatments, ...extra] }),
    });
    const type = analysis.dimensions.find((d) => d.dimension === RootCauseDimension.TREATMENT_TYPE);
    expect(type?.coverage).toBe(0.94);
    expect(analysis.population.n).toBe(32);
  });

  it("locates overruns in short bookings when treatment types are not recorded", () => {
    const appointments: AppointmentFact[] = [];
    const queueVisits = [];
    for (const [i, d] of weekdays().slice(0, 16).entries()) {
      const short = appt(`s${i}`, d, i % 2 === 0 ? "09:00" : "14:00", "completed", { durationMinutes: 20 });
      const long = appt(`l${i}`, d, i % 2 === 0 ? "14:00" : "09:00", "completed", { durationMinutes: 45 });
      appointments.push(short, long);
      queueVisits.push(visit(short, { minutesInChair: 35 }), visit(long, { minutesInChair: 45 }));
    }
    const analysis = one({ subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)], schedule: book({ appointments, queueVisits }) });
    expect(analysis.dimensions.find((d) => d.dimension === RootCauseDimension.TREATMENT_TYPE)?.status).toBe("not_recorded");
    expect(analysis.associations.map((a) => [a.dimension, a.group.label])).toEqual([[RootCauseDimension.BOOKED_DURATION, "Booked up to 20 min"]]);
    expect(analysis.associations[0].gap).toBe(15);
  });

  it("does not let a few very long visits carry a group", () => {
    const appointments: AppointmentFact[] = [];
    const queueVisits = [];
    const treatments = [];
    for (const [i, d] of weekdays().slice(0, 16).entries()) {
      for (const [j, t] of ["09:00", "14:00"].entries()) {
        const a = appt(`v${i}_${j}`, d, t);
        const implant = j === 0;
        appointments.push(a);
        // Half the implant visits run 60 minutes over; the other half on time.
        queueVisits.push(visit(a, { minutesInChair: implant && i % 2 === 0 ? 90 : 30 }));
        treatments.push(treatmentAt(a, implant ? "Implant" : "Cleaning"));
      }
    }
    const analysis = one({ subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)], schedule: book({ appointments, queueVisits, treatments }) });
    expect(analysis.associations.filter((a) => a.dimension === RootCauseDimension.TREATMENT_TYPE)).toEqual([]);
  });

  it("keeps treatment type not recorded when treatments were withheld, and still analyses the rest", () => {
    const mix = treatmentMix();
    const analysis = one({
      subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)],
      schedule: book({ appointments: mix.appointments, queueVisits: mix.queueVisits, withheld: ["treatment"] }),
    });
    expect(analysis.dimensions.find((d) => d.dimension === RootCauseDimension.TREATMENT_TYPE)?.status).toBe("not_recorded");
    expect(analysis.outcome).toBe("no_concentration");
  });

  it("refuses to run when queue visits were withheld", () => {
    const mix = treatmentMix();
    const analysis = one({
      subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)],
      schedule: book({ appointments: mix.appointments, treatments: mix.treatments, withheld: ["queue_visit"] }),
    });
    expect(analysis.outcome).toBe("insufficient_evidence");
    expect(analysis.statement).toMatch(/queue visit records were withheld/);
  });

  it("counts attended visits without a finish time as excluded, not as zero minutes", () => {
    const mix = treatmentMix();
    const queueVisits = mix.queueVisits.map((q, i) => (i < 4 ? { ...q, completedAt: null } : q));
    const analysis = one({ subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)], schedule: book({ ...mix, queueVisits }) });
    expect(analysis.population.n).toBe(28);
    expect(analysis.population.excluded).toEqual([{ reason: "attended but call-in or finish not recorded", count: 4 }]);
  });
});

// ── waiting ─────────────────────────────────────────────────────────────────

describe("waiting: day density", () => {
  it("associates longer waits with busier days, stating the threshold", () => {
    const appointments: AppointmentFact[] = [];
    const queueVisits = [];
    for (const [i, d] of weekdays().slice(0, 10).entries()) {
      const busy = i < 5;
      for (let k = 0; k < (busy ? 5 : 2); k += 1) {
        const a = appt(`w${i}_${k}`, d, `0${9 + k}:00`.slice(-5));
        appointments.push(a);
        queueVisits.push(visit(a, { wait: busy ? 30 : 5, minutesInChair: 30 }));
      }
    }
    const analysis = one({ subjects: [subject(ConstraintCategory.PATIENT_FLOW)], schedule: book({ appointments, queueVisits }) });
    expect(analysis.population.n).toBe(35);
    expect(analysis.associations.map((a) => [a.dimension, a.group.label])).toEqual([
      [RootCauseDimension.DAY_DENSITY, "Days with more than 3 booked appointments"],
    ]);
    expect(analysis.associations[0].statement).toBe(
      "Longer waits are associated with days with more than 3 booked appointments: a median wait of 30 minutes (25 visits) versus 5 minutes (10 other visits).",
    );
  });

  it("associates longer waits with patients arriving early, by check-in against booked time", () => {
    const appointments: AppointmentFact[] = [];
    const queueVisits = [];
    for (const [i, d] of weekdays().entries()) {
      const a = appt(`e${i}`, d, "10:00");
      const b = appt(`o${i}`, d, "11:00");
      appointments.push(a, b);
      queueVisits.push(visit(a, { arriveOffset: -30, wait: 40, minutesInChair: 30 }), visit(b, { arriveOffset: 0, wait: 5, minutesInChair: 30 }));
    }
    const analysis = one({ subjects: [subject(ConstraintCategory.PATIENT_FLOW)], schedule: book({ appointments, queueVisits }) });
    expect(analysis.associations.map((a) => a.group.label)).toEqual(["Arrived more than 10 min early"]);
  });
});

// ── idle capacity ───────────────────────────────────────────────────────────

describe("idle capacity: day of week", () => {
  function fridaysQuiet() {
    const appointments: AppointmentFact[] = [];
    for (const [i, d] of weekdays().entries()) {
      const friday = dayOfWeek(d) === 5;
      const count = friday ? 2 : 4;
      for (let k = 0; k < count; k += 1) {
        appointments.push(appt(`c${i}_${k}`, d, ["09:00", "09:40", "10:20", "11:00"][k], "completed", { durationMinutes: friday ? 30 : 40 }));
      }
    }
    return appointments;
  }

  it("locates unused chair time on Fridays, per day rather than pooled", () => {
    const analysis = one({
      subjects: [subject(ConstraintCategory.CAPACITY)],
      schedule: book({ appointments: fridaysQuiet() }),
      capacity: capacityWindow(),
    });
    expect(analysis.outcome).toBe("explained");
    expect(analysis.population.n).toBe(20);
    expect(analysis.associations).toHaveLength(1);
    const [friday] = analysis.associations;
    expect(friday.group).toMatchObject({ label: "Friday", n: 4, unit: "days", median: 33.3 });
    expect(friday.comparison).toMatchObject({ n: 16, median: 88.9 });
    expect(friday.gap).toBe(-55.6);
    expect(friday.statement).toBe(
      "Unused chair time is concentrated in Fridays: a median of 33.3% of chair time booked across 4 days versus 88.9% across 16 other days.",
    );
    expect(analysis.dimensions.find((d) => d.dimension === RootCauseDimension.SESSION)?.status).toBe("no_variation");
  });

  it("does not count days without published capacity as empty days", () => {
    const missing = new Set(["2026-08-17", "2026-08-18", "2026-08-19"]);
    const capacity = capacityWindow();
    const analysis = one({
      subjects: [subject(ConstraintCategory.CAPACITY)],
      schedule: book({ appointments: fridaysQuiet() }),
      capacity: { ...capacity, days: capacity.days.filter((d) => !missing.has(d.date)) },
    });
    expect(analysis.population.n).toBe(17);
    expect(analysis.associations[0].comparison.n).toBe(13);
  });

  it("is insufficient without capacity, and without availability rules", () => {
    const schedule = book({ appointments: fridaysQuiet() });
    expect(one({ subjects: [subject(ConstraintCategory.CAPACITY)], schedule, capacity: null }).outcome).toBe("insufficient_evidence");
    const unconfigured = one({ subjects: [subject(ConstraintCategory.CAPACITY)], schedule, capacity: { ...capacityWindow(), availabilityConfigured: false } });
    expect(unconfigured.statement).toMatch(/no active availability rules/);
  });
});

// ── clinic-local time ───────────────────────────────────────────────────────

describe("clinic-local time", () => {
  it("reads day and session in the clinic's timezone, not UTC", () => {
    // 12:30 UTC is 18:00 in Kolkata: the evening concentration only exists locally.
    const appointments = eveningCancellations().map((a) =>
      a.id.startsWith("e") ? { ...a, scheduledAt: a.scheduledAt.replace("T18:00", "T12:30") } : a,
    );
    const utc = one({ subjects: [subject(S)], schedule: book({ appointments }) });
    const local = one({ subjects: [subject(S)], schedule: book({ appointments }), timezone: "Asia/Kolkata" });
    expect(utc.associations.map((a) => a.group.label)).toEqual(["Afternoon (12:00–16:59)"]);
    expect(local.associations.map((a) => a.group.label)).toEqual(["Evening (17:00 onwards)"]);
  });
});

// ── isolation, determinism, subjects ────────────────────────────────────────

describe("isolation and determinism", () => {
  it("refuses a schedule or capacity belonging to another clinic", () => {
    const foreign = book({ clinicId: OTHER, scope: { kind: "appointment_window", clinicId: OTHER, from: DATE, to: DATE, asOf: NOW, limit: 10 } });
    expect(() => explain({ subjects: [subject(S)], schedule: foreign })).toThrow(RootCauseIntegrityError);
    expect(() => explain({ subjects: [subject(ConstraintCategory.CAPACITY)], capacity: { ...capacityWindow(), clinicId: OTHER } })).toThrow(
      RootCauseIntegrityError,
    );
  });

  it("never sees another clinic's rows: the ledger refuses a mixed slice first", () => {
    const mixed = [...eveningCancellations(), { ...appt("x", "2026-09-01", "18:00", "cancelled"), clinicId: OTHER }];
    expect(() => book({ appointments: mixed })).toThrow(LedgerIntegrityError);
  });

  it("produces identical analyses on reruns and regardless of row order", () => {
    const rows = twoSeparateConcentrations();
    const first = explain({ subjects: [subject(S)], schedule: book({ appointments: rows }) });
    const again = explain({ subjects: [subject(S)], schedule: book({ appointments: rows }) });
    const reversed = explain({ subjects: [subject(S)], schedule: book({ appointments: [...rows].reverse() }) });
    expect(again).toEqual(first);
    expect(reversed).toEqual(first);
  });

  it("returns one analysis per subject, in order, each naming its own parent", () => {
    const analyses = explain({
      subjects: [subject(S), subject(ConstraintCategory.CAPACITY)],
      schedule: book({ appointments: eveningCancellations() }),
      capacity: capacityWindow(),
    });
    expect(analyses.map((a) => [a.parentFindingId, a.question])).toEqual([
      [PARENT[S], "attrition"],
      [PARENT[ConstraintCategory.CAPACITY], "idle_capacity"],
    ]);
    expect(analyses.every((a) => a.clinicId === CLINIC && a.date === DATE)).toBe(true);
  });
});
