"use client";

import { useState, useTransition } from "react";
import { decideLearningProposal } from "@/actions/business-brain";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OutcomeView, WhatHappenedView } from "@/lib/business-brain/outcomes-view";

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
                  {outcome.whatHappened && <WhatHappened detail={outcome.whatHappened} />}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * The evidence behind one completed action, collapsed by default.
 *
 * A native <details> element: one row's detail is a footnote to a footnote and
 * needs no state of its own. Attribution first, then the measurements, then what
 * became of the problem, then — only when a learning cleared its threshold — what
 * this clinic's own history shows.
 */
function WhatHappened({ detail }: { detail: WhatHappenedView }) {
  return (
    <details className="group mt-1.5">
      <summary className="inline-flex items-center gap-1 text-xs text-text-secondary cursor-pointer select-none hover:text-text-primary list-none [&::-webkit-details-marker]:hidden">
        What happened after?
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-1.5 space-y-1 border-l border-surface-muted pl-3">
        <p className="text-xs font-medium text-text-primary">{detail.attributionLabel}</p>
        {detail.evidence.map((line) => (
          <p key={line} className="text-xs text-text-secondary">
            {line}
          </p>
        ))}
        {detail.resolution && <p className="text-xs text-text-secondary">{detail.resolution}</p>}
        {detail.learning && <p className="text-xs text-text-primary">{detail.learning}</p>}
        {detail.proposal && <ProposalDecision proposal={detail.proposal} />}
      </div>
    </details>
  );
}

/**
 * A suggestion from the clinic's own history, and the dentist's choice on it.
 *
 * Deciding writes one append-only row. It changes nothing about what the Business
 * Brain recommends; the wording says so, so nobody reads "Accept" as a switch.
 */
function ProposalDecision({ proposal }: { proposal: NonNullable<WhatHappenedView["proposal"]> }) {
  const [decision, setDecision] = useState(proposal.decision);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const decide = (choice: "accepted" | "rejected") =>
    startTransition(async () => {
      setError(null);
      const res = await decideLearningProposal({ proposalId: proposal.id, decision: choice });
      if (res.error) setError(res.error);
      else setDecision(choice);
    });

  return (
    <div className="pt-1">
      <p className="text-xs text-text-secondary">{proposal.statement}</p>
      {decision ? (
        <p className="text-xs text-text-disabled mt-0.5">
          {decision === "accepted" ? "You accepted this suggestion." : "You marked this suggestion as not for your clinic."} Nothing
          changes automatically.
        </p>
      ) : (
        <div className="flex items-center gap-3 mt-1">
          <button
            type="button"
            disabled={pending}
            onClick={() => decide("accepted")}
            className="text-xs font-medium text-text-primary hover:underline disabled:opacity-50 cursor-pointer"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => decide("rejected")}
            className="text-xs text-text-secondary hover:underline disabled:opacity-50 cursor-pointer"
          >
            Not for us
          </button>
        </div>
      )}
      {error && <p className="text-xs text-danger mt-0.5">{error}</p>}
    </div>
  );
}
