import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { projectThreadAwareness, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";

import {
  desktopNotificationEventEnabled,
  isDesktopNotificationTargetVisible,
  reconcileAgentNotificationStates,
} from "../../desktopNotifications.logic.ts";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings.ts";
import { isElectron } from "../../env.ts";
import {
  setActiveEnvironmentId,
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities.ts";

export function DesktopNotificationCoordinator() {
  const bridge = isElectron ? window.desktopBridge?.notifications : undefined;
  const settings = useClientSettings((current) => current.desktopNotifications);
  const settingsHydrated = useClientSettingsHydrated();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const routeParams = useParams({ strict: false });
  const previousStatesRef = useRef<ReadonlyMap<string, AgentAwarenessState | null> | null>(null);
  const notificationOperationsRef = useRef(Promise.resolve());

  const enqueueNotificationOperations = useCallback((operation: () => Promise<void>) => {
    notificationOperationsRef.current = notificationOperationsRef.current
      .then(operation)
      .catch(() => undefined);
  }, []);

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
    return bridge.onActivated((target) => {
      setActiveEnvironmentId(target.environmentId);
      void navigate({
        to: "/$environmentId/$threadId",
        params: target,
      });
    });
  }, [bridge, navigate]);

  useEffect(() => {
    if (!bridge || !settingsHydrated || settings.enabled) {
      return;
    }
    enqueueNotificationOperations(() => bridge.dismissAll());
  }, [bridge, enqueueNotificationOperations, settings.enabled, settingsHydrated]);

  useEffect(() => {
    if (!bridge || !settingsHydrated || !shellsBootstrapped) {
      return;
    }

    const reconciliation = reconcileAgentNotificationStates(previousStatesRef.current, observed);
    previousStatesRef.current = reconciliation.next;

    enqueueNotificationOperations(async () => {
      for (const transition of reconciliation.transitions) {
        if (transition.type === "dismiss") {
          await bridge.dismiss(transition.target);
          continue;
        }
        if (!desktopNotificationEventEnabled(settings, transition.event)) {
          continue;
        }
        const isVisibleThread = isDesktopNotificationTargetVisible({
          windowFocused: document.hasFocus(),
          activeEnvironmentId: routeParams.environmentId,
          activeThreadId: routeParams.threadId,
          target: transition.state,
        });
        if (isVisibleThread) {
          continue;
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
      }
    });
  }, [
    bridge,
    enqueueNotificationOperations,
    observed,
    routeParams.environmentId,
    routeParams.threadId,
    settings,
    settingsHydrated,
    shellsBootstrapped,
  ]);

  return null;
}
