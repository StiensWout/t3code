import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

function findValueChange(
  node: ReactNode,
):
  | ReactElement<{ readonly children?: ReactNode; readonly onValueChange: (value: string) => void }>
  | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly children?: ReactNode;
      readonly onValueChange?: (value: string) => void;
    };
    if (props.onValueChange) {
      return child as ReactElement<{
        readonly children?: ReactNode;
        readonly onValueChange: (value: string) => void;
      }>;
    }
    const nested = findValueChange(props.children);
    if (nested) return nested;
  }
  return undefined;
}

function findValueChangeForValue(
  node: ReactNode,
  value: string,
): ReactElement<{ readonly onValueChange: (value: string) => void }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly children?: ReactNode;
      readonly value?: string;
      readonly onValueChange?: (value: string) => void;
    };
    if (props.value === value && props.onValueChange) {
      return child as ReactElement<{ readonly onValueChange: (value: string) => void }>;
    }
    const nested = findValueChangeForValue(props.children, value);
    if (nested) return nested;
  }
  return undefined;
}

/** The nested radio-group component element carrying this label, invoked so its group shows. */
function findLabeledGroup(node: ReactNode, label: string): ReactNode {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { readonly children?: ReactNode; readonly label?: string };
    if (props.label === label && typeof child.type === "function") {
      return (child.type as (properties: unknown) => ReactNode)(child.props);
    }
    const nested = findLabeledGroup(props.children, label);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function menu(overrides: Partial<Parameters<typeof PullRequestFiltersMenu>[0]>) {
  const environmentId = EnvironmentId.make("environment-1");
  return PullRequestFiltersMenu({
    state: "open",
    stateOptions: [
      { value: "open", label: "Open", Icon: CircleIcon },
      { value: "closed", label: "Closed", Icon: CircleIcon },
    ],
    onState: () => undefined,
    involvement: "all",
    involvementOptions: [{ value: "all", label: "All", Icon: CircleIcon }],
    onInvolvement: () => undefined,
    host: undefined,
    hostOptions: [],
    onHost: () => undefined,
    environmentId,
    environments: [{ id: environmentId, label: "Local", isPrimary: true, projects: [] }],
    projectId: undefined,
    unavailable: new Map(),
    onProjectScope: () => undefined,
    ...overrides,
  });
}

describe("pull request filters menu", () => {
  it("does not emit a change when the selected state is chosen again", () => {
    const onState = vi.fn();
    const group = findValueChange(findLabeledGroup(menu({ onState }), "State"));
    expect(group).toBeDefined();

    group?.props.onValueChange("open");
    expect(onState).not.toHaveBeenCalled();

    group?.props.onValueChange("closed");
    expect(onState).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith("closed");
  });

  it("does not emit a change when the selected project is chosen again", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = "project-1" as ProjectId;
    const onProjectScope = vi.fn();
    const view = menu({
      environmentId,
      environments: [
        {
          id: environmentId,
          label: "Local",
          isPrimary: true,
          projects: [{ id: projectId, title: "T3 Code", workspaceRoot: "/work/t3code" }],
        },
      ],
      projectId,
      onProjectScope,
    });
    const radioGroup = findValueChangeForValue(view, JSON.stringify([environmentId, projectId]));
    expect(radioGroup).toBeDefined();

    radioGroup?.props.onValueChange(JSON.stringify([environmentId, projectId]));
    expect(onProjectScope).not.toHaveBeenCalled();

    radioGroup?.props.onValueChange("all-projects");
    expect(onProjectScope).toHaveBeenLastCalledWith(environmentId, undefined);
  });

  it("selects all servers independently from the project filter", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const onProjectScope = vi.fn();
    const view = menu({ environmentId, onProjectScope });
    const serverGroup = findValueChangeForValue(view, environmentId);

    serverGroup?.props.onValueChange("all-environments");

    expect(onProjectScope).toHaveBeenCalledWith(null, undefined);
  });

  it("selects a project together with its remote server", () => {
    const localEnvironmentId = EnvironmentId.make("environment-1");
    const remoteEnvironmentId = EnvironmentId.make("environment-2");
    const remoteProjectId = "project-2" as ProjectId;
    const onProjectScope = vi.fn();
    const view = menu({
      environmentId: null,
      environments: [
        { id: localEnvironmentId, label: "Local", isPrimary: true, projects: [] },
        {
          id: remoteEnvironmentId,
          label: "Remote",
          isPrimary: false,
          projects: [
            { id: remoteProjectId, title: "Remote project", workspaceRoot: "/work/remote" },
          ],
        },
      ],
      onProjectScope,
    });
    const projectGroup = findValueChangeForValue(view, "all-projects");

    projectGroup?.props.onValueChange(JSON.stringify([remoteEnvironmentId, remoteProjectId]));

    expect(onProjectScope).toHaveBeenCalledWith(remoteEnvironmentId, remoteProjectId);
  });
});
