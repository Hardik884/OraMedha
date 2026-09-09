"use client";

/**
 * components/dental-chart/DentalChartCard.tsx
 *
 * Client wrapper around DentalChart that adds the "View Full Dental Chart"
 * expand toggle. Renders the compact, column-width card by default; expanded,
 * it renders the SAME DentalChart at full width in a fixed overlay portalled
 * onto <body> — INLINE, no navigation, no page reload, no lost scroll
 * position on whatever page it is embedded in.
 *
 * WHY A PORTAL AND NOT JUST A WIDER DIV
 *   DentalChart's arch needs ~640px (`min-w-[640px]`) and this card lives in a
 *   narrower column on both pages that embed it, so simply removing the
 *   column's width constraint would still be capped by the column's own
 *   ancestor (`overflow-x-auto` on the page, grid tracks, etc.). A portal
 *   render on <body> escapes all of that, the same technique
 *   components/ui/calendar-picker.tsx already uses for its popover.
 *
 * WHY NOT A RADIX DIALOG
 *   DentalChart's own tooth-detail panel and bulk-update dialog ARE Dialogs.
 *   Wrapping the whole chart in another Dialog means two focus traps and two
 *   body-scroll locks in play at once, and Escape closes both instead of just
 *   the top one. This overlay is a plain fixed-position panel with no focus
 *   trap of its own, so the chart's own dialogs keep working exactly as they
 *   do in the compact card.
 *
 * This replaced navigating to /dentist/patients/[id]/dental-chart from every
 * place that embeds the chart. That route still exists for a direct/bookmarked
 * link, but nothing in the product navigates to it as the way to see the full
 * chart any more — see PatientDentalChartSection.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, X } from "lucide-react";
import { DentalChart, type DentalChartProps } from "./DentalChart";

interface DentalChartCardProps extends DentalChartProps {
  /** Show the "View Full Dental Chart" expand toggle. */
  canExpand?: boolean;
}

export function DentalChartCard({ canExpand = false, ...chartProps }: DentalChartCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Escape closes the overlay — but only when neither of the chart's own
  // Dialogs is open. Radix Dialogs stop propagation on their own Escape
  // handler, so this only ever fires when nothing else already claimed it.
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Lock body scroll while the overlay is open, same as a modal would —
  // identical pattern to components/ui/dialog.tsx's own lock, so the two
  // agree about what "closed" means for document.body.style.overflow.
  useEffect(() => {
    if (expanded) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [expanded]);

  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-text-primary">Dental Chart</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Click a tooth to set its condition and treatment status, or add a treatment.
          </p>
        </div>

        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-1.5 shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-muted transition-colors"
          >
            <Maximize2 className="h-3 w-3" aria-hidden />
            View Full Dental Chart
          </button>
        )}
      </div>

      {/*
       * Not rendered while expanded. DentalChart owns real state (dentition,
       * the fetched chart, tooth selection) — mounting a second live instance
       * in the overlay below while this one stays mounted would give the two
       * independent copies of that state, which could drift the moment either
       * one is edited.
       */}
      {!expanded && <DentalChart {...chartProps} />}

      {expanded &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[100] bg-background flex flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
              <div>
                <h2 className="font-semibold text-text-primary">Dental Chart</h2>
                {chartProps.patientName && (
                  <p className="text-xs text-text-secondary mt-0.5">{chartProps.patientName}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1.5 shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-muted transition-colors"
                aria-label="Close full dental chart"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              <DentalChart {...chartProps} />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
