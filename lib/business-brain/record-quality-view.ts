/**
 * lib/business-brain/record-quality-view.ts
 *
 * The projection behind the "How your day is recorded" card.
 *
 * Same split as every other view here: `business-brain/ledger/record-quality.ts`
 * counts, `lib/business-brain/record-quality.ts` reads, and this file writes the
 * sentences — including the one thing that makes the card worth showing at all,
 * which is where each gap is closed.
 *
 * ## Every line names what the gap COSTS
 *
 * A recording gap is not a rule broken; it is a measurement lost. A clinic that
 * never uses the queue board is making a legitimate choice, and the honest thing
 * to tell it is which figures go quiet as a result — never that it is doing
 * something wrong. So each line reads "wait times cannot be measured", not "you
 * should check patients in".
 *
 * Pure. Counts in, copy out.
 */

import { RecordCheck } from "@/business-brain";
import type { ClinicRecordQuality } from "./record-quality";

/** One line of the card. */
export interface RecordQualityLine {
  readonly id: string;
  /** What is being recorded, in the clinic's words. */
  readonly label: string;
  /** Where it stands, one line. */
  readonly detail: string;
  /** What cannot be measured while the gap is there. Null when there is no gap. */
  readonly cost: string | null;
  /** Where the gap is closed, when there is somewhere to go. */
  readonly fix: { readonly href: string; readonly label: string } | null;
}

export interface RecordQualityView {
  /** "92% of the last 30 days' records are complete", or the honest absence. */
  readonly headline: string;
  /** Present only when the score exists. */
  readonly score: number | null;
  /** One line per check, gaps first — the lines a dentist can act on. */
  readonly lines: readonly RecordQualityLine[];
  /**
   * How the window's no-shows were established, stated plainly.
   *
   * Its own field because it is not only a recording gap: a rate that mixes a
   * person's observation with the nightly job's inference implies someone
   * watched a patient not arrive. Null when there were no no-shows — which is
   * not the same as none being inferred.
   */
  readonly noShowBasis: string | null;
}

interface CheckCopy {
  readonly label: string;
  /** What this measures, as a noun the counts fit into: "12 of 20 <noun>". */
  readonly noun: string;
  readonly cost: string;
  readonly fix: { readonly href: string; readonly label: string } | null;
}

const COPY: Readonly<Record<string, CheckCopy>> = {
  [RecordCheck.ARRIVALS]: {
    label: "Arrivals",
    noun: "visits had the patient checked in",
    cost: "Without a check-in there is no arrival time, so lateness and waiting cannot be measured.",
    fix: { href: "/dentist/queue", label: "Check patients in on the Queue" },
  },
  [RecordCheck.CALL_INS]: {
    label: "Call-ins",
    noun: "checked-in visits recorded when the patient was called",
    cost: "A wait with only one end is unmeasured, not zero — those visits are left out of your waiting times entirely.",
    fix: { href: "/dentist/queue", label: "Use Call Next when you start a visit" },
  },
  [RecordCheck.VISIT_OUTCOMES]: {
    label: "Visit outcomes",
    noun: "finished visits were closed as completed, cancelled or missed",
    cost: "A visit left open after its day has no outcome at all: it counts as neither attended nor missed.",
    fix: { href: "/dentist/appointments", label: "Close the open visits" },
  },
  [RecordCheck.TREATMENT_DATES]: {
    label: "Treatment dates",
    noun: "completed treatments say when they were performed",
    cost: "Without a performed date the treatment is dated by when it was typed in, which moves it to whichever day the paperwork was done.",
    fix: { href: "/dentist/treatments", label: "Set the performed date" },
  },
  [RecordCheck.NO_SHOW_MARKS]: {
    label: "Missed appointments",
    noun: "no-shows were marked by your team",
    cost: "The rest were inferred overnight from a visit nobody closed — a reading, not something anyone saw.",
    fix: { href: "/dentist/appointments", label: "Mark missed appointments" },
  },
};

/** Gaps first, then unknowns, then everything complete. */
const ORDER: Readonly<Record<string, number>> = {
  gaps: 0,
  unknown: 1,
  complete: 2,
  nothing_to_record: 3,
};

export function buildRecordQualityView(
  quality: ClinicRecordQuality | null,
): RecordQualityView | null {
  if (quality === null) return null;

  const lines: RecordQualityLine[] = [...quality.checks]
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
    .map((check) => {
      const copy = COPY[check.check];
      const label = copy?.label ?? check.check;
      if (check.status === "unknown") {
        return {
          id: check.check,
          label,
          // Not "0 of 20". The question could not be asked, and that is a
          // different answer from nobody having recorded anything.
          detail: "Could not be read.",
          cost: null,
          fix: null,
        };
      }
      if (check.status === "nothing_to_record") {
        return {
          id: check.check,
          label,
          detail: "Nothing to record in the last 30 days.",
          cost: null,
          fix: null,
        };
      }
      const detail = `${check.recorded} of ${check.total} ${copy?.noun ?? "records"}.`;
      return {
        id: check.check,
        label,
        detail,
        cost: check.status === "complete" ? null : (copy?.cost ?? null),
        fix: check.status === "complete" ? null : (copy?.fix ?? null),
      };
    });

  const headline =
    quality.score === null
      ? "Nothing to measure in the last 30 days."
      : `${Math.round(quality.score)}% of what could be recorded in the last 30 days was.`;

  return {
    headline,
    score: quality.score,
    lines,
    noShowBasis: describeNoShows(quality),
  };
}

/**
 * The no-show split, in one sentence.
 *
 * Stated whenever there were any, including when every one was recorded — "all
 * of them were marked by your team" is the fact that makes the rate trustworthy,
 * and it is worth saying rather than leaving to be assumed.
 */
function describeNoShows(quality: ClinicRecordQuality): string | null {
  const { total, recorded, inferred, unknown } = quality.noShows;
  if (total === 0) return null;
  if (inferred === 0 && unknown === 0) {
    return `All ${total} missed appointment${total === 1 ? "" : "s"} in the last 30 days were marked by your team.`;
  }
  const parts: string[] = [];
  if (recorded > 0) parts.push(`${recorded} marked by your team`);
  if (inferred > 0) parts.push(`${inferred} inferred overnight from a visit nobody closed`);
  if (unknown > 0) parts.push(`${unknown} with no record of who marked them`);
  return `${total} missed appointment${total === 1 ? "" : "s"} in the last 30 days: ${parts.join(", ")}.`;
}
