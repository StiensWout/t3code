import type {
  DesktopNotificationEvent,
  DesktopNotificationSettings,
  DesktopNotificationTarget,
} from "@t3tools/contracts";
import {
  notificationEventForAwarenessTransition,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";

export interface ObservedAgentAwareness {
  readonly key: string;
  readonly target: DesktopNotificationTarget;
  readonly state: AgentAwarenessState | null;
}

export type AgentNotificationTransition =
  | {
      readonly type: "dismiss";
      readonly target: DesktopNotificationTarget;
    }
  | {
      readonly type: "show";
      readonly event: DesktopNotificationEvent;
      readonly state: AgentAwarenessState;
    };

export function reconcileAgentNotificationStates(
  previous: ReadonlyMap<string, AgentAwarenessState | null> | null,
  observed: ReadonlyArray<ObservedAgentAwareness>,
): {
  readonly next: ReadonlyMap<string, AgentAwarenessState | null>;
  readonly transitions: ReadonlyArray<AgentNotificationTransition>;
} {
  const next = new Map(previous ?? []);
  const transitions: AgentNotificationTransition[] = [];

  for (const entry of observed) {
    const hadPrevious = previous?.has(entry.key) === true;
    const priorState = hadPrevious ? (previous?.get(entry.key) ?? null) : null;
    next.set(entry.key, entry.state);

    // The first complete shell snapshot is a baseline, never a backlog to replay.
    if (!hadPrevious) {
      continue;
    }

    if (
      priorState !== null &&
      priorState.phase !== entry.state?.phase &&
      notificationEventForAwarenessTransition(null, priorState) !== null
    ) {
      transitions.push({ type: "dismiss", target: entry.target });
    }

    const event = notificationEventForAwarenessTransition(priorState, entry.state);
    if (event !== null && entry.state !== null) {
      transitions.push({ type: "show", event, state: entry.state });
    }
  }

  return { next, transitions };
}

export function desktopNotificationEventEnabled(
  settings: DesktopNotificationSettings,
  event: DesktopNotificationEvent,
): boolean {
  return settings.enabled && settings.events[event];
}

export function isDesktopNotificationTargetVisible(input: {
  readonly windowFocused: boolean;
  readonly activeEnvironmentId: string | undefined;
  readonly activeThreadId: string | undefined;
  readonly target: DesktopNotificationTarget;
}): boolean {
  return (
    input.windowFocused &&
    input.activeEnvironmentId === input.target.environmentId &&
    input.activeThreadId === input.target.threadId
  );
}
