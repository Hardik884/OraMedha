"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecordQualityView } from "@/lib/business-brain/record-quality-view";

/**
 * How completely the clinic's day is recorded, and what each gap costs.
 *
 * ## Why this is on the page at all
 *
 * Every "we could not tell you" in this briefing has a cause, and the cause is
 * almost always a button nobody pressed. A visit completed without a call-in has
 * no measurable wait; a treatment with no performed date lands on whichever day
 * the paperwork was done; a no-show the nightly job inferred is a reading rather
 * than something anyone saw. The analysis handles all of that honestly — it
 * withholds, it labels, it says unknown — and the result was a clinic told less
 * and less with no way to see why.
 *
 * ## It is not a compliance score
 *
 * No target, no grade, no red, no comparison with other clinics. A practice that
 * never uses the queue board is making a legitimate choice; this says which
 * figures go quiet as a result, and every line links to the screen where the gap
 * is closed for those who want them back.
 *
 * ## Collapsed, and last
 *
 * Below the work, above the history. Nothing here is urgent — it is a standing
 * fact about the records, and a dentist should meet it after the day's problems
 * rather than instead of them.
 */
export function RecordQualityCard({ quality }: { quality: RecordQualityView | null }) {
  const [open, setOpen] = useState(false);
  if (quality === null) return null;

  const gaps = quality.lines.filter((line) => line.cost !== null).length;

  return (
    <section
      aria-labelledby="record-quality-heading"
      className="bg-surface border border-border rounded-xl"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-start gap-3 px-5 py-4 text-left hover:bg-background transition-colors cursor-pointer"
      >
        <span className="min-w-0 flex-1">
          <span
            id="record-quality-heading"
            className="block text-sm font-semibold text-text-primary"
          >
            How your day is recorded
          </span>
          <span className="block text-sm text-text-secondary mt-0.5">{quality.headline}</span>
          {gaps > 0 && (
            <span className="block text-xs text-text-disabled mt-0.5">
              {gaps === 1 ? "1 gap costs a measurement" : `${gaps} gaps cost a measurement`}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-text-disabled transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      <div className="disclosure" data-open={open}>
        <div>
          <div className="px-5 pb-4">
            <dl className="space-y-3">
              {quality.lines.map((line) => (
                <div key={line.id}>
                  <dt className="text-sm font-medium text-text-primary">{line.label}</dt>
                  <dd className="text-sm text-text-body">{line.detail}</dd>
                  {line.cost && (
                    <dd className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                      {line.cost}
                    </dd>
                  )}
                  {line.fix && (
                    <dd className="mt-1">
                      <Link
                        href={line.fix.href}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        {line.fix.label}
                      </Link>
                    </dd>
                  )}
                </div>
              ))}
            </dl>

            {/* The no-show split, stated whether or not it is a gap: a rate that
                mixes a person's observation with the nightly job's inference
                implies someone watched a patient not arrive. */}
            {quality.noShowBasis && (
              <p className="mt-4 pt-3 border-t border-surface-muted text-xs text-text-secondary leading-relaxed">
                {quality.noShowBasis}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
