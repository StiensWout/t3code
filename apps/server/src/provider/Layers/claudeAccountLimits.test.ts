import { describe, expect, it } from "@effect/vitest";

import { normalizeClaudeUsage, tierLabel } from "./claudeAccountLimits.ts";

describe("normalizeClaudeUsage", () => {
  it("reads the structured limits array, naming scoped weekly buckets after their model", () => {
    expect(
      normalizeClaudeUsage(
        {
          limits: [
            { kind: "session", percent: 40, resets_at: "2026-09-03T09:40:00+00:00", scope: null },
            {
              kind: "weekly_all",
              percent: 18,
              resets_at: "2026-09-08T11:00:00+00:00",
              scope: null,
            },
            {
              kind: "weekly_scoped",
              percent: 36,
              resets_at: "2026-09-08T11:00:00+00:00",
              scope: { model: { display_name: "Fable" }, surface: null },
            },
          ],
          five_hour: { utilization: 99, resets_at: null },
        },
        "Max 20x",
      ),
    ).toEqual({
      plan: "Max 20x",
      windows: [
        {
          id: "five_hour",
          label: "5 hour",
          usedPercent: 40,
          resetsAt: "2026-09-03T09:40:00+00:00",
          windowMinutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly",
          usedPercent: 18,
          resetsAt: "2026-09-08T11:00:00+00:00",
          windowMinutes: 10080,
        },
        {
          id: "seven_day_fable",
          label: "Weekly Fable",
          usedPercent: 36,
          resetsAt: "2026-09-08T11:00:00+00:00",
          windowMinutes: 10080,
        },
      ],
    });
  });

  it("falls back to the named top-level windows without a limits array", () => {
    expect(
      normalizeClaudeUsage(
        {
          five_hour: { utilization: 31, resets_at: "2026-09-03T09:40:00+00:00" },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: null, resets_at: null },
        },
        "Pro",
      ).windows.map((window) => [window.id, window.usedPercent]),
    ).toEqual([["five_hour", 31]]);
  });

  it("derives the tier from the rate limit tier before the subscription type", () => {
    expect(tierLabel("max", "default_claude_max_20x")).toBe("Max 20x");
    expect(tierLabel("max", "default_claude_max_5x")).toBe("Max 5x");
    expect(tierLabel("pro", null)).toBe("Pro");
    expect(tierLabel(null, null)).toBeNull();
  });
});
