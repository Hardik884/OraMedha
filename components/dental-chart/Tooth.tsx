/**
 * components/dental-chart/Tooth.tsx
 *
 * Reusable tooth SVG. Renders ONE tooth shape whose crown/root morphology is
 * driven by `toothType` (incisor / canine / premolar / molar) and whose fill
 * is driven by `status`. `arch` flips the shape vertically so upper-arch
 * teeth hang crown-down (root up) and lower-arch teeth stand crown-up
 * (root down) — the standard two-row dental-chart convention, matching how
 * the teeth actually meet at the bite line between the two rows.
 *
 * Tooth silhouettes are real anatomical illustrations, not hand-drawn
 * approximations: the outline (and, where available, the specular highlight)
 * for each tooth type is adapted from the "tooth-base" / "tooth-base-beauty"
 * layers of React-Odontogram-Modul (github.com/ZoliQua/React-Odontogram-Modul),
 * MIT-licensed, © 2026 Zoltán Dul — see THIRD_PARTY_NOTICES.md. The upstream
 * SVGs are large multi-layer clinical charting assets (pathology/restoration
 * overlays, gradients, toggle states); only the base healthy-tooth silhouette
 * layer is used here, colored dynamically instead of the source's static fill.
 *
 * Plain functional component computing geometry inline, no external SVG-icon
 * abstraction — mirrors components/business-brain/HealthMeter.tsx, the
 * codebase's existing precedent for a hand-drawn SVG shape.
 */

import type { ToothCondition } from "@/types";
import type { ToothType, ArchSide } from "@/lib/dental-chart/teeth";
import { cn } from "@/lib/utils";
import { TOOTH_CONDITION_CLASSES } from "@/lib/dental-chart/status";

export type ToothVisualState = ToothCondition;

/** A slightly heavier outline is a second, non-colour cue for a condition that needs one to stand out at a glance; every other condition shares the default weight. */
const CONDITION_STROKE_WIDTH: Record<ToothVisualState, number> = {
  normal: 0.6,
  caries: 0.6,
  fractured: 0.6,
  restored_filled: 0.6,
  crown: 0.6,
  root_canal_treated: 0.6,
  abscess: 0.9,
  missing_extracted: 0.6,
  implant: 0.6,
};

/**
 * Real anatomical tooth silhouettes, one per morphological type, each with
 * its own (near-identical) viewBox — see file header for provenance. `outline`
 * is the single crown+root path (the source intentionally leaves the root tip
 * unclosed, suggesting it fades under the gum rather than having a hard cap).
 * `highlight` is an optional small specular-gloss path near the incisal edge;
 * omitted for premolar/molar in the source art.
 */
const TOOTH_SHAPES: Record<
  ToothType,
  { viewBox: string; outline: string; highlight?: string }
> = {
  incisor: {
    viewBox: "0 0 39.7 70.8",
    outline:
      "M18.5,3.1c-2.4,4.5-3.3,9.5-3.6,14.5-.3,4.6-.9,9-1.3,13.6-.3,3.2-1.3,6.2-2.8,9-1.6,3.5-3.1,8.2-3.3,12.3-.3,6,2,11.1,8.1,11.1s16.5,1.1,16.5-4.3-.3-11.8-2.3-17-.3-.8-.5-1.2c-1.1-2.4-2.1-5.9-1.9-8.3.5-6.5-1.8-13.8-3-20.3-.4-3.6-1.2-7.1-4.2-9.4",
    highlight:
      "M15.7,59.5c2-.7,3.5-1,5.1-.6,2.5.3,4.1,1.5,5.5,3-1.5-.5-3.1-.6-4.9-.4-2.1.3-3.6.6-5.2,0-.6-.3-.9-1.2-.5-1.9h0Z",
  },
  canine: {
    viewBox: "0 0 40.3 71",
    outline:
      "M18.3,4.4c-.7,1.2-1.6,2.5-2.1,3.9-1.6,5-1.9,11-2.9,16-.7,6.7-3.6,11.9-4.6,18.3-.7,4.1.9,7.7,2.3,11.5,1.4,5.1,4.2,13.2,10.3,11,4.9-2.1,8.4-11.8,9.1-16.8.5-3.6.5-7.8-1.2-11.2s-3-4.9-3.3-8.1c-.8-4.7-1.3-13.3-2.3-17.9-.4-2.6-1.9-4.6-3.6-6.4",
    highlight:
      "M27.3,54.3c-.3,2.2-2.2,4.4-3.7,6.1-1,1.1-2,1.7-1.7.9v-.3c1.4-2.2,2.8-5.5,4.3-7.4.5-.4.9.2,1,.6h.1Z",
  },
  premolar: {
    viewBox: "0 0 39.8 71.2",
    outline:
      "M17.1,22.4c.3,1.9.9,4.3,2.6,5.3,1.5.9,2.9-.4,3.4-1.8,1.7-4.8.3-10.7,2.2-15.5.8-1.7,2.6-1.5,3.4.2,1,1.9,1.1,4.3,1.4,6.5.3,3.8-.7,7.3-1.6,11-1,4-1.2,8.3,0,12.4,1.8,8,7.5,21.1-2,24.4-1.4.2-2.9-.5-4.5-.9-3-1-5.1,1-8,1.5-8.9,1.4-6.7-14.5-4.9-19.4.9-2.3,1.9-4.7,2.1-7.3.3-5.2-1.1-10.8-.8-15.9,0-3.3.5-6.8,1.2-10.1.2-1.7,2.2-5.9,3.9-3.2,1.4,3.9.9,8.8,1.6,12.6,0,0,0,.2,0,.2Z",
  },
  molar: {
    viewBox: "0 0 42.9 70.9",
    outline:
      "M21.3,27.7c1.9.9,3.6-.4,4.2-1.8,2.1-4.8.4-10.7,2.7-15.5,1-1.7,3.2-1.5,4.2.2,1.2,1.9,1.4,4.3,1.7,6.5.4,3.8-.9,7.3-2,11-1.2,4-1.5,8.3,0,12.4,2.2,8,9.3,21.1-2.6,24.4-1.7.2-3.6-.5-5.6-.9-3.7-1-6.4,1-10,1.5-11.1,1.4-8.4-14.5-6-19.4,1.1-2.3,2.4-4.7,2.6-7.3.4-5.2-1.4-10.8-1-15.9,0-3.3.6-6.8,1.5-10.1.2-1.7,2.7-5.9,4.9-3.2,1.7,3.9,1.1,8.8,2,12.6,0,0,1.3,4.5,3.4,5.5Z",
  },
};

export type ToothProps = {
  toothType: ToothType;
  arch: ArchSide;
  condition: ToothVisualState;
  size?: number;
  className?: string;
  ariaLabel?: string;
};

export function Tooth({ toothType, arch, condition, size = 40, className, ariaLabel }: ToothProps) {
  const shape = TOOTH_SHAPES[toothType];
  const tone = TOOTH_CONDITION_CLASSES[condition];
  const strokeWidth = CONDITION_STROKE_WIDTH[condition];
  const isMissing = condition === "missing_extracted";

  const [, , vbWidthRaw, vbHeightRaw] = shape.viewBox.split(" ");
  const vbWidth = Number(vbWidthRaw);
  const vbHeight = Number(vbHeightRaw);

  // Upper arch: crown-down (as authored — these source illustrations are
  // drawn root-up/crown-down). Lower arch: flip vertically so the crown
  // points up toward the bite line, root hanging down — the standard
  // two-row dental-chart convention.
  const flipTransform = arch === "lower" ? `matrix(1,0,0,-1,0,${vbHeight})` : undefined;

  return (
    <svg
      viewBox={shape.viewBox}
      width={size}
      height={(size * vbHeight) / vbWidth}
      className={cn("overflow-visible", className)}
      role="img"
      aria-label={ariaLabel}
    >
      <g transform={flipTransform} opacity={isMissing ? 0.5 : 1}>
        <path
          d={shape.outline}
          className={cn(tone.fill, tone.stroke)}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeDasharray={isMissing ? "2.5 2" : undefined}
        />
        {shape.highlight && !isMissing && (
          <path d={shape.highlight} className="tooth-gloss fill-tooth-gloss" opacity={0.75} />
        )}
        {isMissing && (
          <path
            d={`M${vbWidth * 0.28},${vbHeight * 0.15} L${vbWidth * 0.72},${vbHeight * 0.92} M${vbWidth * 0.72},${vbHeight * 0.15} L${vbWidth * 0.28},${vbHeight * 0.92}`}
            className="stroke-tooth-missing-line"
            strokeWidth={0.6}
            strokeLinecap="round"
          />
        )}
      </g>
    </svg>
  );
}
