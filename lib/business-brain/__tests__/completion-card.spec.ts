/**
 * The briefing card a completion is recorded against is checked, never trusted.
 */

import { describe, expect, it } from "vitest";

import { isCurrentCompletionCard } from "../completion-card";

const CLINIC = "3f2b1c4d-0000-4000-8000-00000000abcd";
const OTHER = "9a8b7c6d-0000-4000-8000-00000000dcba";
const TODAY = "2026-09-13";
const card = (category: string, clinic: string, date: string) => `constraint.${category}:${clinic}:${date}`;

describe("isCurrentCompletionCard", () => {
  it("accepts this clinic's card for this category from today back a week, and tomorrow", () => {
    for (const date of ["2026-09-06", "2026-09-12", TODAY, "2026-09-14"]) {
      expect(isCurrentCompletionCard(card("retention", CLINIC, date), "retention", CLINIC, TODAY), date).toBe(true);
    }
  });

  it("refuses a card older than a week, or further ahead than tomorrow", () => {
    expect(isCurrentCompletionCard(card("retention", CLINIC, "2026-09-05"), "retention", CLINIC, TODAY)).toBe(false);
    expect(isCurrentCompletionCard(card("retention", CLINIC, "2026-09-15"), "retention", CLINIC, TODAY)).toBe(false);
  });

  it("works across a month and a year boundary", () => {
    expect(isCurrentCompletionCard(card("retention", CLINIC, "2025-12-31"), "retention", CLINIC, "2026-01-01")).toBe(true);
    expect(isCurrentCompletionCard(card("retention", CLINIC, "2026-01-01"), "retention", CLINIC, "2025-12-31")).toBe(true);
    expect(isCurrentCompletionCard(card("retention", CLINIC, "2026-02-28"), "retention", CLINIC, "2026-03-07")).toBe(true);
    expect(isCurrentCompletionCard(card("retention", CLINIC, "2026-02-27"), "retention", CLINIC, "2026-03-07")).toBe(false);
  });

  it("refuses another clinic's card, another category's card, and anything malformed", () => {
    expect(isCurrentCompletionCard(card("retention", OTHER, TODAY), "retention", CLINIC, TODAY)).toBe(false);
    expect(isCurrentCompletionCard(card("capacity", CLINIC, TODAY), "retention", CLINIC, TODAY)).toBe(false);
    for (const id of [
      "",
      "c",
      `constraint.retention:${CLINIC}`,
      `constraint.retention:${CLINIC}:13-09-2026`,
      `constraint.retention:${CLINIC}:${TODAY}:extra`,
      ` constraint.retention:${CLINIC}:${TODAY}`,
      `constraint.retention:${CLINIC.toUpperCase()}x:${TODAY}`,
      `constraint.Retention:${CLINIC}:${TODAY}`,
    ]) {
      expect(isCurrentCompletionCard(id, "retention", CLINIC, TODAY), id).toBe(false);
    }
  });
});
