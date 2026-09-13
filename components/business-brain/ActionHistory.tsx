"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OutcomeView } from "@/lib/business-brain/outcomes-view";

/**
 * What the clinic has already done, and what the records say followed.
 *
 * ## Why this is a footnote and not a dashboard
 *
 * The page's job is what to do today. This is a look back — useful, and never the
 * headline — so it sits last, collapsed, below everything that needs action. It
 * is deliberately not an analytics surface: no charts, no totals, no rates, no
 * time range picker. A short list of things that were done, newest first.
 *
 * ## The distinction the copy has to hold
 *
 * Each row separates two claims that are easy to blur:
 *
 *   the title      — someone recorded that this was done
 *   "since been seen to" — the clinic's own records confirm the intended result
 *                          for specific patients
 *
 * A row with no confirmation line is the normal case, not a failure: most
 * categories have no population whose subsequent behaviour could confirm
 * anything. It renders as absence rather than as a zero, because "0 of 8" and
 * "this cannot be checked" read the same at a glance and mean opposite things.
 *
 * Nothing here says an action caused anything. The strongest connective in the
 * whole component is "since".
 */
export function ActionHistory({ outcomes }: { outcomes: readonly OutcomeView[] }) {
  const [open, setOpen] = useState(false);

  // No empty state. A clinic that has completed nothing has nothing to look back
  // on, and a box saying so is filler.
  if (outcomes.length === 0) return null;

  const verifiedCount = outcomes.filter((o) => o.isVerified).length;

  return (
    <section className="bg-surface border border-border rounded-xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-background transition-colors cursor-pointer rounded-xl"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-text-primary">
            What you&rsquo;ve already done
          </span>
          <span className="block text-xs text-text-secondary mt-0.5">
            {outcomes.length} action{outcomes.length === 1 ? "" : "s"} marked done in the last
            month
            {verifiedCount > 0 && ` · ${verifiedCount} we could check against your records`}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-text-disabled transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      <div className="disclosure" data-open={open}>
        <div>
          <ul className="divide-y divide-surface-muted border-t border-surface-muted">
            {outcomes.map((outcome) => (
              <li key={outcome.id} className="flex items-start gap-3 px-5 py-3">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-text-disabled"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-text-primary">{outcome.title}</span>
                    <span className="text-xs text-text-disabled shrink-0">
                      {outcome.whenLabel}
                    </span>
                  </div>
                  {outcome.verified && (
                    <p className="text-sm text-text-secondary mt-0.5">{outcome.verified}</p>
                  )}
                  {outcome.movement && (
                    <p className="text-sm text-text-secondary mt-0.5">{outcome.movement}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
