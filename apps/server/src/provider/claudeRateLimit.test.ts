import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";

import { mapClaudeRateLimitSnapshot } from "./claudeRateLimit.ts";

function usage(rateLimits: SDKControlGetUsageResponse["rate_limits"]): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: rateLimits !== null,
    rate_limits: rateLimits,
    behaviors: null,
  };
}

it("maps Claude's five-hour window and most constrained weekly window", () => {
  assert.deepStrictEqual(
    mapClaudeRateLimitSnapshot(
      usage({
        five_hour: { utilization: 24, resets_at: "2027-01-15T08:00:00.000Z" },
        seven_day: { utilization: 40, resets_at: "2027-01-18T08:00:00.000Z" },
        seven_day_opus: { utilization: 72, resets_at: "2027-01-18T09:00:00.000Z" },
      }),
    ),
    {
      isFull: false,
      windows: [
        {
          label: "5-hour",
          usedPercent: 24,
          resetsAt: 1_800_000_000,
          windowDurationMins: 300,
        },
        {
          label: "Opus weekly",
          usedPercent: 72,
          resetsAt: 1_800_262_800,
          windowDurationMins: 10_080,
        },
      ],
    },
  );
});

it("omits quotas for sessions without Claude plan limits", () => {
  assert.equal(mapClaudeRateLimitSnapshot(usage(null)), undefined);
});
