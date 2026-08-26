import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type T3ProjectFileScript,
  type ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

function makeProvider(
  instanceId: string,
  displayName: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId.startsWith("claude") ? "claudeAgent" : "codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-26T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      status: "available",
      planLabel: instanceId.startsWith("claude") ? "Max" : "ChatGPT Plus",
      observedAt: "2026-08-26T10:00:00.000Z",
      windows: [
        {
          id: "five-hour",
          label: "5h",
          remainingPercent: 28,
          resetsAt: "2099-08-26T12:00:00.000Z",
          durationMinutes: 300,
        },
      ],
    },
    ...overrides,
  };
}

const codexProvider = makeProvider("codex", "Codex");

function makeProps(overrides: Partial<ThreadDetailsPanelProps> = {}): ThreadDetailsPanelProps {
  return {
    mode: "popover",
    environmentId: "environment:thread-details" as EnvironmentId,
    environmentConnection: null,
    threadId: "thread:thread-details" as ThreadId,
    activeProjectName: "Thread details project",
    activeProjectScripts: [],
    providers: [codexProvider],
    providerInstanceIds: [codexProvider.instanceId],
    showProviderUsage: true,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    gitCwd: "/tmp/thread-details-project",
    isGitRepo: false,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    onReconnectEnvironment: vi.fn(),
    onOpenConnectionSettings: vi.fn(),
    versionMismatch: null,
    onDismissVersionMismatch: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
    onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
    onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    ...overrides,
  };
}

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props = makeProps({
      environmentId,
      activeProjectName: undefined,
      gitCwd,
    });

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("does not show provider limits on a draft", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel
        {...makeProps({
          draftId: "draft:thread-details" as NonNullable<ThreadDetailsPanelProps["draftId"]>,
        })}
      />,
    );

    expect(markup).not.toContain('aria-label="Provider limits"');
  });

  it("shows provider limits on a saved project thread", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const markup = renderToStaticMarkup(<ThreadDetailsPanel {...makeProps()} />);

    expect(markup).toContain('aria-label="Provider limits"');
    expect(markup).toContain("ChatGPT Plus");
    expect(markup).toContain("28% left");
    expect(markup).toContain('<div aria-label="Provider limits"');
    expect(markup).toContain('aria-label="Show Codex provider limit details"');
    expect(markup).not.toContain('role="progressbar"');
    expect(markup.indexOf(">Usage<")).toBeLessThan(markup.indexOf(">Version Control<"));
  });

  it("hides the usage section when disabled in settings", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel {...makeProps({ showProviderUsage: false })} />,
    );

    expect(markup).not.toContain('id="thread-details-usage-heading"');
    expect(markup).not.toContain('aria-label="Provider limits"');
  });

  it("shows the current provider first, followed by providers used earlier in the thread", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const claudeProvider = makeProvider("claude-work", "Claude Work");

    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel
        {...makeProps({
          providers: [codexProvider, claudeProvider],
          providerInstanceIds: [claudeProvider.instanceId, codexProvider.instanceId],
        })}
      />,
    );

    expect(markup.indexOf("Claude Work")).toBeLessThan(markup.indexOf("Codex"));
  });

  it("disambiguates multiple instances of the same provider", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const personalCodex = makeProvider("codex-personal", "Codex");

    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel
        {...makeProps({
          providers: [codexProvider, personalCodex],
          providerInstanceIds: [codexProvider.instanceId, personalCodex.instanceId],
        })}
      />,
    );

    expect(markup).toContain('aria-label="Show Codex provider limits"');
    expect(markup).toContain('aria-label="Show Codex Personal provider limits"');
  });

  it("hides unsupported limits and unavailable historical providers", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const unsupported = makeProvider("codex", "Codex", {
      usageLimits: { status: "unsupported", windows: [] },
    });
    const unavailableHistory = makeProvider("claude-work", "Claude Work", {
      usageLimits: { status: "unavailable", windows: [] },
    });

    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel
        {...makeProps({
          providers: [unsupported, unavailableHistory],
          providerInstanceIds: [unsupported.instanceId, unavailableHistory.instanceId],
        })}
      />,
    );

    expect(markup).not.toContain('aria-label="Provider limits"');
  });

  it("keeps an unavailable current provider visible", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const unavailable = makeProvider("codex", "Codex", {
      usageLimits: {
        status: "unavailable",
        planLabel: "ChatGPT Plus",
        windows: [],
      },
    });

    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel
        {...makeProps({
          providers: [unavailable],
          providerInstanceIds: [unavailable.instanceId],
        })}
      />,
    );

    expect(markup).toContain('aria-label="Provider limits"');
    expect(markup).toContain("Unavailable");
  });
});
