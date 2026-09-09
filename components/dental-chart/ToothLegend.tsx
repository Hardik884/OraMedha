/**
 * components/dental-chart/ToothLegend.tsx
 *
 * Two-part legend explaining the chart's two independent visual channels:
 *   1. Tooth colour — the CONDITION (a filled swatch, one per ToothCondition).
 *   2. Corner badge — the TREATMENT STATUS/STAGE (a small badge sample, one
 *      per TreatmentStage, matching the exact badge DentalArch renders).
 * Colour is never the only signal: every condition swatch also carries a
 * distinct border style (dashed for "Missing / Extracted", matching the
 * tooth shape's own dashed outline), and every stage sample carries a
 * distinct badge shape (hollow/ring/pulsing/filled), not just a colour.
 */

import { TOOTH_CONDITION_ORDER, TREATMENT_STAGE_ORDER } from "@/types";
import { TOOTH_CONDITION_LABELS, TOOTH_CONDITION_CLASSES, TREATMENT_STAGE_LABELS, TREATMENT_STAGE_CLASSES } from "@/lib/dental-chart/status";
import { cn } from "@/lib/utils";

/** Mirrors StageBadge's exact classes (components/dental-chart/DentalArch.tsx) so the legend sample matches what's actually drawn on the chart. */
const STAGE_SAMPLE_CLASSES: Record<string, string> = {
  recommended: "bg-transparent border-2 border-dashed border-warning",
  planned: "bg-surface border-2 border-solid border-accent",
  in_progress: "border border-border-strong",
  completed: "border border-border-strong",
};

export function ToothLegend() {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
          Tooth colour — condition
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="list" aria-label="Tooth condition legend">
          {TOOTH_CONDITION_ORDER.map((condition) => {
            const tone = TOOTH_CONDITION_CLASSES[condition];
            return (
              <div key={condition} role="listitem" className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block h-3 w-3 rounded-full shrink-0 border-[1.5px]",
                    condition === "missing_extracted" ? "border-dashed" : "border-solid",
                    tone.swatchBg,
                    tone.swatchBorder,
                  )}
                />
                <span className="text-xs text-text-secondary">{TOOTH_CONDITION_LABELS[condition]}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
          Corner badge — treatment status
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="list" aria-label="Treatment status legend">
          {TREATMENT_STAGE_ORDER.map((stage) => {
            const tone = TREATMENT_STAGE_CLASSES[stage];
            const isFilled = stage === "in_progress" || stage === "completed";
            return (
              <div key={stage} role="listitem" className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block h-3 w-3 rounded-full shrink-0",
                    isFilled ? cn(tone.dot, "border border-border-strong") : STAGE_SAMPLE_CLASSES[stage],
                    stage === "in_progress" && "animate-pulse",
                  )}
                />
                <span className="text-xs text-text-secondary">{TREATMENT_STAGE_LABELS[stage]}</span>
              </div>
            );
          })}
          <div className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-full shrink-0 border-2 border-dashed border-border-strong" />
            <span className="text-xs text-text-secondary">No treatment underway</span>
          </div>
        </div>
      </div>
    </div>
  );
}
