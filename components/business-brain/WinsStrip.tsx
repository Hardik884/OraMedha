"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WinView } from "@/lib/business-brain/wins-view";

/**
 * What is going well, between the score and the work.
 *
 * ## Why this is a strip and not a column of cards
 *
 * The risk positive intelligence carries is not that the wins are false — every
 * one has cleared five measurement gates before it reaches here. It is that a
 * page showing six wins and one problem buries the problem. So this is
 * deliberately the quietest block on the page: one line each, no severity
 * stripe, no figure in large type, and a hard cap of three imposed upstream by
 * the Achievement Engine.
 *
 * ## Collapsed by default, and that is the whole design
 *
 * A win a dentist has to read is a win they skip. The collapsed line carries the
 * figure, what it is measured against, and how long it has held — everything
 * needed to decide whether to care. The reasoning and the numbers behind it are
 * one click away and never in the way.
 *
 * ## Renders nothing when there is nothing
 *
 * No empty state, no "no wins today" placeholder. A clinic inside its normal
 * range has no wins to report, and a box saying so would be the filler this
 * layer exists to avoid.
 */
export function WinsStrip({ wins }: { wins: readonly WinView[] }) {
  if (wins.length === 0) return null;

  return (
    <section aria-labelledby="wins-heading" className="bg-surface border border-border rounded-xl">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-1">
        <h2 id="wins-heading" className="text-sm font-semibold text-text-primary">
          What&rsquo;s going well
        </h2>
        <span className="text-xs text-text-disabled">
          measured against your own records
        </span>
      </div>
      <ul className="divide-y divide-surface-muted">
        {wins.map((win) => (
          <WinRow key={win.id} win={win} />
        ))}
      </ul>
    </section>
  );
}

function WinRow({ win }: { win: WinView }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-start gap-3 px-5 py-3 text-left hover:bg-background transition-colors cursor-pointer"
      >
        {/* Small, low-contrast, and the only colour on the row. A win must never
            compete with a severity stripe for the eye. */}
        <span
          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success-bg"
          aria-hidden
        >
          <Check className="h-2.5 w-2.5 text-success" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text-primary">{win.title}</span>
          <span className="block text-sm text-text-secondary mt-0.5">{win.headline}</span>
        </span>

        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-text-disabled transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {/* Height-animated so expanding pushes the page rather than covering it. */}
      <div className="disclosure" data-open={open}>
        <div>
          <div className="px-5 pb-4 pl-12">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-disabled">
              Why this is a positive outcome
            </h3>
            <p className="text-sm text-text-body mt-1 leading-relaxed">{win.explanation}</p>

            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-disabled mt-3">
              Evidence
            </h3>
            <dl className="mt-1 space-y-1">
              {win.evidence.map((item) => (
                <div key={item.label} className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm text-text-secondary">{item.label}</dt>
                  <dd className="text-sm text-text-body tabular-nums shrink-0">{item.value}</dd>
                </div>
              ))}
            </dl>

            {/* What the clinic did that sits alongside this, when anything does.
                Present only when a completed action tracked the same metric
                inside the window this win describes — and the sentence itself
                states that the two are separate facts, because nothing here can
                show that one produced the other. Still behind the same single
                disclosure: no second click, no nested dropdown. */}
            {win.whatHappenedAfter && (
              <>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-disabled mt-3">
                  What happened after
                </h3>
                <p className="text-sm text-text-body mt-1 leading-relaxed">
                  {win.whatHappenedAfter}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
