/**
 * Business Brain — Opportunity Engine barrel.
 *
 * Measured surplus × measured demand, from the clinic ledger. Pure: the service
 * reads the ledger through its port and hands the graphs in.
 */
export { deriveOpportunities, type OpportunityEngineInput, type OpportunityResult } from "./opportunity-engine";
export {
  DEFAULT_OPPORTUNITY_CONFIG,
  resolveOpportunityConfig,
  type OpportunityConfig,
} from "./opportunity-config";
export { gapsForDay, type DayGaps } from "./capacity-gaps";
export { owingPatients, waitingDemand, type DemandPopulation, type WaitingPatient } from "./demand";
