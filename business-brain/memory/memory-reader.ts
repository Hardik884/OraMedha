/**
 * Business Brain — Clinic Memory reader
 *
 * The one way a Business Brain component asks what this clinic's history shows.
 *
 * ## Every answer carries its evidence
 *
 * A reader never returns a sentence. It returns a status — known, insufficient
 * evidence, or not built — the entries behind the answer with their evidence,
 * revalidation and confidence, and the build date. A caller that cannot use those
 * has no business using the answer.
 *
 * ## Support, never override
 *
 * Only `active` and `weakening` entries are returned as support by default;
 * stale, superseded and rejected ones are reachable only by asking for them. An
 * answer below the caller's confidence floor comes back as insufficient evidence.
 * Nothing here ranks a finding, sets a threshold or changes an action: accepted
 * decisions are listed for an explicit, auditable consumer to read, and nothing
 * consumes them implicitly.
 *
 * Pure. Constructed for one clinic and refuses a memory built for another.
 */

import type { ClinicMemory, ClinicMemoryEntry, MemoryType, ResolvedDecision } from "../domain";
import { MemoryIntegrityError } from "./memory-engine";

export interface MemoryAnswer {
  readonly status: "known" | "insufficient_evidence" | "not_built";
  readonly entries: readonly ClinicMemoryEntry[];
  /** The highest confidence among the entries, or null when there are none. */
  readonly confidence: number | null;
  readonly builtFor: string | null;
}

export interface UnusualAnswer {
  readonly verdict: "unusual" | "usual" | "unknown";
  readonly direction: "above" | "below" | null;
  readonly range: ClinicMemoryEntry | null;
  readonly confidence: number | null;
  readonly builtFor: string | null;
}

export interface ReadOptions {
  /** Answers below this confidence are insufficient evidence. Default 0.4. */
  readonly minConfidence?: number;
  /** Include stale, superseded and rejected entries. Default false. */
  readonly includeInactive?: boolean;
}

const SUPPORTING: ReadonlySet<string> = new Set(["active", "weakening"]);

export class ClinicMemoryReader {
  private constructor(
    readonly clinicId: string,
    private readonly memory: ClinicMemory | null,
  ) {}

  /** A reader for `clinicId`. A memory built for another clinic is refused outright. */
  static for(clinicId: string, memory: ClinicMemory | null): ClinicMemoryReader {
    if (memory !== null && memory.clinicId !== clinicId) {
      throw new MemoryIntegrityError(`Memory built for clinic ${memory.clinicId} cannot be read for ${clinicId}.`);
    }
    if (memory !== null && memory.entries.some((e) => e.clinicId !== clinicId)) {
      throw new MemoryIntegrityError(`Memory for ${clinicId} carries another clinic's entry.`);
    }
    return new ClinicMemoryReader(clinicId, memory);
  }

  get builtFor(): string | null {
    return this.memory?.builtFor ?? null;
  }

  private answer(match: (e: ClinicMemoryEntry) => boolean, options: ReadOptions = {}): MemoryAnswer {
    if (this.memory === null) return { status: "not_built", entries: [], confidence: null, builtFor: null };
    const floor = options.minConfidence ?? 0.4;
    const entries = this.memory.entries.filter(
      (e) => match(e) && (options.includeInactive === true || (SUPPORTING.has(e.status) && e.confidence >= floor)),
    );
    return {
      status: entries.length === 0 ? "insufficient_evidence" : "known",
      entries,
      confidence: entries.length === 0 ? null : Math.max(...entries.map((e) => e.confidence)),
      builtFor: this.memory.builtFor,
    };
  }

  private ofType(type: MemoryType, key?: string, options?: ReadOptions): MemoryAnswer {
    return this.answer((e) => e.type === type && (key === undefined || e.subject.key === key), options);
  }

  /** What has been normal for this metric at this clinic. */
  normalRange(metricKey: string, options?: ReadOptions): MemoryAnswer {
    return this.answer((e) => e.type === "normal_range" && e.subject.key === metricKey && e.subject.qualifier === null, options);
  }

  /** Whether a reading is outside this clinic's active normal range. Unknown without one. */
  unusual(metricKey: string, value: number | null, options?: ReadOptions): UnusualAnswer {
    const range = this.normalRange(metricKey, options).entries.find((e) => e.status === "active") ?? null;
    if (range === null || value === null || !Number.isFinite(value)) {
      return { verdict: "unknown", direction: null, range: null, confidence: null, builtFor: this.builtFor };
    }
    const lower = Number(range.facts.lower);
    const upper = Number(range.facts.upper);
    const direction = value > upper ? "above" : value < lower ? "below" : null;
    return { verdict: direction === null ? "usual" : "unusual", direction, range, confidence: range.confidence, builtFor: this.builtFor };
  }

  /** Problems flagged in repeated, separate episodes. */
  recurringProblems(category?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("recurring_problem", category, options);
  }

  recurringOpportunities(type?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("recurring_opportunity", type, options);
  }

  recurringRootCauses(options?: ReadOptions): MemoryAnswer {
    return this.ofType("recurring_root_cause", undefined, options);
  }

  weekdayPatterns(metricKey?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("weekday_pattern", metricKey, options);
  }

  historicalChanges(metricKey?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("historical_change", metricKey, options);
  }

  /** Actions repeatedly followed by their intended result. */
  effectiveActions(category?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("action_effective", category, options);
  }

  /** Actions repeatedly followed by no measurable change. */
  ineffectiveActions(category?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("action_no_change", category, options);
  }

  ignoredActions(category?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("action_ignored", category, options);
  }

  timeToResult(category?: string, options?: ReadOptions): MemoryAnswer {
    return this.ofType("action_time_to_result", category, options);
  }

  /** Patterns that no longer hold, or can no longer be checked — kept, and labelled so. */
  stalePatterns(): MemoryAnswer {
    return this.answer((e) => e.status === "weakening" || e.status === "stale" || e.status === "superseded", { includeInactive: true });
  }

  /** Proposals the clinic accepted. Listed for an explicit consumer; nothing applies them implicitly. */
  acceptedPreferences(): readonly ResolvedDecision[] {
    return (this.memory?.decisions ?? []).filter((d) => d.target.type === "proposal" && d.decision === "accepted");
  }

  /** Proposals and memories the clinic rejected. */
  rejected(): readonly ResolvedDecision[] {
    return (this.memory?.decisions ?? []).filter((d) => d.decision === "rejected");
  }
}
