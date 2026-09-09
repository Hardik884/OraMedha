/**
 * lib/dental-chart/status.ts
 *
 * Presentation mappings for the Dental Chart's two independent per-tooth
 * fields, shared by the Legend, Tooth SVG, DentalArch's stage badge, and the
 * tooth detail panel's dropdowns:
 *
 *   - ToothCondition  — what the tooth IS. Drives the tooth SHAPE's fill —
 *     the chart's primary, largest visual signal.
 *   - TreatmentStage   — what stage its treatment is at, if any. Drives a
 *     small badge rendered at the tooth's corner (see DentalArch), kept
 *     deliberately on the app's EXISTING status vocabulary (warning / accent
 *     / info / success) rather than a second bespoke colour system — so a
 *     stage never shares a hue with a condition, and "blue" always means the
 *     same status-family thing everywhere else in OraMedha.
 *
 * Color is never the only signal for either field: every condition also
 * carries a distinct line weight/dash where one is needed (missing/extracted
 * is dashed + faded, matching the pre-existing convention), and every stage
 * badge carries a distinct SHAPE — hollow ring / dashed ring / pulsing dot /
 * solid check — so the four remain distinguishable without colour vision.
 */

import { TOOTH_STATUS_LABELS, TOOTH_CONDITION_LABELS, TREATMENT_STAGE_LABELS, type ToothStatus, type ToothCondition, type TreatmentStage } from "@/types";
import type { BadgeVariant } from "@/lib/utils";

export { TOOTH_STATUS_LABELS, TOOTH_CONDITION_LABELS, TREATMENT_STAGE_LABELS };

export const TOOTH_STATUS_BADGE_VARIANT: Record<ToothStatus, BadgeVariant> = {
  normal: "default",
  recommended: "warning",
  planned: "info",
  in_progress: "info",
  completed: "success",
  missing: "default",
};

/**
 * Condition presentation, as Tailwind utility classes rather than hex
 * strings — the values resolve through CSS variables (app/globals.css),
 * which is what lets the chart carry a genuinely different clinical palette
 * in dark mode instead of an inverted light one.
 */
export const TOOTH_CONDITION_CLASSES: Record<
  ToothCondition,
  { fill: string; stroke: string; swatchBg: string; swatchBorder: string }
> = {
  normal: {
    fill: "fill-tooth-normal",
    stroke: "stroke-tooth-normal-line",
    swatchBg: "bg-tooth-normal",
    swatchBorder: "border-tooth-normal-line",
  },
  caries: {
    fill: "fill-tooth-caries",
    stroke: "stroke-tooth-caries-line",
    swatchBg: "bg-tooth-caries",
    swatchBorder: "border-tooth-caries-line",
  },
  fractured: {
    fill: "fill-tooth-fractured",
    stroke: "stroke-tooth-fractured-line",
    swatchBg: "bg-tooth-fractured",
    swatchBorder: "border-tooth-fractured-line",
  },
  restored_filled: {
    fill: "fill-tooth-restored",
    stroke: "stroke-tooth-restored-line",
    swatchBg: "bg-tooth-restored",
    swatchBorder: "border-tooth-restored-line",
  },
  crown: {
    fill: "fill-tooth-crown",
    stroke: "stroke-tooth-crown-line",
    swatchBg: "bg-tooth-crown",
    swatchBorder: "border-tooth-crown-line",
  },
  root_canal_treated: {
    fill: "fill-tooth-root-canal",
    stroke: "stroke-tooth-root-canal-line",
    swatchBg: "bg-tooth-root-canal",
    swatchBorder: "border-tooth-root-canal-line",
  },
  abscess: {
    fill: "fill-tooth-abscess",
    stroke: "stroke-tooth-abscess-line",
    swatchBg: "bg-tooth-abscess",
    swatchBorder: "border-tooth-abscess-line",
  },
  missing_extracted: {
    fill: "fill-tooth-missing",
    stroke: "stroke-tooth-missing-line",
    swatchBg: "bg-tooth-missing",
    swatchBorder: "border-tooth-missing-line",
  },
  implant: {
    fill: "fill-tooth-implant",
    stroke: "stroke-tooth-implant-line",
    swatchBg: "bg-tooth-implant",
    swatchBorder: "border-tooth-implant-line",
  },
};

/**
 * Stage badge presentation. Reuses the app's existing semantic status
 * tokens (never a new colour), each paired with a distinct border STYLE so
 * the four stages read apart even without colour:
 *   recommended — hollow ring, dashed          (flagged, nothing scheduled yet)
 *   planned     — solid ring, hollow centre    (on the books)
 *   in_progress — solid dot, animated pulse    (happening now — echoes the
 *                                                Live Queue's own pulse dot)
 *   completed   — solid dot, filled            (done)
 */
export const TREATMENT_STAGE_CLASSES: Record<
  TreatmentStage,
  { dot: string; ring: string; border: string }
> = {
  recommended: { dot: "bg-warning", ring: "ring-warning", border: "border-dashed" },
  planned: { dot: "bg-accent", ring: "ring-accent", border: "border-solid" },
  in_progress: { dot: "bg-info", ring: "ring-info", border: "border-solid" },
  completed: { dot: "bg-success", ring: "ring-success", border: "border-solid" },
};
