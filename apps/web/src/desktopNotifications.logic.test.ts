import { describe, expect, it } from "vite-plus/test";
import {
  AuthSessionId,
  type ClientActivityLease,
  type ClientKind,
  type EnvironmentId,
  RpcClientId,
  type ThreadId,
} from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";

import {
  reconcileAgentNotificationStates,
  shouldSuppressBrowserNotification,
  shouldSuppressDesktopNotification,
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
    notificationVersion: "turn:turn-1",
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

  it("baselines state changes that happened while an environment was disconnected", () => {
    const reconnected = reconcileAgentNotificationStates(
      new Map([["env-1:thread-1", state("running")]]),
      [{ key: "env-1:thread-1", target, state: state("completed") }],
      {
        previouslyAuthoritativeEnvironmentIds: new Set(),
        authoritativeEnvironmentIds: new Set([target.environmentId]),
      },
    );

    expect(reconnected.transitions).toEqual([]);
    expect(reconnected.next.get("env-1:thread-1")?.phase).toBe("completed");
  });

  it("dismisses stale attention notifications when an environment reconnects", () => {
    const reconnected = reconcileAgentNotificationStates(
      new Map([["env-1:thread-1", state("waiting_for_input")]]),
      [{ key: "env-1:thread-1", target, state: state("running") }],
      {
        previouslyAuthoritativeEnvironmentIds: new Set(),
        authoritativeEnvironmentIds: new Set([target.environmentId]),
      },
    );

    expect(reconnected.transitions).toEqual([{ type: "dismiss", target }]);
    expect(reconnected.next.get("env-1:thread-1")?.phase).toBe("running");
  });

  it("replaces a live attention notification when its type changed while disconnected", () => {
    const currentState = state("waiting_for_input");
    const reconnected = reconcileAgentNotificationStates(
      new Map([["env-1:thread-1", state("waiting_for_approval")]]),
      [{ key: "env-1:thread-1", target, state: currentState }],
      {
        previouslyAuthoritativeEnvironmentIds: new Set(),
        authoritativeEnvironmentIds: new Set([target.environmentId]),
      },
    );

    expect(reconnected.transitions).toEqual([
      { type: "dismiss", target },
      { type: "show", event: "input", state: currentState },
    ]);
  });

  it("does not surface offline attention after a terminal notification", () => {
    const reconnected = reconcileAgentNotificationStates(
      new Map([["env-1:thread-1", state("completed")]]),
      [{ key: "env-1:thread-1", target, state: state("waiting_for_input") }],
      {
        previouslyAuthoritativeEnvironmentIds: new Set(),
        authoritativeEnvironmentIds: new Set([target.environmentId]),
      },
    );

    expect(reconnected.transitions).toEqual([{ type: "dismiss", target }]);
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

  it("forgets removed inactive threads", () => {
    const previous = new Map<string, AgentAwarenessState | null>([["env-1:thread-1", null]]);
    const result = reconcileAgentNotificationStates(previous, [], {
      previouslyAuthoritativeEnvironmentIds: new Set([target.environmentId]),
      authoritativeEnvironmentIds: new Set([target.environmentId]),
    });

    expect(result.transitions).toEqual([]);
    expect(result.next.has("env-1:thread-1")).toBe(false);
  });
});

describe("shouldSuppressDesktopNotification", () => {
  it("suppresses notifications whenever the desktop window is focused", () => {
    expect(shouldSuppressDesktopNotification(true)).toBe(true);
    expect(shouldSuppressDesktopNotification(false)).toBe(false);
  });
});

function lease(clientKind: ClientKind, focused = false): ClientActivityLease {
  const now = DateTime.makeUnsafe("2026-08-10T08:00:00.000Z");
  return {
    sessionId: AuthSessionId.make(`session-${clientKind}`),
    rpcClientId: RpcClientId.make(1),
    clientId: `client-${clientKind}`,
    clientKind,
    visible: focused,
    focused,
    recentlyInteracted: focused,
    appState: focused ? "active" : "background",
    scopes: [],
    updatedAt: now,
    expiresAt: DateTime.add(now, { minutes: 1 }),
  };
}

describe("shouldSuppressBrowserNotification", () => {
  it("fails closed until same-environment presence is ready", () => {
    expect(
      shouldSuppressBrowserNotification({
        windowFocused: false,
        policy: null,
      }),
    ).toBe(true);
  });

  it("suppresses while this browser window is focused", () => {
    expect(
      shouldSuppressBrowserNotification({
        windowFocused: true,
        policy: { leases: [] },
      }),
    ).toBe(true);
  });

  it("gives any connected desktop renderer priority even in the background", () => {
    expect(
      shouldSuppressBrowserNotification({
        windowFocused: false,
        policy: { leases: [lease("desktop-renderer")] },
      }),
    ).toBe(true);
  });

  it("suppresses when another T3 client is focused", () => {
    expect(
      shouldSuppressBrowserNotification({
        windowFocused: false,
        policy: { leases: [lease("mobile", true)] },
      }),
    ).toBe(true);
  });

  it("allows an opted-in background browser when no desktop or focused client is present", () => {
    expect(
      shouldSuppressBrowserNotification({
        windowFocused: false,
        policy: { leases: [lease("web")] },
      }),
    ).toBe(false);
  });
});
