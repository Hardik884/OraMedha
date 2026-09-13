/**
 * Business Brain — Findings barrel.
 *
 * Normalisation of every producer's output into one Finding shape, the explicit
 * rules that collapse one event into one finding, and the single deterministic
 * prioritiser. Pure; no producer's logic is repeated here.
 */
export {
  CONSTRAINT_KIND,
  CONSTRAINT_RESOURCE,
  FindingIntegrityError,
  normalizeFindings,
  type FindingSources,
} from "./normalize";
export { buildClusters, CollapseRule, collapseEdges, type CollapseEdge } from "./collapse";
export { prioritizeFindings, rankFindings, type PrioritizeInput } from "./prioritize";
export { FINDINGS_CONFIG } from "./findings-config";
