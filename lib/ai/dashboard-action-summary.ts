/**
 * lib/ai/dashboard-action-summary.ts
 *
 * Parses and verifies the model's response to buildDashboardActionSummaryPrompt.
 *
 * Pure and deterministic — no model, no I/O — mirroring the split
 * business-brain/engines/ai-explanation-engine.ts already uses: the prompt
 * asks for good behaviour, this file is what actually enforces it. A rewritten
 * line that fails verification is discarded, never shown; the caller falls
 * back to the original deterministic fact for that item, which is exactly
 * what CLAUDE.md §13.11's "fail gracefully" means for a wording pass — worst
 * case, an item shows its plain (rather than AI-polished) sentence.
 */

/** Advisory verbs the model was told not to use. Kept local — this is a much narrower surface than a full diagnosis explanation. */
const ADVISORY_PATTERNS: readonly RegExp[] = [
  /\bshould\b/i,
  /\bconsider\b/i,
  /\brecommend(s|ed|ing|ation|ations)?\b/i,
  /\btry\b/i,
  /\bneed to\b/i,
  /\bmust\b/i,
  /\bought to\b/i,
  /\bsuggest(s|ed|ing|ion|ions)?\b/i,
  /\badvis(e|es|ed|ing|able)\b/i,
];

/** One rewritten line is allowed to run a little longer than the source fact, never wildly so. */
const MAX_CHARS = 220;

/** Every number in a string, normalised so "4", "4.0" and "4," compare equal. */
function numbersIn(text: string): string[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((raw) => {
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? String(n) : raw;
  });
}

/**
 * True when `text` only restates facts already present in `fact` (or contains
 * no advisory language, and is a sane length). Deliberately the same shape of
 * check as verifyExplanation — a wrong or invented number in a dashboard
 * summary is worse than no AI polish at all.
 */
function isFaithfulRewrite(text: string, fact: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CHARS) return false;
  if (ADVISORY_PATTERNS.some((p) => p.test(trimmed))) return false;

  const permitted = new Set(numbersIn(fact));
  for (const n of numbersIn(trimmed)) {
    if (!permitted.has(n)) return false;
  }
  return true;
}

/**
 * Parse the model's numbered-line response and return only the lines that
 * pass verification, keyed by the matching item's id.
 *
 * Anything that doesn't parse as a numbered line, or fails verification, is
 * simply absent from the result — the caller renders that item's original
 * deterministic fact instead. Never throws.
 */
export function parseDashboardActionSummary(
  raw: string,
  items: readonly { id: string; fact: string }[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const text = match[2].trim();
    const item = items[index];
    if (!item) continue;
    if (result.has(item.id)) continue; // first line for a given number wins
    if (isFaithfulRewrite(text, item.fact)) {
      result.set(item.id, text);
    }
  }

  return result;
}
