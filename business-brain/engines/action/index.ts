/**
 * Business Brain — Action Engine barrel.
 *
 * The pipeline's last stage: workflows in, prepared actions out. It makes no
 * business judgement and causes no side effect — it converts an execution plan
 * into the specific screens, filters and drafts DentGrow can put in front of the
 * person doing the work.
 */
export {
  generateActions,
  prepareActionPlan,
  type ActionPlanSource,
  type ActionResult,
} from "./action-engine";
export {
  ACTION_CATALOG,
  CATALOG_IDS,
  Capability,
  placeholdersIn,
  type ActionCapability,
  type CapabilityId,
} from "./action-catalog";
export { ACTION_PLANS, type ActionPlanStep } from "./action-plans";
export { actionDateWindows, type ActionDateWindows } from "./action-dates";
