/**
 * Business Brain — History coverage.
 *
 * Whether a moment can be answered from recorded state history at all. Capture
 * began per entity when migration 20260917100000 ran; for any earlier moment the
 * state of a record that already existed is unknown, and a reader must say so —
 * or fall back to current state and label the result as such.
 *
 * Pure.
 */

export const HistoryEntity = {
  APPOINTMENT: "appointment",
  TREATMENT: "treatment",
  FOLLOW_UP: "follow_up",
  PAYMENT: "payment",
  PATIENT: "patient",
} as const;
export type HistoryEntity = (typeof HistoryEntity)[keyof typeof HistoryEntity];

export const ALL_HISTORY_ENTITIES: readonly HistoryEntity[] = Object.values(HistoryEntity);

export interface HistoryCapture {
  readonly entity: HistoryEntity;
  /** ISO-8601 moment capture began. */
  readonly capturedSince: string;
}

export interface HistoryCoverage {
  readonly covered: boolean;
  /** Entities with no capture, or capture that began after `knownAt`. Sorted. */
  readonly uncovered: readonly HistoryEntity[];
}

/** Whether every one of `entities` has recorded history reaching back to `knownAt`. */
export function historyCovers(
  captures: readonly HistoryCapture[],
  entities: readonly HistoryEntity[],
  knownAt: string,
): HistoryCoverage {
  const knownMs = Date.parse(knownAt);
  const since = new Map(captures.map((c) => [c.entity, Date.parse(c.capturedSince)]));
  const uncovered = [...new Set(entities)]
    .filter((e) => {
      const start = since.get(e);
      return start === undefined || Number.isNaN(start) || Number.isNaN(knownMs) || start > knownMs;
    })
    .sort();
  return { covered: uncovered.length === 0, uncovered };
}
