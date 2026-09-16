/**
 * Business Brain — Diagnosis Engine: matcher registry
 *
 * The single list of every correlation rule. Adding a pattern is one new file
 * plus one entry here; nothing else in the engine changes.
 *
 * Registry order does not affect output — the engine applies a canonical sort by
 * pattern. It does determine which signals count as "claimed" before the
 * unclustered pass, which is why that pass runs separately and last.
 *
 * `unclustered_signal` is deliberately NOT in this array: it takes a second
 * argument (what the others claimed) and can emit several diagnoses per day, so it
 * does not fit the uniform matcher shape.
 */

import { collectionGapMatcher } from "./financial/collection-gap";
import { revenueShortfallMatcher } from "./financial/revenue-shortfall";
import { outstandingReceivablesMatcher } from "./financial/outstanding-receivables";
import { productionCollectionGapMatcher } from "./financial/production-collection-gap";
import { pipelineConversionFailureMatcher } from "./clinical/pipeline-conversion-failure";
import { capacityCeilingMatcher } from "./operational/capacity-ceiling";
import { demandSupplyMismatchMatcher } from "./operational/demand-supply-mismatch";
import { throughputCongestionMatcher } from "./operational/throughput-congestion";
import { sustainedIdleCapacityMatcher } from "./operational/sustained-idle-capacity";
import { patientBaseErosionMatcher } from "./retention/patient-base-erosion";
import { recallProcessFailureMatcher } from "./retention/recall-process-failure";
import { recallBacklogMatcher } from "./retention/recall-backlog";
import { dormantPatientBaseMatcher } from "./retention/dormant-patient-base";
import { acquisitionShortfallMatcher } from "./acquisition/acquisition-shortfall";
import { scheduleAttritionMatcher } from "./scheduling/schedule-attrition";
import { forwardScheduleGapMatcher } from "./scheduling/forward-schedule-gap";
import { repeatNonAttendanceMatcher } from "./scheduling/repeat-non-attendance";
import { chronicAppointmentOverrunMatcher } from "./scheduling/chronic-appointment-overrun";
import type { PatternMatcher } from "./types";

/** Every registered pattern matcher. */
export const MATCHERS: readonly PatternMatcher[] = [
  // Operational
  demandSupplyMismatchMatcher,
  throughputCongestionMatcher,
  capacityCeilingMatcher,
  sustainedIdleCapacityMatcher,
  // Scheduling
  scheduleAttritionMatcher,
  forwardScheduleGapMatcher,
  repeatNonAttendanceMatcher,
  chronicAppointmentOverrunMatcher,
  // Financial
  collectionGapMatcher,
  revenueShortfallMatcher,
  outstandingReceivablesMatcher,
  productionCollectionGapMatcher,
  // Clinical
  pipelineConversionFailureMatcher,
  // Retention
  patientBaseErosionMatcher,
  recallProcessFailureMatcher,
  recallBacklogMatcher,
  dormantPatientBaseMatcher,
  // Acquisition
  acquisitionShortfallMatcher,
];
