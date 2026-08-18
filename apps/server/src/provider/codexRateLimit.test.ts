import { assert, it } from "@effect/vitest";

import { mapCodexRateLimitSnapshot } from "./codexRateLimit.ts";

it("maps rolling Codex windows and marks exhausted subscriptions full", () => {
  assert.deepStrictEqual(
    mapCodexRateLimitSnapshot({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
      rateLimitReachedType: "rate_limit_reached",
    }),
    {
      isFull: true,
      windows: [
        { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
      ],
    },
  );
});

it("keeps available Codex subscriptions eligible below both limits", () => {
  assert.deepStrictEqual(
    mapCodexRateLimitSnapshot({
      primary: { usedPercent: 12 },
      secondary: { usedPercent: 88 },
      rateLimitReachedType: null,
    }),
    {
      isFull: false,
      windows: [{ usedPercent: 12 }, { usedPercent: 88 }],
    },
  );
});

it("omits Codex quota snapshots without windows or a blocking limit", () => {
  assert.strictEqual(mapCodexRateLimitSnapshot({}), undefined);
});

it("keeps blocked Codex quota snapshots without windows", () => {
  assert.deepStrictEqual(mapCodexRateLimitSnapshot({ spendControlReached: true }), {
    isFull: true,
    windows: [],
  });
});
