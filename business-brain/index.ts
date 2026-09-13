/**
 * Business Brain — Public API
 *
 * The single entry point for the rest of DentGrow. UI and Server Actions
 * import from `@/business-brain` and depend only on what is re-exported here.
 *
 * Dependency direction is strictly one-way:
 *   DentGrow (UI / actions)  ->  Business Brain
 * The Business Brain never imports React components or DentGrow UI.
 */

export * from "./types";
export * from "./domain";
export * from "./core";
export * from "./engines";
export * from "./config";
export * from "./validation";
export * from "./utils";
/**
 * The data port and its snapshot shapes are part of the public API: a consumer
 * cannot construct DentGrowMetricsEngine, nor implement or fake a repository,
 * without them. Only the port is exported — the Business Brain still contains
 * no database access of its own.
 */
export * from "./repositories";
/**
 * The relational ledger: fact types, the port that supplies them, and the pure
 * graph that walks them. Types and pure functions only, like the repositories.
 */
export * from "./ledger";
/** Pipeline orchestration: Metrics -> Signals -> Diagnosis for a clinic-day. */
export * from "./services";
