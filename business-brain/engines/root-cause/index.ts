/**
 * Business Brain — Root-Cause Engine barrel.
 *
 * Where a detected problem is concentrated in the clinic's own ledger, by one
 * reliable dimension at a time, with every comparison exposed. Association only;
 * pure; never ranks, acts, or explains with a model.
 */
export {
  deriveRootCauses,
  RootCauseIntegrityError,
  rootCauseSubjects,
  type RootCauseInput,
  type RootCauseSubject,
} from "./root-cause-engine";
export { DEFAULT_ROOT_CAUSE_CONFIG, type RootCauseConfig } from "./root-cause-config";
export { quantile, wilson } from "./stats";
