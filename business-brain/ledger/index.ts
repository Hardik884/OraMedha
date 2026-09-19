/**
 * Business Brain — Clinic Ledger barrel.
 *
 * The relational half of the intelligence layer: fact types, the port that
 * supplies them, what the schema can and cannot record, and the pure graph that
 * walks them. The Supabase adapter lives in `lib/business-brain/clinic-ledger.ts`.
 */
export * from "./ledger-facts";
export * from "./ledger-capabilities";
export * from "./clinic-ledger-port";
export * from "./ledger-graph";
export * from "./action-history";
export * from "./record-evidence";
export * from "./record-quality";
