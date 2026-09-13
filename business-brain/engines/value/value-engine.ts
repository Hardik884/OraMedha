/**
 * Business Brain — Value Engine
 *
 * How much is sitting in each bottleneck.
 *
 * ## What this deliberately does NOT do
 *
 * It does not forecast a return. "Fixing this would earn you ₹40,000" requires
 * knowing how effective an intervention is, and nothing in this system measures
 * that — it would be a number invented to look decisive, arriving in the same
 * voice as the figures that were actually measured. That is the failure mode the
 * whole module is built to avoid.
 *
 * What it reports is VALUE AT STAKE: the measured size of the problem as it
 * currently stands. "₹80,000 of planned treatment is undelivered" is a fact
 * already computed by the Metrics Engine. What share of it a clinic recovers is
 * a fact about the future that nobody here can know.
 *
 * The domain model describes Value as what a strategy "actually delivered",
 * which is realised value and belongs to the Outcome Engine — it needs actions
 * to have been taken and tracked, and neither the Action nor the Outcome engine
 * exists. Same type, measured at a different moment; `description` says which,
 * on every value produced.
 *
 * ## Why it is worth having
 *
 * Severity answers "how alarming", not "how much". Two constraints can both read
 * `high` while one holds ₹80,000 of unbooked treatment and the other ₹2,000. The
 * Strategy Engine ranks by severity, which is correct for urgency and blind to
 * size; value at stake is what separates them without overruling urgency.
 *
 * ## Pure
 *
 * Constraints and metrics in, values out. No clock, no I/O, no projection.
 */

import {
  ConstraintCategory,
  MetricUnit,
  type Constraint,
  type Metric,
  type Value,
  ValueType,
} from "../../domain";
import { MetricKey } from "../metrics/metric-ids";

/**
 * How each bottleneck's size is measured, and in what.
 *
 * Money where money is genuinely at stake, and a count or a duration where it is
 * not. Converting a lost appointment into currency by multiplying by an average
 * case value would be exactly the invented number this engine refuses to
 * produce: the appointments that were lost are not a random sample of the
 * appointments that were kept.
 */
interface ValueSpec {
  readonly type: ValueType;
  readonly unit: MetricUnit;
  /** Metrics summed to size the bottleneck. */
  readonly metrics: readonly MetricKey[];
  /** States what was measured, in the clinic's terms. */
  readonly describe: (amount: number) => string;
}

const VALUE_BY_CATEGORY: Readonly<Record<ConstraintCategory, ValueSpec | null>> = {
  [ConstraintCategory.REVENUE_LEAKAGE]: {
    type: ValueType.REVENUE_RECOVERED,
    unit: MetricUnit.CURRENCY,
    metrics: [MetricKey.REVENUE_OUTSTANDING],
    describe: () => "Billed work that has not been paid for, as it stands today.",
  },
  [ConstraintCategory.TREATMENT_ACCEPTANCE]: {
    type: ValueType.REVENUE_RECOVERED,
    unit: MetricUnit.CURRENCY,
    metrics: [MetricKey.REVENUE_PENDING_TREATMENT_VALUE],
    // The metric is the cost of everything `planned` or `in_progress`, which
    // includes work that IS booked, and `planned` is not a record of consent.
    // Describing it as accepted-and-unbooked overstated it in both directions.
    describe: () => "Treatment that is planned or under way and not yet completed.",
  },
  [ConstraintCategory.CAPACITY]: {
    type: ValueType.HOURS_SAVED,
    unit: MetricUnit.MINUTES,
    // Chair time opened but not booked. Reported as time rather than money,
    // because what an empty chair would have earned depends on what would have
    // been booked into it — which is unknowable, not merely unmeasured.
    metrics: [MetricKey.CAPACITY_OPEN_MINUTES_TODAY],
    describe: () => "Chair time that was open today and went unbooked.",
  },
  [ConstraintCategory.SCHEDULING]: {
    type: ValueType.APPOINTMENTS_BOOKED,
    unit: MetricUnit.COUNT,
    metrics: [MetricKey.APPOINTMENTS_CANCELLED_TODAY, MetricKey.APPOINTMENTS_NO_SHOWS_TODAY],
    describe: () => "Appointments that were booked today and then lost.",
  },
  // RE-POINTED. This used to be sized with PATIENTS_REACTIVATION_CANDIDATES while
  // the card's own words counted overdue follow-ups — so the headline figure named
  // one population and the sentence beneath it named another, and briefing-view.ts
  // carried an override to paper over the disagreement. The lapsed count now sizes
  // REACTIVATION, which is the bottleneck it actually describes, and this is sized
  // by the list it sends staff to work.
  [ConstraintCategory.RETENTION]: {
    type: ValueType.RETENTION_IMPROVED,
    unit: MetricUnit.COUNT,
    metrics: [MetricKey.FOLLOWUPS_OVERDUE],
    describe: () => "Recalls the clinic raised, that are now past their due date.",
  },
  [ConstraintCategory.REACTIVATION]: {
    type: ValueType.RETENTION_IMPROVED,
    unit: MetricUnit.COUNT,
    metrics: [MetricKey.PATIENTS_REACTIVATION_CANDIDATES],
    describe: () =>
      "Patients seen before, not back within a recall interval, with nothing booked.",
  },
  // Sized in MINUTES, which is what a waiting room costs. Deliberately the average
  // wait rather than that average multiplied by the number of patients waiting: the
  // two figures are measured over different populations — the mean is over waits
  // that have ENDED, the count is of patients still waiting — so multiplying them
  // would produce a total nobody measured, in the confident voice of one that was.
  [ConstraintCategory.PATIENT_FLOW]: {
    type: ValueType.HOURS_SAVED,
    unit: MetricUnit.MINUTES,
    metrics: [MetricKey.QUEUE_AVERAGE_WAITING_TIME],
    describe: () => "How long patients waited, on average, after arriving today.",
  },
  // No metric measures how many patients did not arrive — an enquiry that never
  // became an appointment leaves no record at all. Sizing acquisition from what
  // did arrive would measure the opposite of the thing.
  [ConstraintCategory.ACQUISITION]: null,
  // Unsized, and honestly so. What is at stake in a thin week is the chair time
  // still open across it — minutes — but the only forward measurement the engine
  // has is an OCCUPANCY PERCENTAGE (`capacity.booked_next_7d`). There is no
  // metric for the minutes the next 7 days offer, so the minutes cannot be
  // derived, and publishing the percentage as a Value would put a number in a
  // field that means money, minutes, appointments or patients, and mean none of
  // them.
  //
  // The percentage is not lost: the briefing states it in the problem's own
  // summary line, where a share reads as a share. Sizing this properly needs a
  // `capacity.open_minutes_next_7d` metric, at which point this becomes a
  // MINUTES spec like CAPACITY above.
  [ConstraintCategory.FORWARD_SCHEDULE]: null,
  // Unsized, and honestly so — the same reason as FORWARD_SCHEDULE above. What is
  // at stake is the minutes the clinic loses to under-booked slots, and the only
  // measurement available is a RATIO (`scheduling.appointment_overrun_30d`). The
  // absolute minutes could be derived from it, but only for the window it was
  // measured over, and publishing a 30-day total alongside cards that all state
  // today's figures would invite reading it as today's loss.
  //
  // The percentage is not lost: the briefing states it in the problem's own summary
  // line, where a share reads as a share. Sizing this properly needs a
  // `scheduling.overrun_minutes_30d` metric, at which point this becomes a MINUTES
  // spec like PATIENT_FLOW above.
  [ConstraintCategory.SCHEDULE_ACCURACY]: null,
};

export interface ValueResult {
  /** Value at stake per constraint id. A constraint absent here is unsized. */
  readonly byConstraint: ReadonlyMap<string, readonly Value[]>;
}

function metricValue(metrics: readonly Metric[], key: MetricKey): number | undefined {
  const found = metrics.find((m) => m.id.startsWith(`${key}:`));
  return found && Number.isFinite(found.value) ? found.value : undefined;
}

/**
 * Size each constraint from metrics that were actually measured.
 *
 * A constraint whose metrics are missing is left UNSIZED rather than sized at
 * zero. Zero would read as "nothing is at stake here", which would push a
 * genuine problem down any ranking that used it — the difference between "we
 * measured nothing" and "we measured, and it is nothing" matters as much here as
 * anywhere else in this module.
 */
export function deriveValues(
  constraints: readonly Constraint[],
  metrics: readonly Metric[],
  now: string,
): ValueResult {
  const byConstraint = new Map<string, readonly Value[]>();

  for (const constraint of constraints) {
    const spec = VALUE_BY_CATEGORY[constraint.category];
    if (spec === null) continue;

    const parts = spec.metrics.map((key) => metricValue(metrics, key));
    // Every contributing metric must be present. A partial sum would understate
    // the bottleneck while looking like a complete measurement.
    if (parts.some((p) => p === undefined)) continue;

    let amount = parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);

    // Capacity is the one figure that has to be derived rather than read: the
    // metric is chair time OPENED, and what is at stake is the part of it that
    // went unused.
    if (constraint.category === ConstraintCategory.CAPACITY) {
      const utilization = metricValue(metrics, MetricKey.CAPACITY_CHAIR_UTILIZATION);
      if (utilization === undefined) continue;
      amount = Math.max(0, Math.round(amount * (1 - utilization / 100)));
    }

    byConstraint.set(constraint.id, [
      {
        id: `value.${constraint.category}:${constraint.id}`,
        type: spec.type,
        amount,
        unit: spec.unit,
        // Says plainly that this is present size, not projected gain — the one
        // misreading that would turn an honest figure into a promise.
        description: `${spec.describe(amount)} This is what is at stake now, not an estimate of what acting would recover.`,
        measuredAt: now,
      },
    ]);
  }

  return { byConstraint };
}

/**
 * Compare two constraints by what is at stake, for ordering WITHIN equal
 * urgency.
 *
 * Deliberately never across urgency levels. Severity is how alarming something
 * is and value is how big it is; letting a large slow problem outrank a small
 * urgent one would quietly replace the clinic's judgement with an exchange rate
 * between money and risk that nobody set.
 *
 * Only comparable within a unit — appointments and rupees do not convert, and
 * pretending otherwise is the same invented number in another form. Different
 * units compare equal, leaving the caller's existing tiebreak to decide.
 */
export function compareValueAtStake(
  a: readonly Value[] | undefined,
  b: readonly Value[] | undefined,
): number {
  const first = a?.[0];
  const second = b?.[0];
  if (first === undefined || second === undefined) return 0;
  if (first.unit !== second.unit) return 0;
  return second.amount - first.amount;
}
