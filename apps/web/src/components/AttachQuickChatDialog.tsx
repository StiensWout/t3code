import { randomHex } from "../lib/utils";
import { useEffect, useState } from "react";
import { type ScopedThreadRef, type VcsCreateWorktreeResult } from "@t3tools/contracts";
import { useQuickChatAttachmentStore } from "../quickChatAttachmentStore";
import { useProjects, useThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function AttachmentForm({ threadRef }: { threadRef: ScopedThreadRef }) {
  const projects = useProjects().filter(
    (project) => project.environmentId === threadRef.environmentId,
  );
  const thread = useThreadShell(threadRef);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [newWorktree, setNewWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("HEAD");
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<VcsCreateWorktreeResult["worktree"] | null>(null);
  const busy = useQuickChatAttachmentStore((state) => state.busy);
  const update = useAtomCommand(threadEnvironment.updateMetadata, "Attach quick chat");
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, "Create worktree");
  const project = projects.find((candidate) => candidate.id === projectId);
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

  useEffect(() => {
    if (thread?.projectId != null) useQuickChatAttachmentStore.setState({ threadRef: null });
  }, [thread?.projectId]);

  async function attach() {
    if (useQuickChatAttachmentStore.getState().busy || unavailable || !project) return;
    useQuickChatAttachmentStore.setState({ busy: true });
    setError(null);
    try {
      let worktree = prepared;
      if (newWorktree && !worktree) {
        const result = await createWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refName: baseBranch.trim(),
            newRefName: `t3/quick-chat-${randomHex(4)}`,
            path: null,
          },
        });
        if (result._tag === "Failure") {
          setError("Could not create the worktree. The chat is still unattached.");
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
        setError(
          worktree
            ? `Could not confirm attachment. Retry to use the prepared worktree at ${worktree.path}.`
            : "Could not confirm attachment. Check the connection and retry.",
        );
        return;
      }
      useQuickChatAttachmentStore.setState({ threadRef: null });
    } finally {
      useQuickChatAttachmentStore.setState({ busy: false });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Attach to project</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-6 py-4">
        <label className="flex flex-col gap-2 text-sm">
          Project
          <select
            className="h-9 border border-border bg-background px-2 text-foreground"
            value={projectId}
            disabled={busy || prepared !== null}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={newWorktree}
            disabled={busy || prepared !== null}
            onChange={(event) => setNewWorktree(event.target.checked)}
          />
          Create a new worktree
        </label>
        {newWorktree && (
          <label className="flex flex-col gap-2 text-sm">
            Base branch
            <Input
              value={baseBranch}
              disabled={busy || prepared !== null}
              onChange={(event) => setBaseBranch(event.target.value)}
            />
          </label>
        )}
        {projects.length === 0 && (
          <p className="text-sm">Add a project on this environment first.</p>
        )}
        {unavailable && (
          <p className="text-sm">Finish the current turn and background work before attaching.</p>
        )}
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => useQuickChatAttachmentStore.getState().close()}
        >
          Cancel
        </Button>
        <Button
          disabled={busy || unavailable || !project || (newWorktree && !baseBranch.trim())}
          onClick={() => void attach()}
        >
          {busy ? "Attaching…" : "Attach"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function AttachQuickChatDialog() {
  const threadRef = useQuickChatAttachmentStore((state) => state.threadRef);
  return (
    <Dialog
      open={threadRef !== null}
      onOpenChange={(open) => {
        if (!open) useQuickChatAttachmentStore.getState().close();
      }}
    >
      <DialogPopup>
        {threadRef && (
          <AttachmentForm
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            threadRef={threadRef}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
