import { useRef, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import type { ScopedThreadRef, VcsCreateWorktreeResult } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { uuidv4 } from "../../lib/uuid";

export function QuickChatProjectAttachment({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [newWorktree, setNewWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [prepared, setPrepared] = useState<VcsCreateWorktreeResult["worktree"] | null>(null);
  const projects = useProjects().filter(
    (project) => project.environmentId === threadRef.environmentId,
  );
  const thread = useThreadShell(threadRef);
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, "Create worktree");
  const update = useAtomCommand(threadEnvironment.updateMetadata, "Attach quick chat");
  const project = projectId ? projects.find((project) => project.id === projectId) : projects[0];
  const unavailable =
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
      let worktree = prepared;
      if (newWorktree && !worktree) {
        const result = await createWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refName: baseBranch.trim(),
            newRefName: `t3/quick-chat-${uuidv4().slice(0, 8)}`,
            path: null,
          },
        });
        if (result._tag === "Failure") {
          Alert.alert("Could not create worktree", "The chat is still unattached.");
          return;
        }
        worktree = result.value.worktree;
        setPrepared(worktree);
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
      setOpen(false);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={unavailable}
        onPress={() => setOpen(true)}
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
            {projects.map((candidate) => (
              <Pressable
                key={candidate.id}
                disabled={busy || prepared !== null}
                onPress={() => setProjectId(candidate.id)}
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
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                marginVertical: 20,
              }}
            >
              <Text style={{ color: "#fff" }}>Create a new worktree</Text>
              <Switch
                value={newWorktree}
                disabled={busy || prepared !== null}
                onValueChange={setNewWorktree}
              />
            </View>
            {newWorktree && (
              <>
                <Text style={{ color: "#fff" }}>Base branch</Text>
                <TextInput
                  accessibilityLabel="Base branch"
                  value={baseBranch}
                  editable={!busy && prepared === null}
                  onChangeText={setBaseBranch}
                  autoCapitalize="none"
                  style={{
                    color: "#fff",
                    borderColor: "#555",
                    borderWidth: 1,
                    padding: 12,
                    marginTop: 8,
                  }}
                />
              </>
            )}
            {unavailable && (
              <Text style={{ color: "#fff" }}>
                Finish the current turn and background work before attaching.
              </Text>
            )}
          </ScrollView>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 24 }}>
            <Pressable disabled={busy} onPress={() => setOpen(false)}>
              <Text style={{ color: "#fff", padding: 12 }}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={busy || unavailable || !project || (newWorktree && !baseBranch.trim())}
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
