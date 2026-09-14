/**
 * Business Brain — Learning Engine barrel.
 *
 * Clinic-scoped patterns across completed actions, their windowed outcomes and
 * the findings actually shown. Pure; exposes a learning only when its threshold
 * holds; proposes, never applies.
 */
export { deriveLearning, LearningIntegrityError, type LearningInput } from "./learning-engine";
export {
  ACTION_LABEL,
  DEFAULT_LEARNING_CONFIG,
  IMPROVEMENT_PHRASE,
  OPPORTUNITY_LABEL,
  PROBLEM_LABEL,
  RESULT_NOUN,
  type LearningConfig,
} from "./learning-config";
export { inputsFromHistory, type HistoryInputs } from "./from-history";
