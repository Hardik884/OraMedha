/**
 * OutcomeEngine — contract
 *
 * RESPONSIBILITY:
 * Measures what actually happened after actions were completed. It closes the
 * loop between decision and reality.
 *
 * Consumes:  action completions + entity-level verification + current metrics
 * Produces:  Outcome objects, at `insufficient_evidence` or `observed_after`
 *
 * THE IMPLEMENTATION LIVES IN `./outcome/`.
 *
 * This file keeps the abstract contract, matching every other engine in the
 * module — the concrete function is `deriveOutcomes` in
 * `./outcome/outcome-engine.ts`, and the I/O types are exported from there
 * rather than restated here so the two cannot drift.
 */

import { BaseEngine } from "../core";
import type { OutcomeEngineInput, OutcomeResult } from "./outcome";

export type { OutcomeEngineInput } from "./outcome";

/** The engine's output payload — one Outcome per assessed completion. */
export type OutcomeEngineOutput = OutcomeResult;

export abstract class OutcomeEngine extends BaseEngine<
  OutcomeEngineInput,
  OutcomeEngineOutput
> {
  readonly name = "OutcomeEngine";
}
