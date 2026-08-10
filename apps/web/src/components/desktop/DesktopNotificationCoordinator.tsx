import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { BackgroundPolicySnapshot, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { projectThreadAwareness, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  desktopNotificationEventEnabled,
  reconcileAgentNotificationStates,
  shouldSuppressBrowserNotification,
  shouldSuppressDesktopNotification,
} from "../../desktopNotifications.logic.ts";
import {
  browserNotificationDeliveryKey,
  claimBrowserNotificationDelivery,
  dismissAllBrowserNotifications,
  dismissBrowserNotification,
  getBrowserNotificationPermission,
  showBrowserAgentNotification,
} from "../../browserNotifications.ts";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings.ts";
import { isElectron } from "../../env.ts";
import {
  setActiveEnvironmentId,
  useAllEnvironmentShellsBootstrapped,
  useAuthoritativeShellEnvironmentIds,
  useProjects,
  useThreadShells,
} from "../../state/entities.ts";
import { environmentBackgroundPolicy } from "../../state/server.ts";

function BrowserNotificationPolicyObserver({
  environmentId,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly onChanged: (
    environmentId: EnvironmentId,
    policy: BackgroundPolicySnapshot | null,
  ) => void;
}) {
  const result = useAtomValue(
    environmentBackgroundPolicy({
      environmentId,
      input: {},
    }),
  );
  const policy = Option.getOrNull(AsyncResult.value(result));

  useEffect(() => {
    onChanged(environmentId, policy);
  }, [environmentId, onChanged, policy]);

  useEffect(
    () => () => {
      onChanged(environmentId, null);
    },
    [environmentId, onChanged],
  );

  return null;
}

export function DesktopNotificationCoordinator() {
  const bridge = isElectron ? window.desktopBridge?.notifications : undefined;
  const settings = useClientSettings((current) => current.desktopNotifications);
  const settingsHydrated = useClientSettingsHydrated();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const authoritativeEnvironmentIds = useAuthoritativeShellEnvironmentIds();
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const backgroundPoliciesRef = useRef(new Map<EnvironmentId, BackgroundPolicySnapshot>());
  const previousStatesRef = useRef<ReadonlyMap<string, AgentAwarenessState | null> | null>(null);
  const previousAuthoritativeEnvironmentIdsRef = useRef<ReadonlySet<string>>(new Set());
  const notificationOperationsRef = useRef(Promise.resolve());

  const enqueueNotificationOperations = useCallback((operation: () => Promise<void>) => {
    notificationOperationsRef.current = notificationOperationsRef.current
      .then(operation)
      .catch(() => undefined);
  }, []);

  const activateTarget = useCallback(
    (target: { readonly environmentId: EnvironmentId; readonly threadId: string }) => {
      setActiveEnvironmentId(target.environmentId);
      void navigate({
        to: "/$environmentId/$threadId",
        params: target,
      });
    },
    [navigate],
  );

  const updateBackgroundPolicy = useCallback(
    (environmentId: EnvironmentId, policy: BackgroundPolicySnapshot | null) => {
      if (policy === null) {
        backgroundPoliciesRef.current.delete(environmentId);
      } else {
        backgroundPoliciesRef.current.set(environmentId, policy);
      }
    },
    [],
  );

  const observed = useMemo(() => {
    const projectsByKey = new Map(
      projects.map((project) => [
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
        project,
      ]),
    );

    return threads.flatMap((thread) => {
      const project = projectsByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!project) {
        return [];
      }
      const target = scopeThreadRef(thread.environmentId, thread.id);
      return [
        {
          key: scopedThreadKey(target),
          target,
          state: projectThreadAwareness({
            environmentId: thread.environmentId,
            project,
            thread,
          }),
        },
      ];
    });
  }, [projects, threads]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onActivated(activateTarget);
  }, [activateTarget, bridge]);

  useEffect(() => {
    if (!settingsHydrated || settings.enabled) {
      return;
    }
    if (bridge) {
      enqueueNotificationOperations(() => bridge.dismissAll());
    } else if (!isElectron) {
      dismissAllBrowserNotifications();
    }
  }, [bridge, enqueueNotificationOperations, settings.enabled, settingsHydrated]);

  useEffect(() => {
    if ((isElectron && !bridge) || !settingsHydrated || !shellsBootstrapped) {
      return;
    }

    const reconciliation = reconcileAgentNotificationStates(previousStatesRef.current, observed, {
      previouslyAuthoritativeEnvironmentIds: previousAuthoritativeEnvironmentIdsRef.current,
      authoritativeEnvironmentIds,
    });
    previousStatesRef.current = reconciliation.next;
    previousAuthoritativeEnvironmentIdsRef.current = authoritativeEnvironmentIds;

    for (const transition of reconciliation.transitions) {
      enqueueNotificationOperations(async () => {
        if (transition.type === "dismiss") {
          if (bridge) {
            await bridge.dismiss(transition.target);
          } else {
            dismissBrowserNotification(transition.target);
          }
          return;
        }
        if (!desktopNotificationEventEnabled(settings, transition.event)) {
          return;
        }
        if (bridge) {
          if (shouldSuppressDesktopNotification(document.hasFocus())) {
            return;
          }
          await bridge.show({
            environmentId: transition.state.environmentId,
            threadId: transition.state.threadId,
            event: transition.event,
            projectTitle: transition.state.projectTitle,
            threadTitle: transition.state.threadTitle,
            showContext: settings.showContext,
            silent: !settings.soundEnabled,
          });
          return;
        }

        if (getBrowserNotificationPermission() !== "granted") {
          return;
        }
        if (
          shouldSuppressBrowserNotification({
            windowFocused: document.hasFocus(),
            policy: backgroundPoliciesRef.current.get(transition.state.environmentId) ?? null,
          })
        ) {
          return;
        }
        const input = {
          environmentId: transition.state.environmentId,
          threadId: transition.state.threadId,
          event: transition.event,
          projectTitle: transition.state.projectTitle,
          threadTitle: transition.state.threadTitle,
          showContext: settings.showContext,
          silent: !settings.soundEnabled,
        };
        const claimed = await claimBrowserNotificationDelivery(
          browserNotificationDeliveryKey({
            ...input,
            updatedAt: transition.state.updatedAt,
          }),
        );
        if (!claimed) {
          return;
        }
        showBrowserAgentNotification(input, { onActivated: activateTarget });
      });
    }
  }, [
    bridge,
    activateTarget,
    authoritativeEnvironmentIds,
    enqueueNotificationOperations,
    observed,
    settings,
    settingsHydrated,
    shellsBootstrapped,
  ]);

  if (isElectron) {
    return null;
  }

  return (
    <>
      {[...authoritativeEnvironmentIds].map((environmentId) => (
        <BrowserNotificationPolicyObserver
          key={environmentId}
          environmentId={environmentId}
          onChanged={updateBackgroundPolicy}
        />
      ))}
    </>
  );
}
