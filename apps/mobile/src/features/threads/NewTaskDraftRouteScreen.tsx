import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

type NewTaskDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly title?: string | string[];
  readonly pendingTaskId?: string | string[];
  readonly draftId?: string | string[];
  readonly incomingShareId?: string | string[];
};

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const params = useMemo(() => route.params ?? {}, [route.params]);
  const pendingTaskId = Array.isArray(params.pendingTaskId)
    ? params.pendingTaskId[0]
    : params.pendingTaskId;
  const draftId = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;
  const projects = useProjects();
  const navigation = useNavigation();
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });

  // Keyed on the params object so a fresh navigation to this (already
  // mounted) screen produces a new reference, letting the draft screen
  // re-apply the requested project.
  const initialProjectRef = useMemo(
    () => ({
      environmentId: Array.isArray(params.environmentId)
        ? params.environmentId[0]
        : params.environmentId,
      projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
      branch: params.branch,
      worktreePath: params.worktreePath,
    }),
    [params],
  );

  const [preparedProject, setPreparedProject] = useState<{
    request: typeof initialProjectRef;
    projectRef: typeof initialProjectRef;
    workspaceRoot: string | undefined;
  } | null>(null);
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === initialProjectRef.environmentId &&
      candidate.id === initialProjectRef.projectId,
  );
  const environmentId = project?.environmentId;
  const workspaceRoot = project?.workspaceRoot;
  const needsPreparation = Boolean(initialProjectRef.branch && !pendingTaskId && !draftId);

  useEffect(() => {
    if (!needsPreparation || !initialProjectRef.branch) return;
    let active = true;
    void checkoutNewTaskBranch({
      // A thread's branch is historical; only switchRef can establish that
      // the shared project checkout now matches it.
      branch: {
        name: initialProjectRef.branch,
        current: false,
        isDefault: false,
        worktreePath: initialProjectRef.worktreePath ?? null,
      },
      project: environmentId && workspaceRoot ? { environmentId, workspaceRoot } : null,
      workspaceMode: "local",
      switchRef,
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not switch branch",
            error instanceof Error ? error.message : "The branch could not be checked out.",
          );
        }
        navigation.goBack();
        return;
      }
      setPreparedProject({
        request: initialProjectRef,
        projectRef: { ...initialProjectRef, branch: result.value.name },
        workspaceRoot,
      });
    });
    return () => {
      active = false;
    };
  }, [environmentId, workspaceRoot, initialProjectRef, needsPreparation, navigation, switchRef]);

  // Do not mount the composer, restore its draft, or expose send/queue actions
  // until this exact navigation's checkout has succeeded.
  const prepared =
    preparedProject?.request === initialProjectRef &&
    preparedProject.workspaceRoot === workspaceRoot;
  const preparingBranch = needsPreparation && !prepared;

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: Array.isArray(params.title) ? params.title[0] : (params.title ?? "New task"),
        }}
      />
      {preparingBranch ? (
        <View className="flex-1 items-center justify-center bg-screen">
          <Text className="text-foreground">Switching branch...</Text>
        </View>
      ) : (
        <NewTaskDraftScreen
          initialProjectRef={prepared ? preparedProject.projectRef : initialProjectRef}
          incomingShareId={
            Array.isArray(params.incomingShareId)
              ? params.incomingShareId[0]
              : params.incomingShareId
          }
          pendingTaskId={pendingTaskId}
          draftId={draftId}
        />
      )}
    </>
  );
}
