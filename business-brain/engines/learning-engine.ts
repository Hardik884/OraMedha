/**
 * LearningEngine — contract
 *
 * RESPONSIBILITY:
 * Derives clinic-specific patterns from what actually followed completed actions:
 * actions repeatedly followed by their intended result, actions followed by no
 * measurable change, recommendations not taken up, problems that never clear,
 * how long results take, and episodes that end sooner when someone acts.
 *
 * Consumes:  outcomes assessed with windowed evidence + recorded findings + snoozes
 * Produces:  learnings, per-subject assessments, and INERT proposals
 *
 * It never adjusts a threshold, rule, ranking or action. A proposal requires a
 * person to accept it, and nothing in the Business Brain reads one back.
 *
 * THE IMPLEMENTATION LIVES IN `./learning/`.
 */

import { BaseEngine } from "../core";
import type { ClinicLearning } from "../domain";
import type { LearningInput } from "./learning";

export type LearningEngineInput = LearningInput;

export type LearningEngineOutput = ClinicLearning;

export abstract class LearningEngine extends BaseEngine<
  LearningEngineInput,
  LearningEngineOutput
> {
  readonly name = "LearningEngine";
}
