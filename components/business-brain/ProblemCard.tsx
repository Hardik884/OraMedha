"use client";

import { useState, useTransition } from "react";
import { ChevronDown, BellOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { dismissProblem } from "@/actions/business-brain";
import { cn } from "@/lib/utils";
import type { ProblemView } from "@/lib/business-brain/briefing-view";

/**
 * Severity stripe down the left edge of a problem card. This is an ordered
 * scale, not a set of independent labels, so it gets its own tokens: dark mode
 * needs the five steps to stay distinguishable AND stay in order, which a
 * per-colour remap would not guarantee.
 */
const STRIPE: Record<string, string> = {
  critical: "bg-severity-critical",
  high: "bg-severity-high",
  medium: "bg-severity-medium",
  low: "bg-severity-low",
  info: "bg-severity-info",
};

/**
 * The same scale in words.
 *
 * The stripe alone carried urgency until now, which meant the ordering of the
 * cards was the only clue for anyone who cannot separate five hues at a glance —
 * and colour is the first thing lost to a monochrome print, a glare-washed
 * screen in a surgery, or colour-blindness. The stripe stays decorative
 * (`aria-hidden`); this is what actually states the severity.
 *
 * Plain words, not the engine's: a dentist reads "Urgent", not "critical".
 */
const SEVERITY_LABEL: Record<string, string> = {
  critical: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Minor",
};

const SEVERITY_TEXT: Record<string, string> = {
  critical: "text-severity-critical",
  high: "text-severity-high",
  medium: "text-severity-medium",
  low: "text-severity-low",
  info: "text-severity-info",
};

/**
 * How long the problem has been going on, beside how big it is.
 *
 * A separate scale from severity on purpose: a small problem getting worse and a
 * large one receding are different messages, and the chip must not read as a
 * second opinion on urgency. Hence the muted treatment — a border and a word,
 * never a filled badge competing with the severity label.
 *
 * "Improving" earns the only positive colour on a problem card. It is still a
 * problem; the direction of travel is simply worth seeing without expanding.
 */
const TREND_TONE: Record<string, string> = {
  worsening: "border-severity-high/40 text-severity-high",
  improving: "border-success/40 text-success",
  neutral: "border-border text-text-secondary",
};

/**
 * One problem, left column. Collapsed it shows only the title, one concrete
 * summary line, and a short plain-English explanation — nothing a dentist has to
 * decode. "Show more" reveals how to fix it and why we think it, and nothing
 * else: no confidence, no metrics, no engine reasoning.
 */
export function ProblemCard({ problem }: { problem: ProblemView }) {
  const [open, setOpen] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submitSnooze() {
    setError(null);
    startTransition(async () => {
      const res = await dismissProblem({
        category: problem.category,
        // Bound to the severity shown on THIS card. If the problem escalates
        // past it, the snooze stops applying and the card returns.
        severityAtDismissal: problem.severity,
        reason,
        days,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      // The card only leaves on the next server read — the same rule the rest
      // of the briefing follows, so nothing disappears on optimism alone.
      setSnoozing(false);
      router.refresh();
    });
  }

  return (
    <section className="bg-surface border border-border rounded-xl overflow-hidden flex">
      <div className={cn("w-1 shrink-0", STRIPE[problem.severity] ?? STRIPE.info)} aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="px-5 py-4">
          {/* Mirrors the owner/timeframe chip row on the paired ActionCard, so
              the two columns line up and read as one row. */}
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                SEVERITY_TEXT[problem.severity] ?? SEVERITY_TEXT.info,
              )}
            >
              {SEVERITY_LABEL[problem.severity] ?? SEVERITY_LABEL.info}
            </span>
            {problem.trend && (
              <span
                className={cn(
                  "text-[10px] font-medium rounded-full border px-1.5 py-px leading-4",
                  TREND_TONE[problem.trend.tone] ?? TREND_TONE.neutral,
                )}
              >
                {problem.trend.label}
              </span>
            )}
          </div>
          <div className="flex items-start justify-between gap-4">
            <h3 className="text-[15px] font-semibold text-text-primary leading-snug">{problem.title}</h3>
            {problem.atStake && (
              <div className="text-right shrink-0">
                <div className="text-lg font-semibold text-text-primary tabular-nums leading-none">
                  {problem.atStake}
                </div>
                {problem.atStakeLabel && (
                  <div className="text-[11px] text-text-secondary mt-0.5">{problem.atStakeLabel}</div>
                )}
              </div>
            )}
          </div>
          <p className="text-sm text-text-body mt-1.5">{problem.summary}</p>
          <p className="text-sm text-text-secondary mt-2 leading-relaxed">{problem.explanation}</p>
        </div>

        {(problem.howToFix || problem.whyWeThink) && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="w-full flex items-center justify-between gap-3 px-5 py-2.5 border-t border-surface-muted text-left hover:bg-background transition-colors cursor-pointer"
            >
              <span className="text-sm text-text-body">{open ? "Show less" : "Show more"}</span>
              <ChevronDown
                className={cn("h-4 w-4 text-text-disabled shrink-0 transition-transform", open && "rotate-180")}
                aria-hidden
              />
            </button>
            {open && (
              <div className="px-5 pb-5 pt-1 space-y-4 animate-fade-in">
                {problem.howToFix && (
                  <div>
                    <p className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1">How to fix this</p>
                    <p className="text-sm text-text-body leading-relaxed">{problem.howToFix}</p>
                  </div>
                )}
                {problem.whyWeThink && (
                  <div>
                    <p className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1">Why we think this</p>
                    <p className="text-sm text-text-body leading-relaxed">{problem.whyWeThink}</p>
                  </div>
                )}
                {/* The sentence behind the chip. On the card face there is only
                    room for two words; this is what those two words mean. */}
                {problem.trend && (
                  <div>
                    <p className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-1">How long this has been going on</p>
                    <p className="text-sm text-text-body leading-relaxed">{problem.trend.detail}</p>
                  </div>
                )}
                {/* Snooze — the one place the dentist can tell the briefing it
                    is wrong. Deliberately inside "Show more" rather than on the
                    card face: dismissing should cost a deliberate click, not sit
                    next to the actions as an easier alternative to doing them. */}
                <div className="pt-3 border-t border-surface-muted">
                  {!snoozing ? (
                    <button
                      type="button"
                      onClick={() => setSnoozing(true)}
                      className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-body transition-colors cursor-pointer"
                    >
                      <BellOff className="h-3.5 w-3.5" aria-hidden />
                      Not relevant right now
                    </button>
                  ) : (
                    <div className="space-y-2.5">
                      <label htmlFor={`why-${problem.id}`} className="block text-xs font-medium text-text-secondary">
                        Why is this not relevant? We use these to fix what keeps
                        flagging wrongly.
                      </label>
                      <input
                        id={`why-${problem.id}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. these patients are on an agreed payment plan"
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={days}
                          onChange={(e) => setDays(Number(e.target.value))}
                          aria-label="How long to hide this for"
                          className="rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-text-primary"
                        >
                          <option value={7}>Hide for a week</option>
                          <option value={14}>Hide for 2 weeks</option>
                          <option value={30}>Hide for a month</option>
                          <option value={90}>Hide for 3 months</option>
                        </select>
                        <button
                          type="button"
                          onClick={submitSnooze}
                          disabled={pending || reason.trim().length < 3}
                          className="rounded-lg bg-accent text-accent-foreground px-3.5 py-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer hover:bg-accent-hover transition-colors"
                        >
                          {pending ? "Hiding…" : "Hide it"}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setSnoozing(false); setError(null); }}
                          className="text-sm text-text-secondary hover:text-text-body cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                      {/* Stated plainly, because it is the thing that makes
                          hiding safe to offer at all. */}
                      <p className="text-[11px] text-text-disabled leading-relaxed">
                        It comes back sooner if it gets worse.
                      </p>
                      {error && <p className="text-xs text-danger">{error}</p>}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
