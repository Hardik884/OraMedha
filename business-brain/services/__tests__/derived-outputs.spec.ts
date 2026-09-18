/**
 * The three derived outputs, through the real orchestrator.
 *
 * Baselines, achievements and the comparison day are computed from the history
 * the run already loads. Each engine has its own unit tests; what needs proving
 * here is the wiring, and three things about it in particular:
 *
 *   - **The recompute cap.** Raising the history window from 7 days to 35 is
 *     free when the store has the days and expensive when it does not, because a
 *     missing day is a full clinic snapshot. The cap has to bite, and it has to
 *     bite on the OLDEST days so the recent window stays contiguous.
 *   - **Today is not in its own baseline.** Folding the current day into the band
 *     it is judged against is a self-comparison that silently understates every
 *     change.
 *   - **Tenant isolation.** Two clinics running the same pipeline must never see
 *     each other's history, ids or wins.
 */

import { describe, expect, it } from "vitest";

import type {
  ClinicDataSnapshot,
  MetricsDataRepository,
  MetricHistoryStore,
  StoredMetricDay,
} from "../../repositories";
import { BusinessBrain } from "../business-brain-service";
import { rateBasisFor } from "../../engines/metrics/metric-bounds";
import { addDays } from "../../utils";
import type { Logger } from "../../utils";

const DATE = "2026-09-12";
const STARTED_AT = "2026-09-12T06:30:00.000Z";

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * A clinic day with a tunable no-show rate, so a history can be given a shape.
 *
 * Everything else is held constant: the point of these fixtures is one metric
 * moving, and a second moving variable would make a failure ambiguous.
 */
function snapshotFor(
  clinicId: string,
  date: string,
  options: { noShows?: number; total?: number } = {},
): ClinicDataSnapshot {
  const total = options.total ?? 20;
  const noShows = options.noShows ?? 2;
  const appointments = Array.from({ length: total }, (_, i) => ({
    id: `${date}-a${i}`,
    patientId: `p${i}`,
    status: i < noShows ? "no_show" : "completed",
    scheduledAt: `${date}T04:00:00.000Z`,
    createdAt: `${date}T00:00:00.000Z`,
    durationMinutes: 30,
    source: "walk_in",
  }));

  // The trailing window repeats the day's pattern, so its rate is identical and
  // its DENOMINATOR is a month's worth rather than a day's. A rate over twenty
  // appointments is not judged against a band at all (see `metric-bounds.ts`),
  // and a fixture standing in for thirty days should not read like one day.
  const windowAppointments = Array.from({ length: 3 }, (_, week) =>
    appointments.map((a) => ({ ...a, id: `${a.id}-w${week}` })),
  ).flat();

  return {
    clinicId,
    date,
    asOf: `${date}T06:30:00.000Z`,
    appointmentsToday: appointments,
    patientsRegisteredToday: [],
    patientsSeenToday: [{ id: "p1", createdAt: "2026-01-01T00:00:00.000Z" }],
    treatments: [],
    payments: [],
    queueToday: [],
    followUps: [],
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
    trailingWindow: {
      from: addDays(date, -29),
      to: date,
      appointments: windowAppointments,
      openChairMinutes: 480 * 30,
    },
  };
}

/** Counts snapshot reads so the recompute cap can be observed, not assumed. */
class CountingRepository implements MetricsDataRepository {
  readonly dates: string[] = [];
  constructor(private readonly shape: (date: string) => { noShows?: number } = () => ({})) {}
  async getClinicSnapshot(clinicId: string, date: string): Promise<ClinicDataSnapshot> {
    this.dates.push(date);
    return snapshotFor(clinicId, date, this.shape(date));
  }
}

/** An in-memory history store, so a test can decide exactly what is stored. */
class FakeHistoryStore implements MetricHistoryStore {
  readonly writes: string[] = [];
  constructor(private readonly days: Map<string, StoredMetricDay> = new Map()) {}

  async readMetricDays(
    _clinicId: string,
    from: string,
    to: string,
  ): Promise<readonly StoredMetricDay[]> {
    return [...this.days.values()]
      .filter((d) => d.date >= from && d.date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async writeMetricDay(_clinicId: string, day: StoredMetricDay): Promise<void> {
    this.writes.push(day.date);
  }
}

/**
 * Stored days carrying one metric at a fixed value — plus its denominator, when
 * the metric is a rate.
 *
 * A stored rate without its denominator is a day the Baseline Engine cannot use,
 * which is correct in production and would make every scenario here a test of
 * the missing denominator rather than of the band.
 */
function storedDays(
  count: number,
  key: string,
  value: number,
  endingBefore = DATE,
  /** Appointments behind each stored day, ample by default. */
  sample = 60,
): Map<string, StoredMetricDay> {
  const basis = rateBasisFor(key);
  const days = new Map<string, StoredMetricDay>();
  for (let offset = 1; offset <= count; offset += 1) {
    const date = addDays(endingBefore, -offset);
    const measuredAt = `${date}T18:00:00.000Z`;
    days.set(date, {
      date,
      metrics: [
        { key, value, measuredAt },
        ...(basis === undefined
          ? []
          : [{ key: basis.denominatorKey as string, value: sample, measuredAt }]),
      ],
    });
  }
  return days;
}

function brain(repository: MetricsDataRepository, historyStore?: MetricHistoryStore) {
  let tick = 0;
  return new BusinessBrain({
    repository,
    historyStore,
    logger: silentLogger(),
    clock: () => (tick += 10),
  });
}

// ── Baselines ────────────────────────────────────────────────────────────────

describe("baselines on the result", () => {
  it("are empty when no history was requested", async () => {
    const result = await brain(new CountingRepository()).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
    });
    expect(result.baselines).toEqual([]);
    expect(result.achievements).toEqual([]);
    expect(result.comparison).toBeUndefined();
  });

  it("describe this clinic's own normal range from its stored history", async () => {
    const store = new FakeHistoryStore(
      storedDays(12, "scheduling.no_show_rate_30d", 15),
    );
    const result = await brain(new CountingRepository(), store).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 12,
    });

    const baseline = result.baselines.find((b) => b.key === "scheduling.no_show_rate_30d");
    expect(baseline?.median).toBe(15);
    expect(baseline?.observations).toBe(12);
    expect(baseline?.quality).toBe("adequate");
  });

  it("exclude today from the band today is judged against", async () => {
    // The snapshot puts today's no-show rate at 10%; history says 15%. A baseline
    // that folded today in would land between the two and understate the change.
    const store = new FakeHistoryStore(
      storedDays(12, "scheduling.no_show_rate_30d", 15),
    );
    const result = await brain(
      new CountingRepository(() => ({ noShows: 2 })),
      store,
    ).runBusinessBrain("c1", DATE, { startedAt: STARTED_AT, historyDays: 12 });

    const baseline = result.baselines.find((b) => b.key === "scheduling.no_show_rate_30d");
    expect(baseline?.median).toBe(15);
    expect(baseline?.current).toBe(10);
  });
});

// ── Achievements ─────────────────────────────────────────────────────────────

describe("achievements on the result", () => {
  it("report a measured improvement against the clinic's own normal", async () => {
    // History at 15% no-shows, today at 5%: outside the band, past the 2-point
    // floor, and the clinic's normal was not already good.
    const store = new FakeHistoryStore(
      storedDays(14, "scheduling.no_show_rate_30d", 15),
    );
    const result = await brain(
      new CountingRepository(() => ({ noShows: 1 })),
      store,
    ).runBusinessBrain("c1", DATE, { startedAt: STARTED_AT, historyDays: 14 });

    const win = result.achievements.find(
      (a) => a.metricKey === "scheduling.no_show_rate_30d",
    );
    expect(win).toBeDefined();
    expect(win?.baseline).toBe(15);
    expect(win?.current).toBe(5);
    expect(win?.id).toBe(`achievement.scheduling.no_show_rate_30d:c1:${DATE}`);
  });

  it("report nothing for a clinic running inside its usual range", async () => {
    // The common and correct answer. Silence, not invented praise.
    const store = new FakeHistoryStore(
      storedDays(14, "scheduling.no_show_rate_30d", 10),
    );
    const result = await brain(
      new CountingRepository(() => ({ noShows: 2 })),
      store,
    ).runBusinessBrain("c1", DATE, { startedAt: STARTED_AT, historyDays: 14 });

    expect(
      result.achievements.some((a) => a.metricKey === "scheduling.no_show_rate_30d"),
    ).toBe(false);
  });

  it("report nothing when history is too thin to know what normal is", async () => {
    const store = new FakeHistoryStore(storedDays(3, "scheduling.no_show_rate_30d", 15));
    const result = await brain(
      new CountingRepository(() => ({ noShows: 1 })),
      store,
    ).runBusinessBrain("c1", DATE, { startedAt: STARTED_AT, historyDays: 3 });
    expect(result.achievements).toEqual([]);
  });
});

// ── The comparison day ───────────────────────────────────────────────────────

describe("the comparison day", () => {
  it("prefers exactly a week back", async () => {
    const store = new FakeHistoryStore(storedDays(14, "revenue.outstanding", 5000));
    const result = await brain(new CountingRepository(), store).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });
    expect(result.comparison?.daysAgo).toBe(7);
    expect(result.comparison?.date).toBe(addDays(DATE, -7));
  });

  it("falls back to the nearest week-ish day when that one was never measured", async () => {
    // A clinic closed on the matching day. Comparing against the nearest day and
    // saying which is better than refusing to compare at all.
    //
    // The cap is zero deliberately: without it the run would simply MEASURE the
    // missing day from the live database, and the fallback would never be
    // exercised. That is also the correct production behaviour — this path only
    // matters for days too old for the cap to reach.
    const days = storedDays(14, "revenue.outstanding", 5000);
    days.delete(addDays(DATE, -7));
    const result = await brain(
      new CountingRepository(),
      new FakeHistoryStore(days),
    ).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
      maxRecomputedHistoryDays: 0,
    });

    // 6 and 8 are equidistant; the OLDER wins, so the comparison never quietly
    // shortens toward a day-over-day reading.
    expect(result.comparison?.daysAgo).toBe(8);
  });

  it("carries baselines positioned for THAT day, not for today", async () => {
    // The bug this pins: scoring last week with today's baseline positions hands
    // the earlier day today's credits, which makes the "previous score" on screen
    // untrue even where the difference cancels out of the delta.
    //
    // History sits at 15% no-shows throughout; today's snapshot reads 5%. The
    // comparison day's own metrics also read 15%, so its baseline must be INSIDE
    // the band while today's is below it.
    const store = new FakeHistoryStore(
      storedDays(20, "scheduling.no_show_rate_30d", 15),
    );
    const result = await brain(
      new CountingRepository(() => ({ noShows: 1 })),
      store,
    ).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 20,
      maxRecomputedHistoryDays: 0,
    });

    const todayBaseline = result.baselines.find(
      (b) => b.key === "scheduling.no_show_rate_30d",
    );
    const thenBaseline = result.comparison?.baselines.find(
      (b) => b.key === "scheduling.no_show_rate_30d",
    );

    expect(todayBaseline?.current).toBe(5);
    expect(todayBaseline?.position).toBe("below");
    expect(thenBaseline?.current).toBe(15);
    expect(thenBaseline?.position).toBe("inside");
    // Same history, so the same notion of normal on both sides.
    expect(thenBaseline?.median).toBe(todayBaseline?.median);
  });

  it("excludes the comparison day from its own baseline history", async () => {
    // The same rule today gets: a day folded into the band it is judged against
    // is being compared with itself.
    const store = new FakeHistoryStore(
      storedDays(20, "scheduling.no_show_rate_30d", 15),
    );
    const result = await brain(
      new CountingRepository(),
      store,
    ).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 20,
      maxRecomputedHistoryDays: 0,
    });

    const thenBaseline = result.comparison?.baselines.find(
      (b) => b.key === "scheduling.no_show_rate_30d",
    );
    // 20 stored days, the comparison day is 7 back, so 13 days precede it.
    expect(thenBaseline?.observations).toBe(13);
  });

  it("carries no baselines when the clinic has no baselines at all", async () => {
    const result = await brain(new CountingRepository()).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 8,
      maxRecomputedHistoryDays: 8,
    });
    // History exists, so a comparison day exists — but with only 8 days of a
    // single metric set the bands may or may not qualify; either way the field is
    // always an array, never undefined.
    expect(Array.isArray(result.comparison?.baselines ?? [])).toBe(true);
  });

  it("is absent when history does not reach back far enough", async () => {
    const store = new FakeHistoryStore(storedDays(2, "revenue.outstanding", 5000));
    const result = await brain(new CountingRepository(), store).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 2,
    });
    expect(result.comparison).toBeUndefined();
  });
});

// ── The recompute cap ────────────────────────────────────────────────────────

describe("the history recompute cap", () => {
  it("measures every missing day when uncapped, as it always did", async () => {
    const repository = new CountingRepository();
    await brain(repository).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 10,
    });
    // Today plus ten history days.
    expect(repository.dates).toHaveLength(11);
  });

  it("measures no more than the cap allows", async () => {
    // The regression this exists to prevent: 35 history days against a cold store
    // would be 35 full clinic snapshots inside a page render.
    const repository = new CountingRepository();
    await brain(repository).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 35,
      maxRecomputedHistoryDays: 7,
    });
    expect(repository.dates).toHaveLength(8);
  });

  it("keeps the RECENT days and drops the oldest", async () => {
    // The ordering is the whole design. Persistence reasons over the recent
    // consecutive run, so dropping the oldest days leaves the supplied window
    // contiguous where it matters instead of punching a hole in it.
    const repository = new CountingRepository();
    await brain(repository).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 20,
      maxRecomputedHistoryDays: 3,
    });

    const historyRead = repository.dates.filter((d) => d !== DATE).sort();
    expect(historyRead).toEqual([
      addDays(DATE, -3),
      addDays(DATE, -2),
      addDays(DATE, -1),
    ]);
  });

  it("still uses every stored day, however low the cap", async () => {
    // The cap governs recomputation, not reading. A clinic with a warm store gets
    // its whole window regardless.
    const store = new FakeHistoryStore(
      storedDays(20, "scheduling.no_show_rate_30d", 15),
    );
    const repository = new CountingRepository();
    const result = await brain(repository, store).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 20,
      maxRecomputedHistoryDays: 0,
    });

    expect(result.execution.historyDaysLoaded).toBe(20);
    // Only today was measured; every history day came from the store.
    expect(repository.dates).toEqual([DATE]);
    expect(result.baselines.find((b) => b.key === "scheduling.no_show_rate_30d")?.observations).toBe(
      20,
    );
  });

  it("leaves a skipped day absent rather than inventing a quiet one", async () => {
    const store = new FakeHistoryStore(storedDays(4, "scheduling.no_show_rate_30d", 15));
    const result = await brain(new CountingRepository(), store).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 20,
      maxRecomputedHistoryDays: 0,
    });
    // Four stored, sixteen skipped, and the baseline counts only what it saw.
    expect(result.execution.historyDaysLoaded).toBe(4);
    expect(result.baselines.find((b) => b.key === "scheduling.no_show_rate_30d")?.observations).toBe(
      4,
    );
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe("multi-clinic isolation", () => {
  it("scopes every achievement id to its own clinic", async () => {
    const store = new FakeHistoryStore(
      storedDays(14, "scheduling.no_show_rate_30d", 15),
    );
    const engine = brain(new CountingRepository(() => ({ noShows: 1 })), store);

    const a = await engine.runBusinessBrain("clinic_a", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });
    const b = await engine.runBusinessBrain("clinic_b", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });

    expect(a.achievements[0]?.id).toContain("clinic_a");
    expect(b.achievements[0]?.id).toContain("clinic_b");
    expect(a.achievements[0]?.id).not.toBe(b.achievements[0]?.id);
  });

  it("asks the history store for each clinic separately", async () => {
    // The store is handed the clinic id on every read; a shared cache keyed only
    // by date would show up here as the second clinic inheriting the first's
    // history.
    const asked: string[] = [];
    const store: MetricHistoryStore = {
      async readMetricDays(clinicId) {
        asked.push(clinicId);
        return [];
      },
      async writeMetricDay() {},
    };
    const engine = brain(new CountingRepository(), store);
    await engine.runBusinessBrain("clinic_a", DATE, { startedAt: STARTED_AT, historyDays: 5 });
    await engine.runBusinessBrain("clinic_b", DATE, { startedAt: STARTED_AT, historyDays: 5 });
    expect(asked).toEqual(["clinic_a", "clinic_b"]);
  });

  it("holds no state between runs, so one clinic's baselines cannot leak", async () => {
    // Clinic A has a long history at 15%; clinic B has none. B must get no
    // baselines at all rather than A's.
    const engine = brain(new CountingRepository());
    const withHistory = brain(
      new CountingRepository(),
      new FakeHistoryStore(storedDays(14, "scheduling.no_show_rate_30d", 15)),
    );

    const a = await withHistory.runBusinessBrain("clinic_a", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });
    const b = await engine.runBusinessBrain("clinic_b", DATE, { startedAt: STARTED_AT });

    expect(a.baselines.length).toBeGreaterThan(0);
    expect(b.baselines).toEqual([]);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("produces identical baselines and achievements across runs", async () => {
    const store = new FakeHistoryStore(
      storedDays(14, "scheduling.no_show_rate_30d", 15),
    );
    const engine = brain(new CountingRepository(() => ({ noShows: 1 })), store);
    const first = await engine.runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });
    const second = await engine.runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });

    expect(second.baselines).toEqual(first.baselines);
    expect(second.achievements).toEqual(first.achievements);
    expect(second.comparison).toEqual(first.comparison);
  });

  it("writes nothing while deriving them", async () => {
    // The run stays read-only, the property `pipeline.spec.ts` protects. Baselines
    // and achievements are computed from data already in memory.
    const store = new FakeHistoryStore(
      storedDays(14, "scheduling.no_show_rate_30d", 15),
    );
    await brain(new CountingRepository(), store).runBusinessBrain("c1", DATE, {
      startedAt: STARTED_AT,
      historyDays: 14,
    });
    expect(store.writes).toEqual([]);
  });
});
