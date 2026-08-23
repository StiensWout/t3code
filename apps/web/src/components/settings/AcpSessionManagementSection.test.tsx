import type { ReactElement } from "react";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  list: Symbol("list-acp-sessions"),
  import: Symbol("import-acp-session"),
  logout: Symbol("logout-acp"),
}));

const commands = vi.hoisted(() => ({
  list: vi.fn(),
  import: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    listAcpRegistrySessions: atoms.list,
    importAcpRegistrySession: atoms.import,
    logoutAcpRegistry: atoms.logout,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.list ? commands.list : atom === atoms.import ? commands.import : commands.logout,
}));

import { AcpSessionManagementSection } from "./AcpSessionManagementSection";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
const projectId = ProjectId.make("project-antigravity");
const session = {
  sessionId: "native-session-1",
  cwd: "/workspace/antigravity",
  additionalDirectories: [],
  title: "Native Antigravity session",
  updatedAt: "2026-08-23T00:00:00Z",
  importedThreadId: null,
} as const;
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", canLogout: true },
  nativeSessions: { canList: true, canLoad: true, canResume: true },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function render(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return AcpSessionManagementSection({
    environmentId,
    instanceId,
    provider,
    projects: [{ id: projectId, title: "Antigravity", workspaceRoot: session.cwd }],
    readOnly: false,
  }) as ReactElement<Record<string, unknown>>;
}

function findByLabel(
  tree: ReactElement<Record<string, unknown>>,
  label: string,
): ReactElement<Record<string, unknown>> {
  const found = visitElements(tree, (element) => element.props.children === label);
  expect(found).not.toBeNull();
  return found!;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AcpSessionManagementSection", () => {
  beforeEach(() => {
    hooks.reset();
    commands.list.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { sessions: [session], nextCursor: null, canLoad: true, canResume: true },
    });
    commands.import.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { threadId: ThreadId.make("thread-imported"), imported: true },
    });
    commands.logout.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { loggedOut: true },
    });
  });

  it("lists and imports native sessions through the owning environment", async () => {
    const initial = render();
    (findByLabel(initial, "List sessions").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.list).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });

    const listed = render();
    (findByLabel(listed, "Import").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.import).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    expect(findByLabel(render(), "Imported")).not.toBeNull();
  });

  it("logs out the provider instance through the owning environment", async () => {
    const tree = render();
    (findByLabel(tree, "Log out").props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.logout).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId },
    });
  });
});
