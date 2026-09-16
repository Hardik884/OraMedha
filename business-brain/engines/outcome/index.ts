/**
 * Business Brain — Outcome Engine barrel.
 *
 * The first stage past Action: what the clinic's own data says followed a
 * completed action. Deterministic, pure, and capped at "observed after" — it
 * states the sequence and never the cause.
 */
export * from "./outcome-catalog";
export * from "./outcome-engine";
export * from "./attribution";
export * from "./resolution";
