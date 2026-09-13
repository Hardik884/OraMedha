/**
 * Business Brain — Domain barrel.
 *
 * The canonical domain models — the shared "language" every engine speaks.
 * These are pure business concepts, not database tables, and contain no logic.
 *
 * Conceptual flow:
 *   Metric -> Signal -> Diagnosis -> Constraint -> Strategy -> Action ->
 *   Outcome -> Value -> Learning
 */
export * from "./shared";
export * from "./metric";
export * from "./signal";
export * from "./diagnosis";
export * from "./constraint";
export * from "./strategy";
export * from "./value";
export * from "./workflow";
export * from "./achievement";
export * from "./opportunity";
export * from "./finding";
export * from "./trajectory";
export * from "./root-cause";
export * from "./action";
export * from "./outcome";
export * from "./learning";
