import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectProviderQuotaUsage } from "./providerQuota";

function provider(input: {
  readonly id: string;
  readonly displayName?: string;
  readonly driver?: "codex" | "claudeAgent";
  readonly primaryUsedPercent?: number;
  readonly secondaryUsedPercent?: number;
  readonly full?: boolean;
}): ServerProvider {
  const driver = ProviderDriverKind.make(input.driver ?? "codex");
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver,
    displayName: input.displayName ?? input.id,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: "authenticated",
      type: "chatgpt",
      label:
        input.driver === "claudeAgent" ? "Claude Max Subscription" : "ChatGPT Pro Subscription",
    },
    checkedAt: "2026-08-17T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.primaryUsedPercent === undefined && input.secondaryUsedPercent === undefined
      ? {}
      : {
          rateLimit: {
            isFull: input.full ?? false,
            windows: [
              ...(input.primaryUsedPercent === undefined
                ? []
                : [
                    {
                      usedPercent: input.primaryUsedPercent,
                      windowDurationMins: 300,
                    },
                  ]),
              ...(input.secondaryUsedPercent === undefined
                ? []
                : [
                    {
                      usedPercent: input.secondaryUsedPercent,
                      windowDurationMins: 10_080,
                    },
                  ]),
            ],
          },
        }),
  };
}

describe("collectProviderQuotaUsage", () => {
  it("shows the most constrained quota window for every reporting account", () => {
    expect(
      collectProviderQuotaUsage([
        {
          label: "Local",
          serverConfig: {
            providers: [
              provider({
                id: "codex-private",
                displayName: "Codex Private",
                primaryUsedPercent: 12,
                secondaryUsedPercent: 40,
              }),
              provider({
                id: "codex-work",
                displayName: "Codex Work",
                primaryUsedPercent: 100,
                full: true,
              }),
            ],
          },
        },
      ]),
    ).toMatchObject([
      { name: "Codex Private", remainingPercent: 60, windowLabel: "Weekly", isFull: false },
      { name: "Codex Work", remainingPercent: 0, windowLabel: "5-hour", isFull: true },
    ]);
  });

  it("excludes providers that only report token counts or account metadata", () => {
    expect(
      collectProviderQuotaUsage([
        {
          label: "Remote",
          serverConfig: {
            providers: [
              provider({ id: "Codex", primaryUsedPercent: 20 }),
              provider({ id: "Claude", driver: "claudeAgent" }),
            ],
          },
        },
      ]).map((row) => row.name),
    ).toEqual(["Codex"]);
  });

  it("is capability-based when another provider reports real quota", () => {
    expect(
      collectProviderQuotaUsage([
        {
          label: "Remote",
          serverConfig: {
            providers: [provider({ id: "Claude", driver: "claudeAgent", primaryUsedPercent: 30 })],
          },
        },
      ])[0],
    ).toMatchObject({
      driver: ProviderDriverKind.make("claudeAgent"),
      providerLabel: "Claude",
      remainingPercent: 70,
    });
  });
});
