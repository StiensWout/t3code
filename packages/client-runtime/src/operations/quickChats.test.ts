import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  createQuickChatAttachmentStorage,
  prepareQuickChatWorktree,
  quickChatModelSelection,
} from "./quickChats";

const ready: ServerProvider = {
  instanceId: ProviderInstanceId.make("ready"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  models: [{ slug: "model", name: "Model", isCustom: false, capabilities: {} }],
  slashCommands: [],
  skills: [],
};

it("skips an errored preferred provider and selects an available agent", () => {
  const failed: ServerProvider = {
    ...ready,
    instanceId: ProviderInstanceId.make("failed"),
    status: "error",
  };
  const settings = { defaultModelSelection: { instanceId: failed.instanceId, model: "model" } };
  expect(quickChatModelSelection({ providers: [failed, ready], settings })).toEqual({
    instanceId: ready.instanceId,
    model: "model",
  });
  expect(quickChatModelSelection({ providers: [failed], settings })).toBeNull();
});

it("recovers the same worktree after losing its creation response and reloading storage", async () => {
  const disk = new Map<string, string>();
  const storage = {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => {
      disk.set(key, value);
    },
    removeItem: (key: string) => {
      disk.delete(key);
    },
  };
  const ref = { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("chat") };
  const pending = {
    projectId: ProjectId.make("project"),
    workspaceRoot: "/project",
    baseBranch: "main",
    branch: "t3/quick-chat-retry",
  };
  const first = createQuickChatAttachmentStorage(storage);
  await first.save(ref, pending);
  const worktree = { path: "/worktree", refName: pending.branch };
  let created = false;
  let creations = 0;
  const listRefs = async (): Promise<VcsListRefsResult> => ({
    refs: created
      ? [{ name: pending.branch, current: false, isDefault: false, worktreePath: worktree.path }]
      : [],
    isRepo: true,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: created ? 1 : 0,
  });
  const createWorktree = async () => {
    creations += 1;
    created = true;
    throw new Error("Connection lost after creation");
  };
  await expect(prepareQuickChatWorktree({ pending, listRefs, createWorktree })).rejects.toThrow(
    "Connection lost",
  );
  const reloaded = createQuickChatAttachmentStorage(storage);
  const recovered = reloaded.load(ref);
  expect(recovered).toEqual(pending);
  expect(await prepareQuickChatWorktree({ pending: recovered!, listRefs, createWorktree })).toEqual(
    worktree,
  );
  expect(creations).toBe(1);
  expect(reloaded.load({ ...ref, environmentId: EnvironmentId.make("other") })).toBeNull();
  reloaded.clear(ref);
  expect(first.load(ref)).toBeNull();
});
