import { describe, expect, it } from "@effect/vitest";

import { normalizeCodexRateLimits } from "./codexRateLimits.ts";

describe("normalizeCodexRateLimits", () => {
  it("maps primary and secondary windows with plan and reset credits", () => {
    const update = normalizeCodexRateLimits(
      {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 42, resetsAt: 1_800_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 67, resetsAt: 1_800_500_000, windowDurationMins: 10080 },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            { status: "redeemed", expiresAt: 1_700_000_000 },
            { status: "available", expiresAt: 1_801_000_000 },
            { status: "available", expiresAt: 1_800_900_000 },
          ],
        },
      },
      { complete: true },
    );

    expect(update).toEqual({
      complete: true,
      plan: "Pro",
      windows: [
        {
          id: "primary",
          label: "5 hour",
          usedPercent: 42,
          resetsAt: "2027-01-15T08:00:00.000Z",
          windowMinutes: 300,
        },
        {
          id: "secondary",
          label: "Weekly",
          usedPercent: 67,
          resetsAt: "2027-01-21T02:53:20.000Z",
          windowMinutes: 10080,
        },
      ],
      resetCredits: { availableCount: 2, nextExpiresAt: "2027-01-25T18:00:00.000Z" },
    });
  });

  it("leaves plan and credits untouched when the payload omits them", () => {
    const update = normalizeCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 130 } } },
      { complete: false },
    );

    expect(update).toEqual({
      complete: false,
      windows: [
        { id: "primary", label: "5 hour", usedPercent: 100, resetsAt: null, windowMinutes: null },
      ],
    });
    expect("plan" in update).toBe(false);
    expect("resetCredits" in update).toBe(false);
  });
});
