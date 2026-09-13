/**
 * Business Brain — Trajectory Engine barrel.
 *
 * How tracked metrics have moved over the run's own history: position against
 * an earlier normal range, weekly direction, persistence, and a lifecycle derived
 * by re-classifying the preceding days. Pure; never extrapolates.
 */
export {
  DEFAULT_TRAJECTORY_CONFIG,
  deriveTrajectories,
  TrajectoryIntegrityError,
  type TrajectoryConfig,
  type TrajectoryInput,
  type TrajectoryResult,
} from "./trajectory-engine";
export { NO_TRAJECTORY, TRAJECTORY_CATALOG, type TrajectorySpec } from "./trajectory-catalog";
