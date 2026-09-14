/**
 * The Root-Cause Engine on data with NOTHING to find.
 *
 * Each simulated clinic loses appointments at the same rate everywhere — every
 * day, session, booking length and lead time — so every association the engine
 * reports here is a false one. The engine compares many groups at once, which is
 * exactly how a small chance of a spurious difference per comparison grows into a
 * large chance of reporting one per clinic. This pins how often that happens.
 *
 * The randomness is a seeded generator in the TEST: the engine itself is still
 * deterministic, and the same seeds give the same clinics every run.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory } from "../../../domain";
import type { AppointmentFact } from "../../../ledger";
import type { QueueVisitFact, TreatmentFact } from "../../../ledger";
import { appt, book, capacityWindow, one, subject, treatmentAt, visit, weekdays } from "./root-cause-fixtures";

/**
 * The family budget is 5%. Measured over 1000 seeded clinics its sampling error
 * is about 0.7 points, so the assertion allows one point on top. Before the
 * multiple-comparison correction these rates were 18% (attrition), 25%
 * (overruns), 31% (waits) and 77% (idle capacity).
 */
const BUDGET_WITH_SAMPLING_ERROR = 0.06;

/** Mulberry32: a small, seeded, reproducible generator. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIMES = ["09:00", "09:30", "10:30", "12:30", "14:00", "15:30", "17:30", "18:30"];
const DURATIONS = [15, 30, 45, 75];

function nullClinic(seed: number, lossRate: number, perDay: number): AppointmentFact[] {
  const rand = generator(seed);
  const out: AppointmentFact[] = [];
  weekdays().forEach((date, d) => {
    for (let i = 0; i < perDay; i += 1) {
      const time = TIMES[Math.floor(rand() * TIMES.length)];
      const lost = rand() < lossRate;
      const a = appt(`s${seed}_${d}_${i}`, date, time, lost ? (rand() < 0.5 ? "cancelled" : "no_show") : "completed", {
        durationMinutes: DURATIONS[Math.floor(rand() * DURATIONS.length)],
      });
      const leadDays = Math.floor(rand() * 30);
      out.push({ ...a, bookedAt: new Date(Date.parse(a.scheduledAt) - leadDays * 86_400_000 - 3_600_000).toISOString() });
    }
  });
  return out;
}

describe("root causes on data with no real concentration", () => {
  it("stays within the 5% false-positive budget", () => {
    const clinics = 1000;
    let falsePositives = 0;
    for (let seed = 1; seed <= clinics; seed += 1) {
      // Some slots can repeat for the same fake dentist; the engine never reads slot uniqueness.
      const analysis = one({ subjects: [subject(ConstraintCategory.SCHEDULING)], schedule: book({ appointments: nullClinic(seed, 0.2, 6) }) });
      if (analysis.outcome === "explained") falsePositives += 1;
    }
    expect(falsePositives / clinics).toBeLessThanOrEqual(BUDGET_WITH_SAMPLING_ERROR);
  });
});

describe("null simulations for the median rules", () => {
  function normalish(rand: () => number, mean: number, spread: number): number {
    return Math.round(mean + (rand() + rand() + rand() - 1.5) * spread);
  }

  it("overruns: stays within the 5% false-positive budget", () => {
    
    const types = ["Cleaning", "Filling", "Crown", "Root canal"];
    let fp = 0;
    const clinics = 1000;
    for (let seed = 1; seed <= clinics; seed += 1) {
      const rand = generator(seed * 7919);
      const appointments: AppointmentFact[] = [];
      const queueVisits: QueueVisitFact[] = [];
      const treatments: TreatmentFact[] = [];
      weekdays().forEach((date, d) => {
        for (let i = 0; i < 3; i += 1) {
          const a = appt(`o${seed}_${d}_${i}`, date, TIMES[Math.floor(rand() * TIMES.length)], "completed", { durationMinutes: 30 });
          appointments.push(a);
          queueVisits.push(visit(a, { wait: 5, minutesInChair: Math.max(1, 30 + normalish(rand, 5, 30)) }));
          treatments.push(treatmentAt(a, types[Math.floor(rand() * types.length)]));
        }
      });
      if (one({ subjects: [subject(ConstraintCategory.SCHEDULE_ACCURACY)], schedule: book({ appointments, queueVisits, treatments }) }).outcome === "explained") fp += 1;
    }
    expect(fp / clinics).toBeLessThanOrEqual(BUDGET_WITH_SAMPLING_ERROR);
  });

  it("waits: stays within the 5% false-positive budget", () => {
    
    let fp = 0;
    const clinics = 1000;
    for (let seed = 1; seed <= clinics; seed += 1) {
      const rand = generator(seed * 104729);
      const appointments: AppointmentFact[] = [];
      const queueVisits: QueueVisitFact[] = [];
      weekdays().forEach((date, d) => {
        const perDay = 1 + Math.floor(rand() * 4);
        for (let i = 0; i < perDay; i += 1) {
          const a = appt(`w${seed}_${d}_${i}`, date, TIMES[Math.floor(rand() * TIMES.length)]);
          appointments.push(a);
          queueVisits.push(visit(a, { arriveOffset: normalish(rand, 0, 30), wait: Math.max(0, normalish(rand, 15, 30)), minutesInChair: 30 }));
        }
      });
      if (one({ subjects: [subject(ConstraintCategory.PATIENT_FLOW)], schedule: book({ appointments, queueVisits }) }).outcome === "explained") fp += 1;
    }
    expect(fp / clinics).toBeLessThanOrEqual(BUDGET_WITH_SAMPLING_ERROR);
  });

  it("idle capacity: stays within the 5% false-positive budget", () => {
    
    let fp = 0;
    const clinics = 1000;
    for (let seed = 1; seed <= clinics; seed += 1) {
      const rand = generator(seed * 15485863);
      const appointments: AppointmentFact[] = [];
      weekdays().forEach((date, d) => {
        const count = Math.floor(rand() * 7);
        for (let i = 0; i < count; i += 1) appointments.push(appt(`c${seed}_${d}_${i}`, date, ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"][i], "completed", { durationMinutes: 30 }));
      });
      if (one({ subjects: [subject(ConstraintCategory.CAPACITY)], schedule: book({ appointments }), capacity: capacityWindow() }).outcome === "explained") fp += 1;
    }
    expect(fp / clinics).toBeLessThanOrEqual(BUDGET_WITH_SAMPLING_ERROR);
  });
});
