"use client";

import { useEffect, useState, useTransition } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  CreateTreatmentSchema,
  UpdateTreatmentSchema,
  type CreateTreatmentInput,
  type UpdateTreatmentInput,
  type Treatment,
  TreatmentStatus,
  DOSAGE_OPTIONS,
  TREATMENT_TYPE_OPTIONS,
  MEDICATION_INSTRUCTION_OPTIONS,
} from "@/types";
import {
  createTreatment,
  getTreatment,
  updateTreatment,
  getCurrentUserDisplayName,
} from "@/actions/treatments";
import { getConsultants } from "@/actions/consultants";
import { getClinicSettings } from "@/actions/clinic-settings";
import { getPatientAppointmentsForFollowUp } from "@/actions/follow-ups";
import type { Consultant } from "@/types";
import { computeConsultantSplit } from "@/lib/billing/revenue";
import {
  TREATMENT_STATUS_LABELS,
  APPOINTMENT_STATUS_LABELS,
  formatCurrency,
  formatDateTime,
  cn,
} from "@/lib/utils";
import { queryKeys } from "@/lib/query/keys";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SkeletonCard } from "@/components/ui/skeleton";
import { CalendarPicker } from "@/components/ui/calendar-picker";
import { Eye, Plus, Trash2, Minus, Pill, Briefcase, ScanLine } from "lucide-react";
import { TreatmentConsentSection, type ConsentConfig } from "@/components/consent/TreatmentConsentSection";
import { createConsent } from "@/actions/consents";

interface TreatmentFormProps {
  treatmentId?: string;
  appointmentId?: string;
  patientId?: string;
  onSuccess?: (treatment: Treatment) => void;
  /** When provided, renders a Cancel button that calls this instead of router.back() (modal use). */
  onCancel?: () => void;
  /**
   * Dental Chart linkage — set when this form was launched from a tooth's
   * "Add Treatment" action (Dental Chart tab/section). Prefills the hidden
   * tooth_number/dentition_type fields so the saved treatment is linked to
   * that tooth automatically; shown to the dentist as a small read-only
   * badge rather than an editable field, since the tooth was already chosen
   * by clicking it on the chart. Not shown/used for ordinary treatment
   * creation, which continues to work exactly as before (no tooth link).
   */
  toothNumber?: number;
  dentitionType?: "adult" | "primary";
}

/** Split an ISO datetime string into its "YYYY-MM-DD" and "HH:mm" parts. */
function splitDatetime(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const [datePart, timePart = ""] = iso.split("T");
  return { date: datePart ?? "", time: timePart.slice(0, 5) };
}

export function TreatmentForm({
  treatmentId,
  appointmentId,
  patientId,
  onSuccess,
  onCancel,
  toothNumber,
  dentitionType,
}: TreatmentFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!treatmentId);

  const [performedDate, setPerformedDate] = useState("");
  const [performedTime, setPerformedTime] = useState("");

  // Consultant directory for the "Performed By" dropdown
  const [consultants, setConsultants] = useState<Consultant[]>([]);
  // Logged-in dentist's name — labels the default "Performed By" option.
  const [dentistName, setDentistName] = useState<string | null>(null);
  // Whether the clinic has X-ray charges enabled (defaults true while loading).
  const [xrayEnabled, setXrayEnabled] = useState(true);
  const [opdFee, setOpdFee] = useState<number | null>(null);
  // Patient Consent Forms is a per-clinic pilot rollout (clinic_settings.
  // consent_forms_enabled). Defaults false while loading so the section never
  // flashes on for a clinic where it's off.
  const [consentFormsEnabled, setConsentFormsEnabled] = useState(false);

  const isEdit = !!treatmentId;

  // When launched from the Patient tab (patientId only, no appointmentId — e.g.
  // Patient profile > Add Treatment), there is no appointment to attach the
  // treatment to. A treatment must belong to one (CreateTreatmentSchema
  // requires appointment_id), so the caller has to pick one here instead of
  // the submit silently failing zod validation with "Please select an
  // appointment" and no way to act on it.
  const needsAppointmentPicker = !isEdit && !appointmentId && !!patientId;
  const [patientAppointments, setPatientAppointments] = useState<
    Array<{ id: string; scheduled_at: string; status: string }>
  >([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(needsAppointmentPicker);
  const schema = isEdit ? UpdateTreatmentSchema : CreateTreatmentSchema;

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateTreatmentInput | UpdateTreatmentInput>({
    resolver: zodResolver(schema),
    defaultValues: {
      appointment_id: appointmentId ?? "",
      patient_id: patientId ?? "",
      treatment_type: "",
      patient_visible_notes: "",
      medications: [],
      cost: undefined,
      status: TreatmentStatus.PLANNED,
      opd_charged: false,
      xray_taken: false,
      xray_cost: null,
      performed_at: undefined,
      consultant_id: "",
      commission_type: undefined,
      commission_value: undefined,
      tooth_number: toothNumber,
      dentition_type: dentitionType,
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: "medications" as never,
  });

  // Watched values used to preserve legacy/free-text dropdown selections so
  // editing older records never silently rewrites them.
  const treatmentTypeValue = watch("treatment_type") as string | undefined;
  const medicationValues = watch("medications") as
    | Array<{ dosage?: string; instructions?: string }>
    | undefined;

  // ── X-ray toggle ─────────────────────────────────────────────────────────────
  const xrayTakenValue = watch("xray_taken") as boolean | undefined;
  const opdChargedValue = watch("opd_charged") as boolean | undefined;

  // "Performed At" may be any historical date so migrated records can be
  // logged accurately. Future dates remain blocked (a treatment cannot have
  // been performed in the future).
  const performedMax = new Date().toISOString().split("T")[0];

  // ── Revenue distribution (Performed By) ─────────────────────────────────────
  const costValue = watch("cost") as number | undefined;
  const consultantIdValue = watch("consultant_id") as string | undefined;
  const commissionTypeValue = watch("commission_type") as "percentage" | "fixed" | undefined;
  const commissionValueValue = watch("commission_value") as number | undefined;

  const hasConsultant = !!consultantIdValue;
  const split = computeConsultantSplit(
    Number(costValue ?? 0),
    hasConsultant ? commissionTypeValue : null,
    hasConsultant ? Number(commissionValueValue ?? 0) : null
  );

  // "Other" mode — true when the stored value is not one of the preset options.
  // In that case the Select shows "Other" and a free-text input is revealed.
  const isStandardType =
    !treatmentTypeValue ||
    (TREATMENT_TYPE_OPTIONS as readonly string[]).includes(treatmentTypeValue);
  const [showCustomType, setShowCustomType] = useState(!isStandardType);
  const [customTypeValue, setCustomTypeValue] = useState(
    isStandardType ? "" : (treatmentTypeValue ?? "")
  );

  // Inline consent config reported by the TreatmentConsentSection. In create
  // mode a required consent draft is auto-created once the treatment is saved.
  const [consentCfg, setConsentCfg] = useState<ConsentConfig | null>(null);

  // In edit mode the patient isn't a prop — capture it from the loaded
  // treatment so the inline consent section can create/sign/print for it.
  const [loadedPatientId, setLoadedPatientId] = useState<string | undefined>(undefined);
  const effectivePatientId = patientId ?? loadedPatientId;

  // The treatment type actually in effect (preset select value or the free-text
  // "Other" value), used to auto-select the consent template.
  const effectiveTreatmentType = showCustomType ? customTypeValue : (treatmentTypeValue ?? "");

  useEffect(() => {
    let active = true;
    getConsultants().then((res) => {
      if (active && res.data) setConsultants(res.data);
    });
    getCurrentUserDisplayName().then((res) => {
      if (active && res.data) setDentistName(res.data);
    });
    getClinicSettings().then((res) => {
      if (active) {
        // Default is true; only disable when the setting is explicitly false.
        setXrayEnabled(res.data?.enable_xray_charges !== false);
        // Shown so the receptionist can see what turning OPD on will charge.
        // The server resolves the amount independently — this is display only,
        // and the form never sends a fee.
        setOpdFee(
          res.data?.default_opd_fee != null ? Number(res.data.default_opd_fee) : null,
        );
        // Pilot rollout flag — the Consent Form section only renders for a
        // clinic that has it explicitly enabled.
        setConsentFormsEnabled(res.data?.consent_forms_enabled === true);
      }
    });
    if (needsAppointmentPicker && patientId) {
      getPatientAppointmentsForFollowUp(patientId).then((res) => {
        if (active) {
          setPatientAppointments(res.data ?? []);
          setAppointmentsLoading(false);
        }
      });
    }
    return () => {
      active = false;
    };
    // patientId/needsAppointmentPicker are derived from props that don't change
    // across this form instance's lifetime — safe to fetch once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!treatmentId) return;
    getTreatment(treatmentId).then((result) => {
      if (result.data) {
        setLoadedPatientId(result.data.patient_id);
        const { date, time } = splitDatetime(result.data.performed_at);
        setPerformedDate(date);
        setPerformedTime(time);
        const tt = result.data.treatment_type;
        const isStd = (TREATMENT_TYPE_OPTIONS as readonly string[]).includes(tt);
        if (!isStd) {
          setShowCustomType(true);
          setCustomTypeValue(tt);
        }
        reset({
          treatment_type: result.data.treatment_type,
          patient_visible_notes: result.data.patient_visible_notes ?? "",
          medications: Array.isArray(result.data.medications)
            ? (result.data.medications as CreateTreatmentInput["medications"])
            : [],
          cost: result.data.cost != null ? Number(result.data.cost) : undefined,
          status: result.data.status,
          opd_charged: result.data.opd_charged ?? false,
          xray_taken: result.data.xray_taken ?? false,
          xray_cost: result.data.xray_cost != null ? Number(result.data.xray_cost) : null,
          performed_at: date ? (time ? `${date}T${time}` : date) : undefined,
          consultant_id: result.data.consultant_id ?? "",
          // `commission_type` is a text column with a CHECK, so the database
          // types it as `string`. Narrow it here rather than asserting: a value
          // outside the pair would otherwise be handed to a select that cannot
          // display it, leaving the field blank with no indication why.
          commission_type:
            result.data.commission_type === "percentage" ||
            result.data.commission_type === "fixed"
              ? result.data.commission_type
              : undefined,
          commission_value:
            result.data.commission_value != null
              ? Number(result.data.commission_value)
              : undefined,
          tooth_number: result.data.tooth_number ?? undefined,
          dentition_type:
            result.data.dentition_type === "adult" || result.data.dentition_type === "primary"
              ? result.data.dentition_type
              : undefined,
        });
      }
      setLoading(false);
    });
  }, [treatmentId, reset]);

  function handleDateChange(date: string) {
    setPerformedDate(date);
    const combined = date ? (performedTime ? `${date}T${performedTime}` : date) : undefined;
    setValue("performed_at" as keyof CreateTreatmentInput, combined);
  }

  function handleTimeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const time = e.target.value;
    setPerformedTime(time);
    const combined = performedDate ? (time ? `${performedDate}T${time}` : performedDate) : undefined;
    setValue("performed_at" as keyof CreateTreatmentInput, combined);
  }

  function onSubmit(values: CreateTreatmentInput | UpdateTreatmentInput) {
    setServerError(null);
    startTransition(async () => {
      const result = isEdit
        ? await updateTreatment(treatmentId!, values)
        : await createTreatment(values);

      if (result.error) {
        setServerError(result.error);
        return;
      }

      if (result.data) {
        // If the dentist marked consent required on a NEW treatment, create the
        // consent draft now (linked to the just-created treatment). Skipped when
        // the dentist already created it inline (createdConsentId) so there's no
        // duplicate. Non-fatal: a consent failure never blocks treatment creation.
        if (!isEdit && consentCfg?.required && !consentCfg.createdConsentId) {
          try {
            const consentRes = await createConsent({
              patient_id: result.data.patient_id,
              treatment_id: result.data.id,
              appointment_id: result.data.appointment_id ?? "",
              template_key: consentCfg.templateKey,
              section_edits: consentCfg.sectionEdits,
            });
            if (consentRes.error) {
              console.error("[TreatmentForm] consent draft:", consentRes.error);
            }
          } catch (err) {
            console.error("[TreatmentForm] consent draft failed:", err);
          }
        }

        // Invalidate only the treatments cache.
        queryClient.invalidateQueries({ queryKey: queryKeys.treatments.all });

        if (onSuccess) {
          onSuccess(result.data);
        } else {
          // After creation, route to the appointment details page.
          const target = appointmentId
            ? `/dentist/appointments/${appointmentId}`
            : patientId
              ? `/dentist/patients/${patientId}/treatments`
              : "/dentist/treatments";
          router.push(target);
        }
      }
    });
  }

  if (loading) return <SkeletonCard className="h-64" />;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const medErrors = (errors as any).medications as Array<Record<string, { message?: string }>> | undefined;

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {serverError && (
        <div className="mb-4 rounded-lg bg-danger-bg border border-danger-border px-4 py-3 text-xs text-danger">
          {serverError}
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden divide-y divide-surface-muted">
        <div className="px-6 py-5 space-y-4">
          {toothNumber != null && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-info-bg border border-info-border px-3 py-1 text-xs font-medium text-info">
              Linked to Tooth {toothNumber}
            </div>
          )}
          {!isEdit && (
            <>
              {needsAppointmentPicker ? (
                <Field
                  label="Appointment"
                  htmlFor="appointment_id"
                  required
                  error={(errors as Record<string, { message?: string }>).appointment_id?.message}
                  hint={
                    !appointmentsLoading && patientAppointments.length === 0
                      ? "This patient has no appointments yet. Create an appointment first, then add the treatment from there."
                      : undefined
                  }
                >
                  <Select
                    id="appointment_id"
                    {...register("appointment_id" as keyof CreateTreatmentInput)}
                    disabled={appointmentsLoading || patientAppointments.length === 0}
                    hasError={!!(errors as Record<string, unknown>).appointment_id}
                  >
                    <option value="">
                      {appointmentsLoading ? "Loading appointments…" : "Select appointment…"}
                    </option>
                    {patientAppointments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {formatDateTime(a.scheduled_at)} ·{" "}
                        {APPOINTMENT_STATUS_LABELS[a.status as keyof typeof APPOINTMENT_STATUS_LABELS] ??
                          a.status}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <input type="hidden" {...register("appointment_id" as keyof CreateTreatmentInput)} />
              )}
              <input type="hidden" {...register("patient_id" as keyof CreateTreatmentInput)} />
            </>
          )}

          <input type="hidden" {...register("performed_at" as keyof CreateTreatmentInput)} />

          <Field label="Treatment Type" htmlFor="treatment-type" required error={(errors as Record<string, {message?: string}>).treatment_type?.message}>
            <Select
              id="treatment-type"
              value={showCustomType ? "__other__" : (treatmentTypeValue ?? "")}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "__other__") {
                  setShowCustomType(true);
                  setCustomTypeValue("");
                  setValue("treatment_type" as keyof CreateTreatmentInput, "" as never);
                } else {
                  setShowCustomType(false);
                  setCustomTypeValue("");
                  setValue("treatment_type" as keyof CreateTreatmentInput, val as never);
                }
              }}
              hasError={!!(errors as Record<string, unknown>).treatment_type}
            >
              <option value="" disabled>Select treatment type…</option>
              {TREATMENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
              <option value="__other__">Other</option>
            </Select>
            {showCustomType && (
              <Input
                id="treatment-type-custom"
                type="text"
                className="mt-2"
                placeholder="Describe the treatment type…"
                value={customTypeValue}
                onChange={(e) => {
                  setCustomTypeValue(e.target.value);
                  setValue(
                    "treatment_type" as keyof CreateTreatmentInput,
                    e.target.value as never
                  );
                }}
                hasError={!!(errors as Record<string, unknown>).treatment_type}
                autoFocus
              />
            )}
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Status" htmlFor="status" required>
              <Select id="status" {...register("status")}>
                {Object.values(TreatmentStatus).map((s) => (
                  <option key={s} value={s}>{TREATMENT_STATUS_LABELS[s]}</option>
                ))}
              </Select>
            </Field>

            <Field label="Cost (₹)" htmlFor="cost" required error={(errors as Record<string, {message?: string}>).cost?.message}>
              <Input
                id="cost"
                type="number"
                min={0}
                step="0.01"
                {...register("cost", { valueAsNumber: true })}
                onWheel={(e) => (e.target as HTMLElement).blur()}
                className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                hasError={!!(errors as Record<string, unknown>).cost}
              />
            </Field>
          </div>

          <Field label="Performed At" htmlFor="performed-at-date" hint="Optional — date and time the treatment was performed">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <CalendarPicker
                id="performed-at-date"
                value={performedDate}
                onChange={handleDateChange}
                max={performedMax}
                placeholder="Select date"
                clearable
              />
              <Input
                id="performed-at-time"
                type="time"
                value={performedTime}
                onChange={handleTimeChange}
                disabled={!performedDate}
                aria-label="Treatment time"
              />
            </div>
          </Field>

          {/* ── OPD consultation ────────────────────────────────── */}
          {/* Yes/No only. The fee itself is the clinic's setting and is applied
              server-side, so there is no amount to type and no way for two
              visits on the same day to be billed differently by mistake. */}
          <Field
            label="OPD Consultation"
            htmlFor="opd-charged"
            hint={
              opdFee != null && opdFee > 0
                ? `Charges the clinic's consultation fee of ${formatCurrency(opdFee)}`
                : "No consultation fee is set for this clinic — set one in Clinic Settings"
            }
          >
            <div
              id="opd-charged"
              role="radiogroup"
              aria-label="OPD consultation charged"
              className="inline-flex rounded-lg border border-border bg-background p-0.5"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!opdChargedValue}
                onClick={() =>
                  setValue("opd_charged" as keyof CreateTreatmentInput, false as never)
                }
                className={cn(
                  "px-4 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer",
                  !opdChargedValue
                    ? "bg-surface text-text-primary shadow-sm border border-border"
                    : "text-text-secondary hover:text-text-primary"
                )}
              >
                No
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!!opdChargedValue}
                onClick={() =>
                  setValue("opd_charged" as keyof CreateTreatmentInput, true as never)
                }
                className={cn(
                  "px-4 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer",
                  opdChargedValue
                    ? "bg-accent text-accent-foreground shadow-sm"
                    : "text-text-secondary hover:text-text-primary"
                )}
              >
                Yes
              </button>
            </div>
          </Field>

          {/* ── X-ray (only when clinic has it enabled) ─────────── */}
          {xrayEnabled && (
            <div className="space-y-3">
              <Field
                label="X-ray Taken"
                htmlFor="xray-taken"
                hint="Enable if an X-ray was taken during this visit"
              >
                <div
                  id="xray-taken"
                  role="radiogroup"
                  aria-label="X-ray taken"
                  className="inline-flex rounded-lg border border-border bg-background p-0.5"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!xrayTakenValue}
                    onClick={() => {
                      setValue("xray_taken" as keyof CreateTreatmentInput, false as never);
                      setValue("xray_cost" as keyof CreateTreatmentInput, null as never);
                    }}
                    className={cn(
                      "px-4 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer",
                      !xrayTakenValue
                        ? "bg-surface text-text-primary shadow-sm border border-border"
                        : "text-text-secondary hover:text-text-primary"
                    )}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!!xrayTakenValue}
                    onClick={() =>
                      setValue("xray_taken" as keyof CreateTreatmentInput, true as never)
                    }
                    className={cn(
                      "px-4 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer",
                      xrayTakenValue
                        ? "bg-accent text-accent-foreground shadow-sm"
                        : "text-text-secondary hover:text-text-primary"
                    )}
                  >
                    Yes
                  </button>
                </div>
              </Field>

              {xrayTakenValue && (
                <div className="rounded-lg border border-border bg-background px-4 py-4">
                  <div className="flex items-center gap-1.5 mb-3">
                    <ScanLine className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
                    <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">X-ray Details</span>
                  </div>
                  <Field
                    label="X-ray Cost (₹)"
                    htmlFor="xray-cost"
                    required
                    error={(errors as Record<string, {message?: string}>).xray_cost?.message}
                  >
                    <Input
                      id="xray-cost"
                      type="number"
                      min={0}
                      step="0.01"
                      {...register("xray_cost", { valueAsNumber: true, setValueAs: (v) => (v === "" || v === null || v === undefined || isNaN(v) ? null : Number(v)) })}
                      onWheel={(e) => (e.target as HTMLElement).blur()}
                      className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      hasError={!!(errors as Record<string, unknown>).xray_cost}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Performed By / Revenue Distribution ─────────────── */}
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-center gap-1.5">
            <Briefcase className="h-4 w-4 text-text-secondary" aria-hidden />
            <h3 className="text-sm font-semibold text-text-primary">Performed By</h3>
          </div>

          <Field
            label="Performed By"
            htmlFor="performed-by"
            hint="Select a consultant to split revenue; defaults to the treating dentist"
          >
            <Select
              id="performed-by"
              value={consultantIdValue || ""}
              onChange={(e) => {
                const val = e.target.value;
                setValue("consultant_id" as keyof CreateTreatmentInput, (val || "") as never);
                if (!val) {
                  // Reset compensation when reverting to the treating dentist
                  setValue("commission_type" as keyof CreateTreatmentInput, undefined as never);
                  setValue("commission_value" as keyof CreateTreatmentInput, undefined as never);
                } else if (!commissionTypeValue) {
                  setValue("commission_type" as keyof CreateTreatmentInput, "percentage" as never);
                }
              }}
            >
              <option value="">{dentistName ?? "Treating Dentist"}</option>
              {consultants.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          {hasConsultant && (
            <div className="rounded-lg border border-border bg-background p-4 space-y-4">
              <p className="text-xs font-semibold text-text-primary uppercase tracking-wide">
                Revenue Distribution
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Compensation Type" htmlFor="commission-type">
                  <Select
                    id="commission-type"
                    value={commissionTypeValue ?? "percentage"}
                    onChange={(e) =>
                      setValue(
                        "commission_type" as keyof CreateTreatmentInput,
                        e.target.value as never
                      )
                    }
                  >
                    <option value="percentage">Percentage</option>
                    <option value="fixed">Fixed Amount</option>
                  </Select>
                </Field>

                <Field
                  label={commissionTypeValue === "fixed" ? "Consultant Amount (₹)" : "Consultant Percentage (%)"}
                  htmlFor="commission-value"
                  error={(errors as Record<string, { message?: string }>).commission_value?.message}
                >
                  <Input
                    id="commission-value"
                    type="number"
                    min={0}
                    max={commissionTypeValue === "fixed" ? undefined : 100}
                    step="0.01"
                    className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    {...register("commission_value", { valueAsNumber: true })}
                    onWheel={(e) => (e.target as HTMLElement).blur()}
                  />
                </Field>
              </div>

              {/* Live preview */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
                <PreviewStat label="Treatment" value={formatCurrency(Number(costValue ?? 0))} />
                <PreviewStat label="Consultant Share" value={formatCurrency(split.consultantShare)} accent="amber" />
                <PreviewStat label="Clinic Share" value={formatCurrency(split.clinicShare)} accent="green" />
              </div>
            </div>
          )}
        </div>

        {/* ── Medications ─────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Pill className="h-4 w-4 text-text-secondary" aria-hidden />
              <h3 className="text-sm font-semibold text-text-primary">Medications</h3>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append({ name: "", dosage: "", number: 1, days: 1, instructions: "" })}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add Medicine
            </Button>
          </div>

          {fields.length === 0 ? (
            <p className="text-xs text-text-disabled">No medications added.</p>
          ) : (
            <div className="space-y-3">
              {/* Column headers (md+) — order: Medicine | Number | Dosage | Instructions | Days */}
              <div className="hidden md:grid grid-cols-[minmax(200px,2fr)_90px_120px_160px_130px_36px] gap-2 text-xs font-medium text-text-secondary uppercase tracking-wide px-1">
                <span>Medicine</span>
                <span>Number</span>
                <span>Dosage</span>
                <span>Instructions</span>
                <span>Days</span>
                <span className="sr-only">Remove</span>
              </div>

              {fields.map((fieldItem, index) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const current = (fieldItem as any) as { days?: number };
                const dosageValue = medicationValues?.[index]?.dosage;
                const instructionsValue = medicationValues?.[index]?.instructions;
                return (
                  <div key={fieldItem.id} className="space-y-2">
                    {/* Main row: name | number | dosage | instructions | days | remove */}
                    <div
                      className="grid grid-cols-1 md:grid-cols-[minmax(200px,2fr)_90px_120px_160px_130px_36px] gap-2 items-start"
                    >
                      <Input
                        placeholder="Medicine name"
                        aria-label="Medicine name"
                        {...register(`medications.${index}.name` as never)}
                        hasError={!!medErrors?.[index]?.name}
                      />

                      {/* Number — dropdown: 1/2, 1, 2, 3 (0.5 stored for "1/2") */}
                      <Select
                        id={`medications-${index}-number`}
                        aria-label="Number of units"
                        {...register(`medications.${index}.number` as never, { valueAsNumber: true })}
                        hasError={!!medErrors?.[index]?.number}
                      >
                        <option value="0.5">1/2</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                      </Select>

                      {/* Dosage — shadcn Select dropdown */}
                      <Select
                        id={`medications-${index}-dosage`}
                        aria-label="Dosage frequency"
                        {...register(`medications.${index}.dosage` as never)}
                      >
                        <option value="">Select…</option>
                        <ExtraOption value={dosageValue} among={DOSAGE_OPTIONS} />
                        {DOSAGE_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </Select>

                      {/* Instructions — optional dropdown */}
                      <Select
                        id={`medications-${index}-instructions`}
                        aria-label="Medication instructions"
                        {...register(`medications.${index}.instructions` as never)}
                      >
                        <option value="">Select…</option>
                        <ExtraOption value={instructionsValue} among={MEDICATION_INSTRUCTION_OPTIONS} />
                        {MEDICATION_INSTRUCTION_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </Select>

                      {/* Days — increment counter */}
                      <DaysCounter
                        defaultValue={current.days ?? 1}
                        onStep={(next) => {
                          setValue(`medications.${index}.days` as never, next as never, { shouldValidate: true });
                        }}
                      />

                      <button
                        type="button"
                        onClick={() => remove(index)}
                        className="h-9 w-9 flex items-center justify-center rounded-lg border border-border text-danger hover:bg-danger-bg transition-colors"
                        aria-label="Remove medicine"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Notes ──────────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">Notes</h3>

          {/* Patient-Visible Notes — shown in the patient portal */}
          <Field
            label="Notes for patient (shown in portal)"
            htmlFor="patient-notes"
          >
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-success">
                <Eye className="h-3 w-3" aria-hidden />
                <span>Patient can see this</span>
              </div>
              <Textarea
                id="patient-notes"
                {...register("patient_visible_notes")}
                rows={3}
                placeholder="e.g. Filling completed on upper left molar…"
              />
            </div>
          </Field>
        </div>

        {/* ── Consent Form (pilot rollout — hidden entirely for a clinic that
             doesn't have it enabled) ──────────────────────────── */}
        {consentFormsEnabled && (
          <TreatmentConsentSection
            treatmentType={effectiveTreatmentType}
            patientId={effectivePatientId}
            appointmentId={appointmentId}
            treatmentId={treatmentId}
            mode={isEdit ? "edit" : "create"}
            onChange={setConsentCfg}
          />
        )}

        <div className="px-6 py-4 bg-background flex items-center justify-end gap-3">
          <Button variant="outline" size="sm" type="button" onClick={() => (onCancel ? onCancel() : router.back())}>
            Cancel
          </Button>
          <Button type="submit" size="sm" isLoading={isPending}>
            {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Treatment"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Small labelled figure used in the revenue-distribution live preview. */
function PreviewStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "amber" | "green";
}) {
  const color =
    accent === "amber" ? "text-warning" : accent === "green" ? "text-success" : "text-text-primary";
  return (
    <div className="rounded-lg bg-surface border border-border px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}

/** Days field with +/- increment buttons. Value is pushed to RHF via onStep. */
function DaysCounter({
  defaultValue,
  onStep,
}: {
  defaultValue: number;
  onStep: (next: number) => void;
}) {
  const [value, setValue] = useState<number>(defaultValue || 1);

  function commit(next: number) {
    const clamped = Math.min(365, Math.max(1, next));
    setValue(clamped);
    onStep(clamped);
  }

  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={() => commit(value - 1)}
        className="h-9 w-8 flex items-center justify-center rounded-l-lg border border-border text-text-body hover:bg-surface-muted"
        aria-label="Decrease days"
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="number"
        min={1}
        max={365}
        value={value}
        onChange={(e) => commit(parseInt(e.target.value, 10) || 1)}
        onWheel={(e) => (e.target as HTMLElement).blur()}
        className="h-9 w-12 text-center text-sm border-y border-border outline-none focus:ring-1 focus:ring-accent text-text-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        aria-label="Days"
      />
      <button
        type="button"
        onClick={() => commit(value + 1)}
        className="h-9 w-8 flex items-center justify-center rounded-r-lg border border-border text-text-body hover:bg-surface-muted"
        aria-label="Increase days"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Generic increment/decrement stepper — identical styling to DaysCounter. */
function ExtraOption({
  value,
  among,
}: {
  value?: string | number | null;
  among: readonly string[];
}) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (among.includes(v)) return null;
  // Render a legacy/free-text value as a selectable option so editing an older
  // record keeps its original value instead of silently dropping it.
  return <option value={v}>{v}</option>;
}
