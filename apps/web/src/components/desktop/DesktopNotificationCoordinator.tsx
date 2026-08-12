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
  deliverBrowserNotificationOnce,
  dismissAllBrowserNotifications,
  dismissBrowserNotification,
  getBrowserNotificationPermission,
  showBrowserAgentNotification,
} from "../../browserNotifications.ts";
import {
  getClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings.ts";
import { isElectron } from "../../env.ts";
import {
  readThreadShell,
  setActiveEnvironmentId,
  useAllEnvironmentShellsBootstrapped,
  useAuthoritativeShellEnvironmentIds,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities.ts";
import { completionNotificationSnapshot } from "../../state/notificationPreview.ts";
import { environmentBackgroundPolicy } from "../../state/server.ts";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner.ts";
import { completionNotificationPreview } from "../../completionNotificationPreview.ts";

const COMPLETION_NOTIFICATION_QUERY_TIMEOUT_MS = 1_250;

function settleWithin<A>(promise: Promise<A>, timeoutMs: number): Promise<A | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

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
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  const loadCompletionSnapshot = useAtomQueryRunner(completionNotificationSnapshot, {
    label: "completion notification preview",
    reportFailure: false,
    reportDefect: false,
  });
  const backgroundPoliciesRef = useRef(new Map<EnvironmentId, BackgroundPolicySnapshot>());
  const previousStatesRef = useRef<ReadonlyMap<string, AgentAwarenessState | null> | null>(null);
  const previousAuthoritativeEnvironmentIdsRef = useRef<ReadonlySet<string>>(new Set());
  const notificationOperationsRef = useRef(Promise.resolve());
  const lifecycleGenerationRef = useRef(0);

  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    return () => {
      lifecycleGenerationRef.current += 1;
    };
  }, []);

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

  const completionContexts = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          {
            assistantMessageId: thread.latestTurn?.assistantMessageId ?? null,
            turnId: thread.latestTurn?.turnId ?? null,
            updatedAt: thread.updatedAt,
            supportsPagination:
              serverConfigs.get(thread.environmentId)?.threadSnapshotPagination === true,
          },
        ]),
      ),
    [serverConfigs, threads],
  );

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
      enqueueNotificationOperations(async () => dismissAllBrowserNotifications());
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
      const lifecycleGeneration = lifecycleGenerationRef.current;
      enqueueNotificationOperations(async () => {
        if (transition.type === "dismiss") {
          if (bridge) {
            await bridge.dismiss(transition.target);
          } else {
            dismissBrowserNotification(transition.target);
          }
          return;
        }
        if (lifecycleGenerationRef.current !== lifecycleGeneration) {
          return;
        }
        const queuedSettings = getClientSettings().desktopNotifications;
        if (!desktopNotificationEventEnabled(queuedSettings, transition.event)) {
          return;
        }
        if (bridge) {
          if (shouldSuppressDesktopNotification(document.hasFocus())) {
            return;
          }
        } else {
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
        }

        const target = scopeThreadRef(transition.state.environmentId, transition.state.threadId);
        let completionPreview: string | null = null;
        if (transition.event === "completion" && queuedSettings.showContext) {
          const context = completionContexts.get(scopedThreadKey(target));
          if (context?.supportsPagination) {
            const result = await settleWithin(
              loadCompletionSnapshot({
                environmentId: transition.state.environmentId,
                input: {
                  threadId: transition.state.threadId,
                  updatedAt: context.updatedAt,
                },
              }),
              COMPLETION_NOTIFICATION_QUERY_TIMEOUT_MS,
            );
            if (result?._tag === "Success" && Option.isSome(result.value)) {
              completionPreview = completionNotificationPreview({
                messages: result.value.value.thread.messages,
                assistantMessageId: context.assistantMessageId,
                turnId: context.turnId,
              });
            }
          }
        }

        if (
          lifecycleGenerationRef.current !== lifecycleGeneration ||
          readThreadShell(target)?.updatedAt !== transition.state.updatedAt
        ) {
          return;
        }

        const inputBase = {
          environmentId: transition.state.environmentId,
          threadId: transition.state.threadId,
          event: transition.event,
          projectTitle: transition.state.projectTitle,
          threadTitle: transition.state.threadTitle,
        };

        if (bridge) {
          const deliverySettings = getClientSettings().desktopNotifications;
          if (
            !desktopNotificationEventEnabled(deliverySettings, transition.event) ||
            shouldSuppressDesktopNotification(document.hasFocus())
          ) {
            return;
          }
          await bridge.show({
            ...inputBase,
            ...(deliverySettings.showContext && completionPreview !== null
              ? { completionPreview }
              : {}),
            showContext: deliverySettings.showContext,
            silent: !deliverySettings.soundEnabled,
          });
          return;
        }

        await deliverBrowserNotificationOnce(
          browserNotificationDeliveryKey({
            environmentId: transition.state.environmentId,
            threadId: transition.state.threadId,
            event: transition.event,
            updatedAt: transition.state.updatedAt,
          }),
          () => {
            const deliverySettings = getClientSettings().desktopNotifications;
            if (
              lifecycleGenerationRef.current !== lifecycleGeneration ||
              readThreadShell(target)?.updatedAt !== transition.state.updatedAt ||
              !desktopNotificationEventEnabled(deliverySettings, transition.event) ||
              shouldSuppressBrowserNotification({
                windowFocused: document.hasFocus(),
                policy: backgroundPoliciesRef.current.get(transition.state.environmentId) ?? null,
              })
            ) {
              return "suppressed";
            }
            return showBrowserAgentNotification(
              {
                ...inputBase,
                ...(deliverySettings.showContext && completionPreview !== null
                  ? { completionPreview }
                  : {}),
                showContext: deliverySettings.showContext,
                silent: !deliverySettings.soundEnabled,
              },
              { onActivated: activateTarget },
            );
          },
        );
      });
    }
  }, [
    bridge,
    activateTarget,
    authoritativeEnvironmentIds,
    completionContexts,
    enqueueNotificationOperations,
    loadCompletionSnapshot,
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
