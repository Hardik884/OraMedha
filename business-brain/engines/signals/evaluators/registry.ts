/**
 * Business Brain — Signal Engine: evaluator registry
 *
 * The single list of every signal rule. Adding a signal is one new file plus one
 * entry here; nothing else in the engine changes.
 *
 * Registry order does not affect output — the engine applies a canonical sort.
 */

import { acceptedTreatmentsUnscheduledEvaluator } from "./clinical/accepted-treatments-unscheduled";
import { largePendingTreatmentValueEvaluator } from "./clinical/large-pending-treatment-value";
import { pipelineStalledEvaluator } from "./clinical/pipeline-stalled";
import { collectionLaggingCompletionsEvaluator } from "./financial/collection-lagging-completions";
import { collectionRateLowEvaluator } from "./financial/collection-rate-low";
import { highOutstandingEvaluator } from "./financial/high-outstanding";
import { lowDailyRevenueEvaluator } from "./financial/low-daily-revenue";
import { outstandingIncreasingEvaluator } from "./financial/outstanding-increasing";
import { longWaitingTimeEvaluator } from "./operational/long-waiting-time";
import { lowChairUtilizationEvaluator } from "./operational/low-chair-utilization";
import { sustainedLowUtilizationEvaluator } from "./operational/sustained-low-utilization";
import { nearFullCapacityEvaluator } from "./operational/near-full-capacity";
import { queueBacklogEvaluator } from "./operational/queue-backlog";
import { queueBuildingUpEvaluator } from "./operational/queue-building-up";
import { followupBacklogEvaluator } from "./retention/followup-backlog";
import { lapsedPatientBaseEvaluator } from "./retention/lapsed-patient-base";
import { lowNewPatientsEvaluator } from "./retention/low-new-patients";
import { returningVolumeDroppingEvaluator } from "./retention/returning-volume-dropping";
import { highCancellationRateEvaluator } from "./scheduling/high-cancellation-rate";
import { highNoShowRateEvaluator } from "./scheduling/high-no-show-rate";
import { lowAppointmentVolumeEvaluator } from "./scheduling/low-appointment-volume";
import { thinWeekAheadEvaluator } from "./scheduling/thin-week-ahead";
import { repeatNonAttendanceEvaluator } from "./scheduling/repeat-non-attendance";
import { appointmentsOverrunningEvaluator } from "./scheduling/appointments-overrunning";
import { sustainedAttritionEvaluator } from "./scheduling/sustained-attrition";
import { longBookingLeadTimeEvaluator } from "./scheduling/long-booking-lead-time";
import type { SignalEvaluator } from "./types";

/** Every registered signal evaluator. */
export const EVALUATORS: readonly SignalEvaluator[] = [
  // Financial
  lowDailyRevenueEvaluator,
  highOutstandingEvaluator,
  outstandingIncreasingEvaluator,
  collectionLaggingCompletionsEvaluator,
  collectionRateLowEvaluator,
  // Scheduling
  highCancellationRateEvaluator,
  highNoShowRateEvaluator,
  lowAppointmentVolumeEvaluator,
  thinWeekAheadEvaluator,
  repeatNonAttendanceEvaluator,
  appointmentsOverrunningEvaluator,
  sustainedAttritionEvaluator,
  longBookingLeadTimeEvaluator,
  // Retention / acquisition
  lowNewPatientsEvaluator,
  returningVolumeDroppingEvaluator,
  followupBacklogEvaluator,
  lapsedPatientBaseEvaluator,
  // Operational
  longWaitingTimeEvaluator,
  queueBacklogEvaluator,
  queueBuildingUpEvaluator,
  lowChairUtilizationEvaluator,
  sustainedLowUtilizationEvaluator,
  nearFullCapacityEvaluator,
  // Clinical
  largePendingTreatmentValueEvaluator,
  acceptedTreatmentsUnscheduledEvaluator,
  pipelineStalledEvaluator,
];
