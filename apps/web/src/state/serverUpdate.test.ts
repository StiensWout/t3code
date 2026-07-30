import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  beginPendingServerUpdate,
  clearPendingServerUpdate,
  getPendingServerUpdateForTests,
  markPendingServerUpdateInterrupted,
  markPendingServerUpdateRestartAccepted,
  reconcilePendingServerUpdates,
  resetPendingServerUpdatesForTests,
  SERVER_UPDATE_PENDING_EXPIRY_MS,
} from "./serverUpdate";

const environmentId = "environment-1" as EnvironmentId;

describe("serverUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPendingServerUpdatesForTests();
  });

  afterEach(() => {
    resetPendingServerUpdatesForTests();
    vi.useRealTimers();
  });

  it("keeps the latest update pending until its safety deadline", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");

    expect(getPendingServerUpdateForTests(environmentId)).toEqual({
      attempt,
      phase: "requesting",
      targetVersion: "0.0.29",
    });

    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS);
    expect(getPendingServerUpdateForTests(environmentId)).toBeNull();
  });

  it("starts a fresh deadline after restart is accepted", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");
    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS - 1);

    markPendingServerUpdateRestartAccepted(environmentId, attempt!);
    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS - 1);
    expect(getPendingServerUpdateForTests(environmentId)).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(getPendingServerUpdateForTests(environmentId)).toBeNull();
  });

  it("starts a fresh reconnect deadline after the update request is interrupted", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");
    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS - 1);

    markPendingServerUpdateInterrupted(environmentId, attempt!);
    vi.advanceTimersByTime(SERVER_UPDATE_PENDING_EXPIRY_MS - 1);
    expect(getPendingServerUpdateForTests(environmentId)).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(getPendingServerUpdateForTests(environmentId)).toBeNull();
  });

  it("does not let an older attempt clear a newer retry", () => {
    const firstAttempt = beginPendingServerUpdate(environmentId, "0.0.29");
    expect(firstAttempt).not.toBeNull();
    markPendingServerUpdateInterrupted(environmentId, firstAttempt!);
    const retryAttempt = beginPendingServerUpdate(environmentId, "0.0.29");

    clearPendingServerUpdate(environmentId, firstAttempt!);
    expect(getPendingServerUpdateForTests(environmentId)?.attempt).toBe(retryAttempt);
  });

  it("rejects a second request while the shared update is active", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");

    expect(beginPendingServerUpdate(environmentId, "0.0.29")).toBeNull();
    markPendingServerUpdateRestartAccepted(environmentId, attempt!);
    expect(beginPendingServerUpdate(environmentId, "0.0.29")).toBeNull();
  });

  it("allows retry after an interrupted request", () => {
    const attempt = beginPendingServerUpdate(environmentId, "0.0.29");
    markPendingServerUpdateInterrupted(environmentId, attempt!);

    const retryAttempt = beginPendingServerUpdate(environmentId, "0.0.29");
    expect(retryAttempt).not.toBeNull();
    expect(retryAttempt).not.toBe(attempt);
  });

  it("clears completed updates from every environment config", () => {
    const otherEnvironmentId = "environment-2" as EnvironmentId;
    beginPendingServerUpdate(environmentId, "0.0.29");
    beginPendingServerUpdate(otherEnvironmentId, "0.0.30");

    reconcilePendingServerUpdates(
      new Map([
        [environmentId, { environment: { serverVersion: "0.0.29" } }],
        [otherEnvironmentId, { environment: { serverVersion: "0.0.28" } }],
      ]),
    );

    expect(getPendingServerUpdateForTests(environmentId)).toBeNull();
    expect(getPendingServerUpdateForTests(otherEnvironmentId)).not.toBeNull();
  });
});
