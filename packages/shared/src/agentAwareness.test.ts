import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  formatAgentCompletionPreview,
  formatAgentNotificationContent,
  notificationEventForAwarenessTransition,
  projectThreadAwareness,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
} from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<OrchestrationProjectShell, "title">;

function thread(
  overrides: Partial<OrchestrationThreadShell> = {},
): Pick<
  OrchestrationThreadShell,
  | "id"
  | "title"
  | "modelSelection"
  | "session"
  | "latestTurn"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
> {
  return {
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("projectThreadAwareness", () => {
  it("returns null for idle threads without an active awareness state", () => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread(),
      }),
    ).toBeNull();
  });

  it("prioritizes approval requests over running state", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        hasPendingApprovals: true,
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("waiting_for_approval");
    expect(state?.headline).toBe("Approval needed");
  });

  it("projects running provider sessions", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "running",
      headline: "Agent is working",
      detail: "Codex is active.",
      modelTitle: "gpt-5.4",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("projects completed turns as completed even when teardown settled them as interrupted", () => {
    const finishedTurn = {
      turnId: "turn-1" as TurnId,
      state: "interrupted" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    };
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: finishedTurn }),
    });

    // Session teardown settles still-running turns by session status, and
    // that write can race turn.completed; the completion timestamp is the
    // durable signal. Without this the thread resolves to null persistently
    // and gets tombstoned off the lock-screen card instead of showing Done.
    expect(state?.phase).toBe("completed");

    const trulyInterrupted = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: { ...finishedTurn, completedAt: null } }),
    });
    expect(trulyInterrupted).toBeNull();
  });

  it("projects ready sessions with no materialized turn as completed", () => {
    // Quick threads without code changes never get a checkpoint, so the SQL
    // shell has no latestTurn row and latest_turn_id is cleared when the
    // session settles; the ready session is the only completion signal left.
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "ready",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("completed");
  });

  it("projects failures with the session error detail", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "error",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Provider process exited.",
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "failed",
      headline: "Agent failed",
      detail: "Provider process exited.",
    });
  });
});

function awarenessState(phase: AgentAwarenessPhase): AgentAwarenessState {
  return {
    environmentId: "env-1" as EnvironmentId,
    threadId: "thread-1" as ThreadId,
    projectTitle: "t3code",
    threadTitle: "Fix failing CI",
    phase,
    headline: "Test",
    modelTitle: "gpt-5.4",
    updatedAt: NOW,
    deepLink: "/threads/env-1/thread-1",
  };
}

describe("desktop notification projection", () => {
  it.each([
    ["waiting_for_approval", "approval"],
    ["waiting_for_input", "input"],
    ["completed", "completion"],
    ["failed", "failure"],
  ] as const)("maps a phase edge to %s notifications", (phase, event) => {
    expect(
      notificationEventForAwarenessTransition(awarenessState("running"), awarenessState(phase)),
    ).toBe(event);
  });

  it("does not notify for repeated phases or background progress", () => {
    expect(
      notificationEventForAwarenessTransition(
        awarenessState("waiting_for_input"),
        awarenessState("waiting_for_input"),
      ),
    ).toBeNull();
    expect(
      notificationEventForAwarenessTransition(
        awarenessState("starting"),
        awarenessState("running"),
      ),
    ).toBeNull();
  });

  it("uses the same concise content for every platform adapter", () => {
    expect(
      formatAgentNotificationContent({
        event: "approval",
        projectTitle: "t3code",
        threadTitle: "Fix failing CI",
        showContext: true,
      }),
    ).toEqual({
      title: "Approval needed",
      body: "Fix failing CI · t3code",
    });
  });

  it("uses the thread title and final response preview for completions", () => {
    expect(
      formatAgentNotificationContent({
        event: "completion",
        projectTitle: "t3code",
        threadTitle: "Fix failing CI",
        completionPreview: "Implemented the fix and the focused tests now pass.",
        showContext: true,
      }),
    ).toEqual({
      title: "Fix failing CI",
      body: "Implemented the fix and the focused tests now pass.",
    });
  });

  it("falls back when a completed turn has no assistant response", () => {
    expect(
      formatAgentNotificationContent({
        event: "completion",
        projectTitle: "t3code",
        threadTitle: "Fix failing CI",
        showContext: true,
      }),
    ).toEqual({
      title: "Fix failing CI",
      body: "Finished · t3code",
    });
  });

  it("normalizes markdown and caps completion previews at 90 characters", () => {
    expect(
      formatAgentCompletionPreview(
        "## Done\n\n- Updated [notifications](https://example.com) and   verified the Windows build. " +
          "This sentence makes the preview deliberately longer than the native notification limit.",
      ),
    ).toBe(
      "Done Updated notifications and verified the Windows build. This sentence makes the previe…",
    );
  });

  it("can hide project and thread names", () => {
    expect(
      formatAgentNotificationContent({
        event: "failure",
        projectTitle: "Secret project",
        threadTitle: "Sensitive task",
        showContext: false,
      }),
    ).toEqual({
      title: "Agent failed",
      body: "Open T3 Code to view details.",
    });
  });

  it("hides completion titles and response previews with context disabled", () => {
    expect(
      formatAgentNotificationContent({
        event: "completion",
        projectTitle: "Secret project",
        threadTitle: "Sensitive task",
        completionPreview: "The secret fix is ready.",
        showContext: false,
      }),
    ).toEqual({
      title: "Agent finished",
      body: "Open T3 Code to view details.",
    });
  });
});
