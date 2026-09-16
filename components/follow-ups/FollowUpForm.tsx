"use client";

import { toast } from "sonner";
import { useState, useTransition, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  createFollowUp,
  updateFollowUp,
  completeFollowUp,
  cancelFollowUp,
  getPatientAppointmentsForFollowUp,
  getPatientTreatmentsForFollowUp,
} from "@/actions/follow-ups";
import { searchPatients } from "@/actions/patients";
import { getAvailableSlots } from "@/actions/availability";
import { queryKeys } from "@/lib/query/keys";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { PatientAvatar } from "@/components/shared/PatientAvatar";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import {
  cn,
  followUpDisplayStatus,
  formatDate,
  formatDateTime,
  formatTime,
} from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { CalendarPicker } from "@/components/ui/calendar-picker";
import Link from "next/link";
import { CheckCircle2, X, User, Calendar, Stethoscope, Clock } from "lucide-react";
import { TREATMENT_TYPE_OPTIONS } from "@/types";
import type { FollowUpWithRelations, Patient } from "@/types";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Follow-Up Type options reuse the canonical TREATMENT_TYPE_OPTIONS list
 * (single source of truth shared with the Treatment Type dropdown).
 */
const FOLLOW_UP_TYPE_OPTIONS = TREATMENT_TYPE_OPTIONS;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PatientOption {
  id: string;
  name: string;
  phone: string | null;
}

interface AppointmentOption {
  id: string;
  scheduled_at: string;
  status: string;
}

interface TreatmentOption {
  id: string;
  treatment_type: string;
  status: string;
}

interface FollowUpFormProps {
  followUpId?: string;
  /** Pre-selected patient — skips patient search when set */
  patientId?: string;
  patientName?: string;
  appointmentId?: string;
  treatmentId?: string;
  initialData?: FollowUpWithRelations;
  onSuccess?: () => void;
  role?: "dentist" | "receptionist";
  /**
   * URL to redirect to after successful creation.
   * Defaults to the follow-up detail page.
   */
  successRedirect?: string;
  /**
   * When true, hides the Related Appointment and Related Treatment dropdowns.
   * Used when the form is launched from an appointment context — those
   * relationships are inferred from the URL params, not chosen manually.
   */
  hideRelatedFields?: boolean;
}

// ── Field-level validation errors ────────────────────────────────────────────

interface FormErrors {
  patient?: string;
  followUpType?: string;
  dueDate?: string;
}

// =============================================================================
// FollowUpForm
// =============================================================================

export function FollowUpForm({
  followUpId,
  patientId: prefillPatientId,
  patientName: prefillPatientName,
  appointmentId: prefillAppointmentId,
  treatmentId: prefillTreatmentId,
  initialData,
  onSuccess,
  role = "dentist",
  successRedirect,
  hideRelatedFields = false,
}: FollowUpFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();

  // ── Refs for scroll-to-error ────────────────────────────────────────────────
  const patientRef     = useRef<HTMLDivElement>(null);
  const followUpTypeRef = useRef<HTMLDivElement>(null);
  const dueDateRef     = useRef<HTMLDivElement>(null);

  // ── Form state ──────────────────────────────────────────────────────────────
  const initialIsCustomType =
    !!initialData?.follow_up_type &&
    !(FOLLOW_UP_TYPE_OPTIONS as readonly string[]).includes(
      initialData.follow_up_type
    );

  const [followUpType, setFollowUpType] = useState(
    initialData?.follow_up_type ?? ""
  );
  const [showCustomFollowUpType, setShowCustomFollowUpType] = useState(
    initialIsCustomType
  );
  const [customFollowUpType, setCustomFollowUpType] = useState(
    initialIsCustomType ? (initialData?.follow_up_type ?? "") : ""
  );
  const [dueDate, setDueDate]   = useState(initialData?.due_date ?? "");
  const [dueTime, setDueTime]   = useState("");
  const [confirmationStatus, setConfirmationStatus] = useState<"tentative" | "confirmed">(
    (initialData?.confirmation_status as "tentative" | "confirmed") ?? "confirmed"
  );
  const [slots, setSlots]             = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [notes, setNotes]       = useState(initialData?.notes ?? "");
  const [formError, setFormError]     = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});

  // ── Patient selection ───────────────────────────────────────────────────────
  const resolvedInitialPatient: PatientOption | null = initialData?.patient
    ? { id: initialData.patient.id, name: initialData.patient.name, phone: initialData.patient.phone ?? null }
    : prefillPatientId && prefillPatientName
      ? { id: prefillPatientId, name: prefillPatientName, phone: null }
      : prefillPatientId
        ? { id: prefillPatientId, name: "Loading…", phone: null }
        : null;

  const [selectedPatient, setSelectedPatient] = useState<PatientOption | null>(
    resolvedInitialPatient
  );
  const [patientQuery, setPatientQuery]       = useState(resolvedInitialPatient?.name ?? "");
  const [patientResults, setPatientResults]   = useState<Patient[]>([]);
  const [patientDropOpen, setPatientDropOpen] = useState(false);
  const [patientLoading, setPatientLoading]   = useState(false);
  const patientSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Related appointment & treatment dropdowns ───────────────────────────────
  const [selectedAppointmentId, setSelectedAppointmentId] = useState(
    prefillAppointmentId ?? initialData?.appointment_id ?? ""
  );
  const [selectedTreatmentId, setSelectedTreatmentId] = useState(
    prefillTreatmentId ?? initialData?.treatment_id ?? ""
  );
  const [appointmentOptions, setAppointmentOptions] = useState<AppointmentOption[]>([]);
  const [treatmentOptions, setTreatmentOptions]     = useState<TreatmentOption[]>([]);
  const [loadingRelated, setLoadingRelated]         = useState(false);
  const [relatedError, setRelatedError]             = useState<string | null>(null);

  // ── Action dialogs ──────────────────────────────────────────────────────────
  const currentStatus = initialData?.status ?? null;
  const isPendingStatus = currentStatus === "pending";
  // CREATE-only. Lets a back-entered / historical follow-up be recorded as
  // already resolved, rather than being forced through "pending" — which, for
  // a past due_date, immediately (and wrongly) reads as overdue. Unused in
  // edit mode: an existing follow-up's status changes through Complete /
  // Cancel, not by re-picking it here.
  const [initialStatus, setInitialStatus] =
    useState<"pending" | "completed" | "cancelled">("pending");
  const isDentist  = role === "dentist";
  const [confirmAction, setConfirmAction]           = useState<"complete" | "cancel" | null>(null);
  const [isActioning, startActionTransition]        = useTransition();

  // ── Load related records whenever patient changes ───────────────────────────
  const loadRelatedOptions = useCallback(async (pid: string) => {
    if (!pid) {
      setAppointmentOptions([]);
      setTreatmentOptions([]);
      return;
    }
    setLoadingRelated(true);
    setRelatedError(null);
    try {
      const [apptResult, txResult] = await Promise.all([
        getPatientAppointmentsForFollowUp(pid),
        getPatientTreatmentsForFollowUp(pid),
      ]);
      setAppointmentOptions((apptResult.data ?? []) as AppointmentOption[]);
      setTreatmentOptions((txResult.data ?? []) as TreatmentOption[]);
      if (txResult.error) setRelatedError(txResult.error);
    } catch {
      setRelatedError("Could not load related records.");
      setAppointmentOptions([]);
      setTreatmentOptions([]);
    } finally {
      setLoadingRelated(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPatient?.id && !hideRelatedFields) {
      loadRelatedOptions(selectedPatient.id);
    }
  }, [selectedPatient?.id, loadRelatedOptions, hideRelatedFields]);

  // ── Available appointment slots for the chosen due date (create mode) ──────
  // Reuses the same scheduling engine as appointment booking (getAvailableSlots)
  // so follow-up appointments can only be booked into genuinely free slots that
  // respect working hours, lunch/consultancy blocks, holidays, and existing
  // appointments. No duplicate scheduling logic.
  const fetchSlots = useCallback(async (date: string) => {
    if (!date) {
      setSlots([]);
      return;
    }
    setSlotsLoading(true);
    setDueTime("");
    const result = await getAvailableSlots(date);
    setSlots(result.data ?? []);
    setSlotsLoading(false);
  }, []);

  useEffect(() => {
    // Only relevant when creating — editing does not re-book the appointment.
    if (!followUpId && dueDate) fetchSlots(dueDate);
  }, [dueDate, followUpId, fetchSlots]);

  // ── Sync initialData if editing ─────────────────────────────────────────────
  useEffect(() => {
    if (initialData) {
      const ft = initialData.follow_up_type ?? "";
      const isCustom = !!ft && !(FOLLOW_UP_TYPE_OPTIONS as readonly string[]).includes(ft);
      setFollowUpType(ft);
      setShowCustomFollowUpType(isCustom);
      setCustomFollowUpType(isCustom ? ft : "");
      setDueDate(initialData.due_date);
      setNotes(initialData.notes ?? "");
      if (initialData.appointment_id) setSelectedAppointmentId(initialData.appointment_id);
      if (initialData.treatment_id)   setSelectedTreatmentId(initialData.treatment_id);
    }
  }, [initialData]);

  // ── Patient search ──────────────────────────────────────────────────────────
  const handlePatientQueryChange = useCallback(
    (value: string) => {
      setPatientQuery(value);
      setSelectedPatient(null);
      setSelectedAppointmentId("");
      setSelectedTreatmentId("");
      setAppointmentOptions([]);
      setTreatmentOptions([]);
      setRelatedError(null);
      setFieldErrors((prev) => ({ ...prev, patient: undefined }));

      if (patientSearchTimerRef.current) {
        clearTimeout(patientSearchTimerRef.current);
        patientSearchTimerRef.current = null;
      }

      if (value.trim().length < 2) {
        setPatientResults([]);
        setPatientDropOpen(false);
        return;
      }

      patientSearchTimerRef.current = setTimeout(async () => {
        setPatientLoading(true);
        const result = await searchPatients(value.trim());
        setPatientResults(result.data ?? []);
        setPatientDropOpen(true);
        setPatientLoading(false);
      }, 300);
    },
    []
  );

  function handleSelectPatient(p: Patient) {
    setSelectedPatient({ id: p.id, name: p.name, phone: p.phone ?? null });
    setPatientQuery(p.name);
    setPatientResults([]);
    setPatientDropOpen(false);
    setSelectedAppointmentId("");
    setSelectedTreatmentId("");
    setFieldErrors((prev) => ({ ...prev, patient: undefined }));
  }

  // ── Field validation ────────────────────────────────────────────────────────
  function validate(): boolean {
    const errors: FormErrors = {};
    const patId = selectedPatient?.id ?? initialData?.patient_id ?? "";

    if (!patId) errors.patient = "Please select a patient.";
    if (!followUpType) errors.followUpType = "Please select a follow-up type.";
    if (!dueDate) errors.dueDate = "Due date is required.";

    setFieldErrors(errors);

    if (Object.keys(errors).length > 0) {
      // Scroll to first invalid field
      if (errors.patient) {
        patientRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        patientRef.current?.querySelector("input")?.focus();
      } else if (errors.followUpType) {
        followUpTypeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        followUpTypeRef.current?.querySelector("select")?.focus();
      } else if (errors.dueDate) {
        dueDateRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        dueDateRef.current?.querySelector("button")?.focus();
      }
      return false;
    }
    return true;
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);

    if (!validate()) return;

    const patId = selectedPatient?.id ?? initialData?.patient_id ?? "";

    const input = {
      patient_id:     patId,
      follow_up_type: followUpType,
      appointment_id: selectedAppointmentId || undefined,
      treatment_id:   selectedTreatmentId   || undefined,
      due_date:       dueDate,
      due_time:       dueTime || undefined,
      confirmation_status: confirmationStatus,
      notes:          notes.trim() || undefined,
      ...(followUpId ? {} : { status: initialStatus }),
    };

    startTransition(async () => {
      const result = followUpId
        ? await updateFollowUp(followUpId, input)
        : await createFollowUp(input);

      if (result.error) {
        setFormError(result.error);
        return;
      }

      setFormSuccess(followUpId ? "Follow-up updated." : "Follow-up created.");
      const bookingNotice = followUpId ? undefined : (result.data as { bookingNotice?: string } | null)?.bookingNotice;
      if (bookingNotice) toast.warning(bookingNotice);

      // Invalidate only the follow-ups cache.
      queryClient.invalidateQueries({ queryKey: queryKeys.followUps.all });

      // Modal mode: let the host dialog handle closing + refreshing. Skips
      // page navigation so the user stays on the current page.
      if (onSuccess) {
        onSuccess();
        return;
      }

      if (!followUpId && result.data) {
        // Task 8 fix — when the follow-up was launched from an appointment and
        // a (new or linked) appointment is attached, navigate to that
        // appointment's detail page so the newly created/linked appointment and
        // its follow-up are immediately visible. router.refresh() guarantees the
        // server components re-fetch without a manual reload.
        const launchedFromAppointment = !!prefillAppointmentId;
        const linkedApptId = result.data.appointment_id;
        const target =
          launchedFromAppointment && linkedApptId
            ? `/dentist/appointments/${linkedApptId}`
            : successRedirect ?? `/dentist/follow-ups/${result.data.id}`;
        router.push(target);
        return;
      }

      // Edit mode without a modal host: stay on the page (success message +
      // cache invalidation already applied above).
    });
  }

  // ── Complete / Cancel action ─────────────────────────────────────────────────
  function handleConfirm() {
    if (!followUpId || !confirmAction) return;
    setFormError(null);
    startActionTransition(async () => {
      const result =
        confirmAction === "complete"
          ? await completeFollowUp(followUpId)
          : await cancelFollowUp(followUpId);
      setConfirmAction(null);
      if (result.error) {
        setFormError(result.error);
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.followUps.all });
    });
  }

  const isEditable = !currentStatus || currentStatus === "pending";
  const isReadOnly = !isEditable || isPending;
  const patientLocked = !!followUpId;

  return (
    <>
      <div className="bg-surface border border-border rounded-xl overflow-hidden max-w-2xl">

        {/* ── Header (edit mode only) ── */}
        {currentStatus && (
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Follow-up Appointment Details</h2>
            {(() => {
              // Clinic-local badge for a loaded follow-up: resolve `pending` to
              // Overdue / Due today / Upcoming by its stored due date.
              const todayStr = new Intl.DateTimeFormat("en-CA").format(new Date());
              const d = followUpDisplayStatus(currentStatus, initialData?.due_date ?? dueDate, todayStr);
              return <StatusBadge label={d.label} variant={d.variant} />;
            })()}
          </div>
        )}

        <div className="px-6 py-5 space-y-5">
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>

            {/* ── Patient ── */}
            <div ref={patientRef}>
              <Field
                label="Patient"
                htmlFor="patient_search"
                required
                error={fieldErrors.patient}
                hint={patientLocked ? undefined : "Search by name or phone number"}
              >
              {patientLocked ? (
                <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <PatientAvatar
                    name={selectedPatient?.name ?? initialData?.patient?.name ?? "?"}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {selectedPatient?.name ?? initialData?.patient?.name ?? "Unknown patient"}
                    </p>
                    {(selectedPatient?.phone ?? initialData?.patient?.phone) && (
                      <p className="text-xs text-text-secondary">
                        {selectedPatient?.phone ?? initialData?.patient?.phone}
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/dentist/patients/${selectedPatient?.id ?? initialData?.patient_id}`}
                    className="text-xs text-info hover:underline shrink-0"
                    tabIndex={-1}
                  >
                    View
                  </Link>
                </div>
              ) : (
                <div className="relative">
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">
                      <User className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    <Input
                      id="patient_search"
                      type="search"
                      value={patientQuery}
                      onChange={(e) => handlePatientQueryChange(e.target.value)}
                      placeholder="Search by name or phone…"
                      autoComplete="off"
                      disabled={isReadOnly}
                      hasError={!!fieldErrors.patient}
                      className="pl-9"
                      onBlur={() => setTimeout(() => setPatientDropOpen(false), 150)}
                      onFocus={() => patientResults.length > 0 && setPatientDropOpen(true)}
                    />
                    {patientLoading && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2">
                        <LoadingSpinner size="sm" />
                      </span>
                    )}
                  </div>
                  {selectedPatient && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                      <PatientAvatar name={selectedPatient.name} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary">{selectedPatient.name}</p>
                        {selectedPatient.phone && (
                          <p className="text-xs text-text-secondary">{selectedPatient.phone}</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedPatient(null);
                          setPatientQuery("");
                          setSelectedAppointmentId("");
                          setSelectedTreatmentId("");
                          setAppointmentOptions([]);
                          setTreatmentOptions([]);
                          setRelatedError(null);
                        }}
                        className="text-text-secondary hover:text-text-primary transition-colors"
                        aria-label="Clear patient selection"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {patientDropOpen && patientResults.length > 0 && (
                    <ul className="absolute z-20 w-full mt-1 bg-surface border border-border rounded-xl shadow-lg max-h-60 overflow-y-auto">
                      {patientResults.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleSelectPatient(p)}
                            className="w-full px-4 py-2.5 text-left hover:bg-background flex items-center gap-3 transition-colors"
                          >
                            <PatientAvatar name={p.name} size="sm" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-text-primary truncate">{p.name}</p>
                              {p.phone && <p className="text-xs text-text-secondary">{p.phone}</p>}
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {patientDropOpen && !patientLoading && patientQuery.trim().length >= 2 && patientResults.length === 0 && (
                    <div className="absolute z-20 w-full mt-1 bg-surface border border-border rounded-xl shadow-lg p-4">
                      <p className="text-sm text-text-secondary text-center">No patients found</p>
                    </div>
                  )}
                </div>
              )}
              </Field>
            </div>

            {/* ── Follow-Up Type + Due Date + Due Time ── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div ref={followUpTypeRef}>
                <Field label="Follow-Up Type" htmlFor="follow_up_type" required error={fieldErrors.followUpType}>
                  <Select
                    id="follow_up_type"
                    value={showCustomFollowUpType ? "__other__" : followUpType}
                    onChange={(e) => {
                      const val = e.target.value;
                      setFieldErrors((prev) => ({ ...prev, followUpType: undefined }));
                      if (val === "__other__") {
                        setShowCustomFollowUpType(true);
                        setCustomFollowUpType("");
                        setFollowUpType("");
                      } else {
                        setShowCustomFollowUpType(false);
                        setCustomFollowUpType("");
                        setFollowUpType(val);
                      }
                    }}
                    disabled={isReadOnly}
                    hasError={!!fieldErrors.followUpType}
                  >
                    <option value="" disabled>Select type…</option>
                    {FOLLOW_UP_TYPE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                    <option value="__other__">Other</option>
                  </Select>
                  {showCustomFollowUpType && (
                    <Input
                      id="follow_up_type_custom"
                      type="text"
                      className="mt-2"
                      placeholder="Describe the follow-up type…"
                      value={customFollowUpType}
                      onChange={(e) => {
                        setCustomFollowUpType(e.target.value);
                        setFollowUpType(e.target.value);
                        setFieldErrors((prev) => ({ ...prev, followUpType: undefined }));
                      }}
                      disabled={isReadOnly}
                      hasError={!!fieldErrors.followUpType}
                      autoFocus
                    />
                  )}
                </Field>
              </div>

              <div ref={dueDateRef}>
                <Field label="Due Date" htmlFor="due_date" required error={fieldErrors.dueDate}>
                  <CalendarPicker
                    id="due_date"
                    value={dueDate}
                    onChange={(d) => {
                      setDueDate(d ?? "");
                      setFieldErrors((prev) => ({ ...prev, dueDate: undefined }));
                    }}
                    disabled={isReadOnly}
                    placeholder="Select due date"
                    clearable
                  />
                </Field>
              </div>

              {/* Confirmation status — Tentative / Confirmed segmented control */}
              <Field label="Appointment Status" htmlFor="confirmation_status">
                <div
                  role="radiogroup"
                  aria-label="Appointment status"
                  className="inline-flex rounded-lg border border-border p-0.5 bg-background"
                >
                  {(["tentative", "confirmed"] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={confirmationStatus === opt}
                      disabled={isReadOnly}
                      onClick={() => setConfirmationStatus(opt)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize disabled:opacity-50 disabled:cursor-not-allowed",
                        confirmationStatus === opt
                          ? "bg-surface text-text-primary shadow-sm border border-border"
                          : "text-text-secondary hover:text-text-primary"
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </Field>

              {/* Initial status — CREATE only. Exists for back-entered /
                  historical records: a clinic digitising a recall that already
                  happened (or was cancelled) can say so directly, rather than
                  having every backdated entry forced through Upcoming and
                  immediately read as overdue. */}
              {!followUpId && (
                <Field
                  label="Status"
                  htmlFor="initial_status"
                  hint={
                    initialStatus !== "pending"
                      ? "For a historical record — this due date will not count as overdue."
                      : "Leave as Upcoming for a normal recall."
                  }
                >
                  <div
                    role="radiogroup"
                    aria-label="Initial status"
                    className="inline-flex rounded-lg border border-border p-0.5 bg-background"
                  >
                    {/* Value stays the backend status; only the label changes. */}
                    {([
                      ["pending", "Upcoming"],
                      ["completed", "Completed"],
                      ["cancelled", "Cancelled"],
                    ] as const).map(([opt, label]) => (
                      <button
                        key={opt}
                        type="button"
                        role="radio"
                        aria-checked={initialStatus === opt}
                        onClick={() => setInitialStatus(opt)}
                        className={cn(
                          "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                          initialStatus === opt
                            ? "bg-surface text-text-primary shadow-sm border border-border"
                            : "text-text-secondary hover:text-text-primary"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
            </div>

            {/* ── Appointment Time — available slots only (create mode) ── */}
            {/* Hidden for a historical entry: auto-booking a future appointment
                for a record being logged as already resolved would create a
                phantom visit, so the server skips it — this keeps the UI from
                implying a time picked here does something for that case. */}
            {!followUpId && initialStatus === "pending" && (
              <Field
                label="Appointment Time"
                htmlFor="due_time"
                hint="Optional — pick an available slot to auto-create the next appointment"
              >
                <input type="hidden" id="due_time" value={dueTime} readOnly />
                {!dueDate ? (
                  <p className="text-xs text-text-secondary">Select a due date to see available slots.</p>
                ) : slotsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-text-secondary py-1">
                    <LoadingSpinner size="sm" />
                    Loading available slots…
                  </div>
                ) : slots.length === 0 ? (
                  <div className="rounded-lg bg-background border border-border p-3 text-center">
                    <p className="text-xs text-text-secondary">No available slots on this date.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-44 overflow-y-auto">
                    {slots.map((slot) => {
                      const timePart = slot.split("T")[1]?.slice(0, 5) ?? "";
                      const isSelected = dueTime === timePart;
                      return (
                        <button
                          key={slot}
                          type="button"
                          disabled={isReadOnly}
                          onClick={() => setDueTime(isSelected ? "" : timePart)}
                          className={cn(
                            "flex items-center justify-center gap-1 py-2 px-1 text-xs rounded-lg border transition-all",
                            isSelected
                              ? "border-accent bg-accent text-accent-foreground font-medium"
                              : "border-border text-text-primary hover:border-border-strong hover:bg-background",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          <Clock className="h-3 w-3 opacity-60" aria-hidden />
                          {formatTime(`${timePart}:00`)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Field>
            )}

            {/* ── Optional: Related Appointment + Related Treatment ── */}
            {/* Hidden when hideRelatedFields=true (launched from appointment context) */}
            {!hideRelatedFields && (
              <>
                <Field
                  label="Related Appointment"
                  htmlFor="appointment_id"
                  hint="Optional — link to the appointment that prompted this follow-up"
                >
                  {loadingRelated ? (
                    <div className="flex items-center gap-2 h-9 text-sm text-text-secondary">
                      <LoadingSpinner size="sm" />
                      <span>Loading appointments…</span>
                    </div>
                  ) : (
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">
                        <Calendar className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <Select
                        id="appointment_id"
                        value={selectedAppointmentId}
                        onChange={(e) => setSelectedAppointmentId(e.target.value)}
                        disabled={isReadOnly || (!selectedPatient && !patientLocked)}
                        className="pl-9"
                      >
                        <option value="">None</option>
                        {appointmentOptions.map((appt) => (
                          <option key={appt.id} value={appt.id}>
                            {formatDateTime(appt.scheduled_at)} — {appt.status}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                </Field>

                <Field
                  label="Related Treatment"
                  htmlFor="treatment_id"
                  hint="Optional — link to the specific treatment this follow-up is for"
                >
                  {loadingRelated ? (
                    <div className="flex items-center gap-2 h-9 text-sm text-text-secondary">
                      <LoadingSpinner size="sm" />
                      <span>Loading treatments…</span>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">
                          <Stethoscope className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <Select
                          id="treatment_id"
                          value={selectedTreatmentId}
                          onChange={(e) => setSelectedTreatmentId(e.target.value)}
                          disabled={isReadOnly || (!selectedPatient && !patientLocked)}
                          className="pl-9"
                        >
                          <option value="">None</option>
                          {treatmentOptions.map((tx) => (
                            <option key={tx.id} value={tx.id}>
                              {tx.treatment_type} — {tx.status}
                            </option>
                          ))}
                        </Select>
                      </div>
                      {relatedError && (
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-danger">{relatedError}</p>
                          {selectedPatient?.id && (
                            <button
                              type="button"
                              onClick={() => loadRelatedOptions(selectedPatient.id)}
                              className="text-xs text-info hover:underline"
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      )}
                      {!relatedError && selectedPatient && treatmentOptions.length === 0 && !loadingRelated && (
                        <p className="text-xs text-text-secondary">No treatments on record for this patient.</p>
                      )}
                    </div>
                  )}
                </Field>
              </>
            )}

            {/* ── Notes ── */}
            <Field
              label="Notes"
              htmlFor="notes"
              hint="Additional context or instructions for this follow-up"
            >
              <Textarea
                id="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={isReadOnly}
                placeholder="e.g. Check healing after root canal, patient reported discomfort last visit…"
              />
            </Field>

            {/* ── Metadata (edit mode) ── */}
            {followUpId && initialData && (
              <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary pt-1 border-t border-border">
                <div>
                  <span className="block font-medium text-text-primary mb-0.5">Created</span>
                  {formatDate(initialData.created_at)}
                </div>
                {initialData.updated_at !== initialData.created_at && (
                  <div>
                    <span className="block font-medium text-text-primary mb-0.5">Last Updated</span>
                    {formatDate(initialData.updated_at)}
                  </div>
                )}
              </div>
            )}

            {/* ── Server error ── */}
            {formError && (
              <div
                role="alert"
                className="rounded-lg bg-danger-bg border border-danger-border px-4 py-3 text-xs text-danger"
              >
                {formError}
              </div>
            )}
            {formSuccess && (
              <div
                role="status"
                className="rounded-lg bg-success-bg border border-success-border px-4 py-3 text-xs text-success flex items-center gap-2"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                {formSuccess}
              </div>
            )}

            {/* ── Actions ── */}
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              {isEditable && (
                <Button
                  type="submit"
                  size="sm"
                  disabled={isReadOnly}
                  isLoading={isPending}
                >
                  {isPending
                    ? "Saving…"
                    : followUpId
                      ? "Save Changes"
                      : "Create Follow-up Appointment"}
                </Button>
              )}

              {isDentist && followUpId && isPendingStatus && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setConfirmAction("complete")}
                    disabled={isActioning}
                    className="bg-success hover:bg-success-hover"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    Mark Complete
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmAction("cancel")}
                    disabled={isActioning}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                    Cancel Follow-Up
                  </Button>
                </>
              )}
            </div>
          </form>
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={
          confirmAction === "complete"
            ? "Mark Follow-Up as Complete?"
            : "Cancel Follow-Up?"
        }
        description={
          confirmAction === "complete"
            ? "This will mark the follow-up as completed. This action cannot be undone."
            : "This will cancel the follow-up. This action cannot be undone."
        }
        confirmLabel={confirmAction === "complete" ? "Mark Complete" : "Cancel Follow-Up"}
        variant={confirmAction === "cancel" ? "danger" : "default"}
        cancelLabel="Go Back"
        onConfirm={handleConfirm}
        onCancel={() => setConfirmAction(null)}
        isLoading={isActioning}
      />
    </>
  );
}
