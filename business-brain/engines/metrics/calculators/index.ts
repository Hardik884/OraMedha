/**
 * Metrics Engine — Calculator registry
 *
 * A calculator is a pure function that turns a snapshot into one Metric. The
 * engine runs every calculator in this list. Adding a new metric = write a
 * calculator and append it here.
 */

import type { Metric } from "../../../domain";
import type { ClinicDataSnapshot } from "../../../repositories";

import {
  totalAppointmentsToday,
  cancelledAppointmentsToday,
  noShowsToday,
} from "./appointment-metrics";
import {
  newPatientsToday,
  returningPatientsToday,
  reactivationCandidates,
} from "./patient-metrics";
import {
  revenueCollectedToday,
  outstandingPayments,
  outstandingOnPaymentPlan,
  pendingTreatmentValue,
  production30d,
  collectionRate30d,
  collected30d,
} from "./revenue-metrics";
import { patientsWaiting, averageWaitingTime } from "./queue-metrics";
import { followUpsDueToday, overdueFollowUps } from "./follow-up-metrics";
import {
  acceptedTreatmentsPendingScheduling,
  treatmentsCompletedToday,
  averageCaseValue30d,
} from "./treatment-metrics";
import {
  chairUtilization,
  availableSlotsToday,
  chairUtilization30d,
  bookedNext7d,
  openMinutesToday,
  appointmentCapacityToday,
} from "./capacity-metrics";
import {
  appointments30d,
  cancellationRate30d,
  noShowRate30d,
  repeatNonAttenders30d,
  bookingLeadTimeDays,
  appointmentOverrun30d,
  measuredVisits30d,
} from "./scheduling-metrics";

/**
 * A pure metric calculator: snapshot in, one Metric out.
 *
 * Returning `null` means "not measurable from this snapshot" — the input needed
 * to compute it honestly is absent. That is different from a calculator
 * throwing (a defect, logged as a failure) and different again from a value of
 * zero (a real measurement). The engine omits withheld metrics, so downstream
 * evaluators skip and record that they could not measure, rather than reasoning
 * over a fabricated number.
 */
export type MetricCalculator = (snapshot: ClinicDataSnapshot) => Metric | null;

/** The ordered set of all metric calculators the engine runs. */
export const METRIC_CALCULATORS: readonly MetricCalculator[] = [
  // Appointments
  totalAppointmentsToday,
  cancelledAppointmentsToday,
  noShowsToday,
  // Scheduling (trailing window)
  appointments30d,
  cancellationRate30d,
  noShowRate30d,
  repeatNonAttenders30d,
  bookingLeadTimeDays,
  appointmentOverrun30d,
  measuredVisits30d,
  // Patients
  newPatientsToday,
  returningPatientsToday,
  reactivationCandidates,
  // Revenue
  revenueCollectedToday,
  outstandingPayments,
  outstandingOnPaymentPlan,
  pendingTreatmentValue,
  production30d,
  collectionRate30d,
  collected30d,
  // Queue
  patientsWaiting,
  averageWaitingTime,
  // Follow-ups
  followUpsDueToday,
  overdueFollowUps,
  // Treatment
  acceptedTreatmentsPendingScheduling,
  treatmentsCompletedToday,
  averageCaseValue30d,
  // Capacity
  chairUtilization,
  availableSlotsToday,
  chairUtilization30d,
  bookedNext7d,
  openMinutesToday,
  appointmentCapacityToday,
];

export * from "./appointment-metrics";
export * from "./patient-metrics";
export * from "./revenue-metrics";
export * from "./queue-metrics";
export * from "./follow-up-metrics";
export * from "./treatment-metrics";
export * from "./capacity-metrics";
export * from "./scheduling-metrics";
export * from "../support/windows";
