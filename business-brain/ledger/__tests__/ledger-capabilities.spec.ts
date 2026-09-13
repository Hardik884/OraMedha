/**
 * The capability catalogue is a set of claims about the schema. These specs keep
 * the claims internally consistent and tie them to the graph, so a relationship
 * cannot be declared unrecorded in one place and silently walked in another.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_LEDGER_CAPABILITIES, LedgerRecording } from "../ledger-capabilities";
import { LedgerFactKind } from "../ledger-facts";

describe("ledger capability catalogue", () => {
  it("has unique keys", () => {
    const keys = ALL_LEDGER_CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("exposes a fact kind if and only if the relationship is recorded at all", () => {
    for (const c of ALL_LEDGER_CAPABILITIES) {
      if (c.recording === LedgerRecording.NOT_RECORDED) {
        expect(c.exposedAs, c.key).toBeNull();
      } else {
        expect(c.exposedAs, c.key).not.toBeNull();
      }
    }
  });

  it("states the limitation of anything less than fully recorded", () => {
    for (const c of ALL_LEDGER_CAPABILITIES) {
      if (c.recording !== LedgerRecording.RECORDED) {
        expect(c.limitation, c.key).toBeTruthy();
      }
    }
  });

  it("accounts for every fact kind the ledger carries", () => {
    const exposed = new Set<string | null>(ALL_LEDGER_CAPABILITIES.map((c) => c.exposedAs));
    for (const kind of Object.values(LedgerFactKind)) {
      expect(exposed.has(kind), kind).toBe(true);
    }
  });

  it("backs every not_recorded traversal in the graph with a catalogue entry", () => {
    const graphSource = readFileSync(
      fileURLToPath(new URL("../ledger-graph.ts", import.meta.url)),
      "utf8",
    );
    const referenced = [...graphSource.matchAll(/notRecorded\(LEDGER_CAPABILITIES\.([A-Z_]+)\)/g)].map(
      (m) => m[1],
    );
    expect(referenced.length).toBeGreaterThanOrEqual(4);
    const catalogue = new Set(
      ALL_LEDGER_CAPABILITIES.filter((c) => c.recording === LedgerRecording.NOT_RECORDED).map((c) =>
        c.key.toUpperCase(),
      ),
    );
    for (const name of referenced) expect(catalogue.has(name), name).toBe(true);
  });

  it("names the facts the flat snapshot could not carry, and the ones nobody can", () => {
    const byKey = new Map(ALL_LEDGER_CAPABILITIES.map((c) => [c.key, c.recording]));
    // Present in the schema and now relationally reachable.
    expect(byKey.get("treatment_recording_visit")).toBe(LedgerRecording.RECORDED);
    expect(byKey.get("visit_queue_timing")).toBe(LedgerRecording.RECORDED);
    expect(byKey.get("follow_up_booking")).toBe(LedgerRecording.PARTIALLY_RECORDED);
    // Genuinely absent from the schema; no adapter may pretend otherwise.
    expect(byKey.get("planned_treatment_booking")).toBe(LedgerRecording.NOT_RECORDED);
    expect(byKey.get("treatment_plan")).toBe(LedgerRecording.NOT_RECORDED);
    expect(byKey.get("treatment_decision")).toBe(LedgerRecording.NOT_RECORDED);
    expect(byKey.get("contact_outcome")).toBe(LedgerRecording.NOT_RECORDED);
  });
});
