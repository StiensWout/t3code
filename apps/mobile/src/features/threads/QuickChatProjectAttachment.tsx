import { useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ScopedThreadRef, VcsRef } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import {
  prepareQuickChatWorktree,
  type PendingQuickChatAttachment,
} from "@t3tools/client-runtime/operations/quickChats";
import { quickChatAttachmentStorage } from "../../state/quick-chat-attachment-storage";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { usePaginatedBranches } from "../../state/queries";
import { BranchSelectionRow } from "./NewTaskContextPickerScreens";
import { uuidv4 } from "../../lib/uuid";

export function QuickChatProjectAttachment({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(() => {
    try {
      return { pending: quickChatAttachmentStorage.load(threadRef), error: null };
    } catch {
      return {
        pending: null,
        error: "Could not load the pending attachment. Check device storage before retrying.",
      };
    }
  });
  const [projectId, setProjectId] = useState(saved.pending?.projectId ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "existing" | "new">(
    saved.pending ? "new" : "local",
  );
  const newWorktree = workspaceMode === "new";
  const [existingRef, setExistingRef] = useState<VcsRef | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [baseBranch, setBaseBranch] = useState(saved.pending?.baseBranch ?? "");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [prepared, setPrepared] = useState<PendingQuickChatAttachment | null>(saved.pending);
  const projects = useProjects().filter(
    (project) => project.environmentId === threadRef.environmentId,
  );
  const thread = useThreadShell(threadRef);
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, "Create worktree");
  const update = useAtomCommand(threadEnvironment.updateMetadata, "Attach quick chat");
  const listRefs = useAtomQueryRunner(vcsEnvironment.readRefs, { refresh: true });
  const project = projectId ? projects.find((project) => project.id === projectId) : projects[0];
  const branchState = usePaginatedBranches({
    environmentId: threadRef.environmentId,
    cwd: open && workspaceMode !== "local" ? (project?.workspaceRoot ?? null) : null,
    query: branchQuery,
  });
  const unavailable =
    saved.error !== null ||
    !thread ||
    thread.projectId !== null ||
    thread.archivedAt !== null ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput;
  async function attach() {
    if (pending.current || !project || unavailable) return;
    pending.current = true;
    setBusy(true);
    try {
      let worktree = null;
      if (newWorktree) {
        const attachment = prepared ?? {
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
          baseBranch: baseBranch.trim(),
          branch: `t3/quick-chat-${uuidv4()}`,
        };
        await quickChatAttachmentStorage.save(threadRef, attachment);
        setPrepared(attachment);
        worktree = await prepareQuickChatWorktree({
          pending: attachment,
          listRefs: async () => {
            const result = await listRefs({
              environmentId: threadRef.environmentId,
              input: {
                cwd: attachment.workspaceRoot,
                query: attachment.branch,
                refKind: "local",
                refresh: true,
              },
            });
            if (result._tag === "Failure")
              throw new Error(
                "Could not check the prepared worktree. Check the connection and retry.",
              );
            return result.value;
          },
          createWorktree: async (input) => {
            const result = await createWorktree({ environmentId: threadRef.environmentId, input });
            if (result._tag === "Failure")
              throw new Error(
                "Could not confirm worktree creation. Retry to recover the same branch.",
              );
            return result.value;
          },
        });
      }
      if (workspaceMode === "existing") {
        if (!existingRef) return;
        const result = await listRefs({
          environmentId: threadRef.environmentId,
          input: {
            cwd: project.workspaceRoot,
            query: existingRef.name,
            refKind: "local",
            refresh: true,
          },
        });
        if (result._tag === "Failure")
          throw new Error("Could not check the selected worktree. Retry when connected.");
        const ref = result.value.refs.find(
          (candidate) => candidate.name === existingRef.name && !candidate.isRemote,
        );
        if (!ref?.worktreePath || ref.worktreePath === project.workspaceRoot)
          throw new Error("This worktree is no longer available. Select another worktree.");
        worktree = { refName: ref.name, path: ref.worktreePath };
      }
      const result = await update({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          projectId: project.id,
          branch: worktree?.refName ?? null,
          worktreePath: worktree?.path ?? null,
        },
      });
      if (result._tag === "Failure") {
        Alert.alert(
          "Could not confirm attachment",
          worktree
            ? `Retry to use the prepared worktree at ${worktree.path}.`
            : "Check the connection and retry.",
        );
        return;
      }
      quickChatAttachmentStorage.clear(threadRef);
      setOpen(false);
    } catch (cause) {
      Alert.alert(
        "Could not prepare attachment",
        cause instanceof Error ? cause.message : "Check device storage and retry.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          if (saved.error !== null) {
            try {
              const attachment = quickChatAttachmentStorage.load(threadRef);
              setSaved({ pending: attachment, error: null });
              setPrepared(attachment);
              setProjectId(attachment?.projectId ?? "");
              setWorkspaceMode(attachment ? "new" : "local");
              setBaseBranch(attachment?.baseBranch ?? "");
              setExistingRef(null);
            } catch {
              Alert.alert("Could not load attachment", "Check device storage and retry.");
              return;
            }
          }
          setOpen(true);
        }}
        className="px-4 py-2"
      >
        <Text className="text-sm text-foreground">Attach to project</Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="none"
        onRequestClose={() => {
          if (!pending.current) setOpen(false);
        }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "#000",
            paddingTop: 64,
            paddingHorizontal: 24,
            paddingBottom: 32,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 20, marginBottom: 24 }}>Attach to project</Text>
          <ScrollView>
            {saved.error && <Text style={{ color: "#fff" }}>{saved.error}</Text>}
            {projects.map((candidate) => (
              <Pressable
                key={candidate.id}
                disabled={busy || prepared !== null}
                onPress={() => {
                  setProjectId(candidate.id);
                  setBaseBranch("");
                  setExistingRef(null);
                }}
                style={{ paddingVertical: 14 }}
              >
                <Text style={{ color: "#fff" }}>
                  {candidate.id === project?.id ? "● " : "○ "}
                  {candidate.title}
                </Text>
              </Pressable>
            ))}
            {projects.length === 0 && (
              <Text style={{ color: "#fff" }}>Add a project on this environment first.</Text>
            )}
            <Text style={{ color: "#fff", marginTop: 20 }}>Workspace</Text>
            {(["local", "existing", "new"] as const).map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ checked: workspaceMode === mode }}
                disabled={busy || prepared !== null}
                onPress={() => setWorkspaceMode(mode)}
                style={{ paddingVertical: 12 }}
              >
                <Text style={{ color: "#fff" }}>
                  {workspaceMode === mode ? "● " : "○ "}
                  {mode === "local"
                    ? "Local checkout"
                    : mode === "existing"
                      ? "Existing worktree"
                      : "New worktree"}
                </Text>
              </Pressable>
            ))}
            {workspaceMode !== "local" && (
              <>
                <Text style={{ color: "#fff", marginTop: 16 }}>
                  {newWorktree ? "Base branch" : "Worktree"}
                </Text>
                <TextInput
                  accessibilityLabel="Search branches"
                  placeholder="Search branches…"
                  value={branchQuery}
                  onChangeText={setBranchQuery}
                  autoCapitalize="none"
                  style={{ color: "#fff", padding: 12 }}
                />
                {branchState.refs.map((ref, index) => (
                  <BranchSelectionRow
                    key={ref.name}
                    branch={ref}
                    isFirst={index === 0}
                    isLast={index === branchState.refs.length - 1}
                    badge={
                      ref.worktreePath && ref.worktreePath !== project?.workspaceRoot
                        ? "worktree"
                        : ref.current
                          ? "current"
                          : ref.isRemote
                            ? "remote"
                            : null
                    }
                    disabled={
                      busy ||
                      prepared !== null ||
                      (workspaceMode === "existing" &&
                        (!ref.worktreePath || ref.worktreePath === project?.workspaceRoot))
                    }
                    selected={
                      newWorktree ? baseBranch === ref.name : existingRef?.name === ref.name
                    }
                    onSelect={(ref) => {
                      if (newWorktree) setBaseBranch(ref.name);
                      else setExistingRef(ref);
                    }}
                  />
                ))}
                {branchState.isPending && <Text style={{ color: "#fff" }}>Loading branches…</Text>}
                {branchState.data?.nextCursor != null && (
                  <Pressable onPress={() => branchState.loadNext()}>
                    <Text style={{ color: "#fff", padding: 12 }}>Load more branches</Text>
                  </Pressable>
                )}
              </>
            )}
            {unavailable && (
              <Text style={{ color: "#fff" }}>
                Finish the current turn and background work, and resolve pending requests before
                attaching.
              </Text>
            )}
            {prepared && !busy && (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  try {
                    quickChatAttachmentStorage.clear(threadRef);
                    setPrepared(null);
                    setProjectId("");
                    setWorkspaceMode("local");
                    setBaseBranch("");
                    setExistingRef(null);
                  } catch {
                    Alert.alert("Could not reset attachment", "Check device storage and retry.");
                  }
                }}
                style={{ paddingVertical: 16 }}
              >
                <Text style={{ color: "#fff" }}>Change attachment target</Text>
                <Text style={{ color: "#fff", marginTop: 8 }}>
                  Any created worktree remains available under Existing worktree.
                </Text>
              </Pressable>
            )}
          </ScrollView>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 24 }}>
            <Pressable disabled={busy} onPress={() => setOpen(false)}>
              <Text style={{ color: "#fff", padding: 12 }}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={
                busy ||
                unavailable ||
                !project ||
                (newWorktree && !baseBranch.trim()) ||
                (workspaceMode === "existing" && !existingRef)
              }
              onPress={() => void attach()}
            >
              <Text style={{ color: "#000", backgroundColor: "#fff", padding: 12 }}>
                {busy ? "Attaching…" : "Attach"}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
