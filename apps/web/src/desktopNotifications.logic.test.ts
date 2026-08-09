import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

import {
  isDesktopNotificationTargetVisible,
  reconcileAgentNotificationStates,
} from "./desktopNotifications.logic.ts";

function state(phase: AgentAwarenessPhase): AgentAwarenessState {
  return {
    environmentId: "env-1" as EnvironmentId,
    threadId: "thread-1" as ThreadId,
    projectTitle: "t3code",
    threadTitle: "Fix failing CI",
    phase,
    headline: "Test",
    modelTitle: "gpt-5.4",
    updatedAt: "2026-08-09T10:00:00.000Z",
    deepLink: "/threads/env-1/thread-1",
  };
}

const target = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

describe("reconcileAgentNotificationStates", () => {
  it("baselines existing work without replaying a notification", () => {
    const result = reconcileAgentNotificationStates(null, [
      { key: "env-1:thread-1", target, state: state("completed") },
    ]);

    expect(result.transitions).toEqual([]);
    expect(result.next.get("env-1:thread-1")?.phase).toBe("completed");
  });

  it("emits only configured notification-worthy phase edges", () => {
    const result = reconcileAgentNotificationStates(
      new Map([["env-1:thread-1", state("running")]]),
      [{ key: "env-1:thread-1", target, state: state("waiting_for_approval") }],
    );

    expect(result.transitions).toEqual([
      { type: "show", event: "approval", state: state("waiting_for_approval") },
    ]);
  });

  it("notifies when a new thread is first observed in an attention phase", () => {
    const authoritative = new Set([target.environmentId]);
    const result = reconcileAgentNotificationStates(
      new Map(),
      [{ key: "env-1:thread-1", target, state: state("waiting_for_approval") }],
      {
        previouslyAuthoritativeEnvironmentIds: authoritative,
        authoritativeEnvironmentIds: authoritative,
      },
    );

    expect(result.transitions).toEqual([
      { type: "show", event: "approval", state: state("waiting_for_approval") },
    ]);
  });

  it("dismisses an attention notification when the agent resumes", () => {
    const result = reconcileAgentNotificationStates(
      new Map([["env-1:thread-1", state("waiting_for_input")]]),
      [{ key: "env-1:thread-1", target, state: state("running") }],
    );

    expect(result.transitions).toEqual([{ type: "dismiss", target }]);
  });

  it("keeps missing threads in memory so reconnects do not replay old work", () => {
    const previous = new Map([["env-1:thread-1", state("completed")]]);
    const disconnected = reconcileAgentNotificationStates(previous, [], {
      previouslyAuthoritativeEnvironmentIds: new Set([target.environmentId]),
      authoritativeEnvironmentIds: new Set(),
    });
    const reconnected = reconcileAgentNotificationStates(
      disconnected.next,
      [{ key: "env-1:thread-1", target, state: state("completed") }],
      {
        previouslyAuthoritativeEnvironmentIds: new Set(),
        authoritativeEnvironmentIds: new Set([target.environmentId]),
      },
    );

    expect(reconnected.transitions).toEqual([]);
  });

  it("baselines historical threads when an environment first reconnects", () => {
    const result = reconcileAgentNotificationStates(
      new Map(),
      [{ key: "env-1:thread-1", target, state: state("failed") }],
      {
        previouslyAuthoritativeEnvironmentIds: new Set(),
        authoritativeEnvironmentIds: new Set([target.environmentId]),
      },
    );

    expect(result.transitions).toEqual([]);
  });

  it("dismisses a removed thread only while its environment is authoritative", () => {
    const previous = new Map([["env-1:thread-1", state("waiting_for_input")]]);
    const result = reconcileAgentNotificationStates(previous, [], {
      previouslyAuthoritativeEnvironmentIds: new Set([target.environmentId]),
      authoritativeEnvironmentIds: new Set([target.environmentId]),
    });

    expect(result.transitions).toEqual([{ type: "dismiss", target }]);
    expect(result.next.has("env-1:thread-1")).toBe(false);
  });
});

describe("isDesktopNotificationTargetVisible", () => {
  it("suppresses only the focused route for the exact environment and thread", () => {
    expect(
      isDesktopNotificationTargetVisible({
        windowFocused: true,
        activeEnvironmentId: target.environmentId,
        activeThreadId: target.threadId,
        target,
      }),
    ).toBe(true);
    expect(
      isDesktopNotificationTargetVisible({
        windowFocused: false,
        activeEnvironmentId: target.environmentId,
        activeThreadId: target.threadId,
        target,
      }),
    ).toBe(false);
    expect(
      isDesktopNotificationTargetVisible({
        windowFocused: true,
        activeEnvironmentId: "env-2",
        activeThreadId: target.threadId,
        target,
      }),
    ).toBe(false);
  });
});
