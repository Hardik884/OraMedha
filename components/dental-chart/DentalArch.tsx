/**
 * components/dental-chart/DentalArch.tsx
 *
 * One arch (upper or lower) of the Dental Chart: a row of clickable Tooth
 * shapes with their FDI numbers, split into a patient-right and patient-left
 * half with a visible midline gap — the layout requirement that "the
 * midline should be visually obvious".
 *
 * Numbers sit on the OUTER edge of each arch (above the upper row, below the
 * lower row) so the crowns of both arches meet at the shared gap between
 * them, reading as an open mouth — upper teeth hanging down, lower teeth
 * rising up to meet them.
 */

"use client";

import { Tooth } from "./Tooth";
import { getToothType, type ToothIdentity } from "@/lib/dental-chart/teeth";
import { TOOTH_CONDITION_LABELS, TREATMENT_STAGE_LABELS, TREATMENT_STAGE_CLASSES } from "@/lib/dental-chart/status";
import type { PatientTooth } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Small corner badge for a tooth's TreatmentStage — the chart's second
 * visual channel, independent of the tooth's own condition colour (see
 * ToothLegend, which documents exactly this rendering). Each stage carries a
 * distinct SHAPE, not just a colour: hollow+dashed / hollow+solid ring /
 * pulsing filled dot / plain filled dot — so the four remain distinguishable
 * without colour vision. Absent entirely when no treatment is underway.
 */
function StageBadge({ stage }: { stage: NonNullable<PatientTooth["treatment_stage"]> }) {
  const tone = TREATMENT_STAGE_CLASSES[stage];
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full",
        stage === "recommended" && "bg-transparent border-2 border-dashed border-warning",
        stage === "planned" && "bg-surface border-2 border-solid border-accent",
        stage === "in_progress" && cn(tone.dot, "border border-surface animate-pulse"),
        stage === "completed" && cn(tone.dot, "border border-surface"),
      )}
    />
  );
}

export type DentalArchProps = {
  teeth: ToothIdentity[];
  toothByNumber: Map<number, PatientTooth | null>;
  selectedTeeth: Set<number>;
  multiSelectMode: boolean;
  onToothClick: (toothNumber: number) => void;
  activeToothNumber?: number | null;
};

export function DentalArch({
  teeth,
  toothByNumber,
  selectedTeeth,
  multiSelectMode,
  onToothClick,
  activeToothNumber,
}: DentalArchProps) {
  const arch = teeth[0]?.arch ?? "upper";
  const midpoint = Math.ceil(teeth.length / 2);
  const rightHalf = teeth.slice(0, midpoint);
  const leftHalf = teeth.slice(midpoint);

  return (
    <div className="flex items-start justify-center gap-3 sm:gap-5 min-w-max px-2">
      <ArchHalf
        teeth={rightHalf}
        arch={arch}
        toothByNumber={toothByNumber}
        selectedTeeth={selectedTeeth}
        multiSelectMode={multiSelectMode}
        onToothClick={onToothClick}
        activeToothNumber={activeToothNumber}
      />
      {/* Midline */}
      <div
        className="w-px self-stretch bg-border mx-1 sm:mx-2"
        aria-hidden
        title="Midline"
      />
      <ArchHalf
        teeth={leftHalf}
        arch={arch}
        toothByNumber={toothByNumber}
        selectedTeeth={selectedTeeth}
        multiSelectMode={multiSelectMode}
        onToothClick={onToothClick}
        activeToothNumber={activeToothNumber}
      />
    </div>
  );
}

function ArchHalf({
  teeth,
  arch,
  toothByNumber,
  selectedTeeth,
  multiSelectMode,
  onToothClick,
  activeToothNumber,
}: {
  teeth: ToothIdentity[];
  arch: "upper" | "lower";
  toothByNumber: Map<number, PatientTooth | null>;
  selectedTeeth: Set<number>;
  multiSelectMode: boolean;
  onToothClick: (toothNumber: number) => void;
  activeToothNumber?: number | null;
}) {
  return (
    <div className="flex items-start gap-1.5 sm:gap-2">
      {teeth.map((identity) => {
        const tooth = toothByNumber.get(identity.toothNumber) ?? null;
        const condition = tooth?.tooth_condition ?? "normal";
        const stage = tooth?.treatment_stage ?? null;
        const isSelected = selectedTeeth.has(identity.toothNumber);
        const isActive = activeToothNumber === identity.toothNumber;
        const numberLabel = (
          <span
            className={cn(
              "text-[11px] font-semibold tabular-nums transition-colors",
              isActive ? "text-accent" : "text-text-primary"
            )}
          >
            {identity.toothNumber}
          </span>
        );
        const label = `Tooth ${identity.toothNumber} — ${TOOTH_CONDITION_LABELS[condition]}${stage ? `, ${TREATMENT_STAGE_LABELS[stage]}` : ""}`;

        return (
          <button
            key={identity.toothNumber}
            type="button"
            onClick={() => onToothClick(identity.toothNumber)}
            aria-pressed={multiSelectMode ? isSelected : isActive}
            aria-label={label}
            title={label}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 transition-all",
              "hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
              isSelected && "ring-2 ring-accent bg-surface-muted",
              isActive && !multiSelectMode && "bg-surface-muted"
            )}
          >
            {arch === "upper" && numberLabel}
            <span className="relative inline-flex">
              <Tooth
                toothType={getToothType(identity.dentitionType, identity.position)}
                arch={arch}
                condition={condition}
                size={38}
              />
              {stage && <StageBadge stage={stage} />}
            </span>
            {arch === "lower" && numberLabel}
          </button>
        );
      })}
    </div>
  );
}
