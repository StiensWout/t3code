import { describe, expect, it } from "vite-plus/test";

import { shellEnvironmentRetainsAuthority } from "./shell.ts";

describe("shell notification authority", () => {
  it("retains authority through same-session synchronization", () => {
    expect(
      shellEnvironmentRetainsAuthority({
        shellStatus: "synchronizing",
        connectionPhase: "ready",
        connectionGeneration: 4,
        authoritativeGeneration: 4,
      }),
    ).toBe(true);
  });

  it("baselines a new connection generation until its shell is live", () => {
    expect(
      shellEnvironmentRetainsAuthority({
        shellStatus: "synchronizing",
        connectionPhase: "synchronizing",
        connectionGeneration: 5,
        authoritativeGeneration: 4,
      }),
    ).toBe(false);
    expect(
      shellEnvironmentRetainsAuthority({
        shellStatus: "live",
        connectionPhase: "ready",
        connectionGeneration: 5,
        authoritativeGeneration: 4,
      }),
    ).toBe(true);
  });

  it("drops authority as soon as the connection is disconnected", () => {
    expect(
      shellEnvironmentRetainsAuthority({
        shellStatus: "live",
        connectionPhase: "disconnected",
        connectionGeneration: 4,
        authoritativeGeneration: 4,
      }),
    ).toBe(false);
  });
});
