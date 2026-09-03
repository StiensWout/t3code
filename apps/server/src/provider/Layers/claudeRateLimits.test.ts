import { describe, expect, it } from "@effect/vitest";

import { normalizeClaudeRateLimit } from "./claudeRateLimits.ts";

describe("normalizeClaudeRateLimit", () => {
  it("maps one window per event from a utilization fraction", () => {
    expect(
      normalizeClaudeRateLimit({
        status: "allowed_warning",
        rateLimitType: "seven_day_opus",
        utilization: 0.91,
        resetsAt: 1_800_000_000,
      }),
    ).toEqual({
      complete: false,
      windows: [
        {
          id: "seven_day_opus",
          label: "Weekly Opus",
          usedPercent: 91,
          resetsAt: "2027-01-15T08:00:00.000Z",
          windowMinutes: 10080,
        },
      ],
    });
  });

  it("treats a rejection without utilization as a full window", () => {
    expect(
      normalizeClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour" })?.windows[0]
        ?.usedPercent,
    ).toBe(100);
  });

  it("names scoped weekly buckets after their model so reads and events share rows", () => {
    expect(
      normalizeClaudeRateLimit({
        status: "allowed",
        rateLimitType: "seven_day_fable",
        utilization: 0.36,
      })?.windows[0],
    ).toMatchObject({ id: "seven_day_fable", label: "Weekly Fable", usedPercent: 36 });
  });

  it("drops events without a known window", () => {
    expect(normalizeClaudeRateLimit({ status: "allowed", utilization: 0.2 })).toBeNull();
    expect(
      normalizeClaudeRateLimit({ status: "allowed", rateLimitType: "mystery", utilization: 0.2 }),
    ).toBeNull();
  });
});
