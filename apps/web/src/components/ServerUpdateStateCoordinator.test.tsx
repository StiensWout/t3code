import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  clearPendingServerUpdate: vi.fn(),
  connectionPhase: "connected" as "connected" | "reconnecting",
  environmentId: "environment-1" as EnvironmentId,
  reconcilePendingServerUpdates: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      testState.cleanup?.();
      testState.cleanup = effect() ?? undefined;
    },
  };
});
vi.mock("../state/entities", () => ({
  useServerConfigs: () => new Map(),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: testState.environmentId,
        connection: { phase: testState.connectionPhase },
      },
    ],
  }),
}));
vi.mock("../state/serverUpdate", () => ({
  clearPendingServerUpdate: testState.clearPendingServerUpdate,
  reconcilePendingServerUpdates: testState.reconcilePendingServerUpdates,
  usePendingServerUpdates: () =>
    new Map([
      [
        testState.environmentId,
        {
          attempt: 1,
          phase: "interrupted",
          targetVersion: "0.0.29",
        },
      ],
    ]),
}));

import { ServerUpdateStateCoordinator } from "./ServerUpdateStateCoordinator";

describe("ServerUpdateStateCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testState.cleanup = undefined;
    testState.clearPendingServerUpdate.mockReset();
    testState.connectionPhase = "connected";
    testState.reconcilePendingServerUpdates.mockReset();
  });

  afterEach(() => {
    testState.cleanup?.();
    vi.useRealTimers();
  });

  it("clears an interrupted update when the environment remains connected", () => {
    ServerUpdateStateCoordinator();

    vi.advanceTimersByTime(999);
    expect(testState.clearPendingServerUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(testState.clearPendingServerUpdate).toHaveBeenCalledWith(testState.environmentId, 1);
  });

  it("keeps the update presentation when the environment starts reconnecting", () => {
    ServerUpdateStateCoordinator();
    testState.connectionPhase = "reconnecting";
    ServerUpdateStateCoordinator();

    vi.advanceTimersByTime(1_000);
    expect(testState.clearPendingServerUpdate).not.toHaveBeenCalled();
  });
});
