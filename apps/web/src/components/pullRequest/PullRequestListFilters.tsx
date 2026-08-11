import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListState,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  FolderGit2Icon,
  LayersIcon,
  ListFilterIcon,
  LoaderIcon,
  MonitorIcon,
  SearchIcon,
  ServerIcon,
} from "lucide-react";
import type { ElementType } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { ProjectFavicon } from "../ProjectFavicon";

import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /**
   * Carries the option's own tone, so an icon reads the same here as it does on a row. Left
   * uncoloured, which lets the item's selected state stay the thing the eye follows.
   */
  readonly Icon: ElementType<{ className?: string }>;
  /** Why it cannot be chosen, carried onto the item as its title. */
  readonly unavailable?: string | undefined;
}

export interface PullRequestExpectedHost {
  readonly host: string;
  readonly kind: SourceControlProviderKind;
}

/**
 * What to call a host in the row. The provider's own name reads best — "GitHub" over
 * "github.com" — but it stops naming anything once a workspace has two hosts of one kind, so
 * those wear the host itself instead. Only the ambiguous ones: a lone GitLab beside two GitHub
 * installs is still "GitLab".
 */
export function pullRequestHostLabel(
  entries: ReadonlyArray<{ readonly host: string; readonly kind: SourceControlProviderKind }>,
  entry: { readonly host: string; readonly kind: SourceControlProviderKind },
): string {
  const sharing = entries.filter((candidate) => candidate.kind === entry.kind);
  return sharing.length > 1
    ? entry.host
    : getSourceControlPresentationForKind(entry.kind).providerName;
}

export function PullRequestSearchInput({
  value,
  busy,
  onChange,
}: {
  value: string;
  /** A search is on its way to the hosts, said where the typing is rather than over the list. */
  busy?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      {busy ? (
        <LoaderIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      ) : (
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
      )}
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search pull requests"
        aria-label="Search pull requests"
        // Tracks the shared input's height at both widths, so it stays level with the icon
        // button beside it rather than towering over it on wide screens.
        className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:h-8"
      />
    </div>
  );
}

/**
 * Every list filter lives behind the one filter icon so the control row stays two controls
 * wide: the search and this. The trigger carries a dot whenever any filter is off its
 * default, so a narrowed list is never a mystery. Same menu chrome as the detail panel's
 * actions, which also owns its own spacing.
 */
/** MenuRadioGroup wants a string, so "every host" wears the one value no host can be. */
const ALL_HOSTS_VALUE = "";
const ALL_ENVIRONMENTS_VALUE = "all-environments";
const ALL_PROJECTS_VALUE = "all-projects";

interface PullRequestProjectOption {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface PullRequestProjectEnvironmentOption {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly projects: ReadonlyArray<PullRequestProjectOption>;
}

export function pullRequestProjectScopeValue(
  environmentId: EnvironmentId,
  projectId?: ProjectId,
): string {
  return JSON.stringify([environmentId, projectId ?? null]);
}

function EnvironmentIcon({ isPrimary }: { isPrimary: boolean }) {
  const Icon = isPrimary ? MonitorIcon : ServerIcon;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

function AllProjectsLabel({ label = "All projects" }: { label?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <LayersIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </span>
  );
}

function ProjectLabel({
  environment,
  project,
  unavailable,
  showEnvironment,
}: {
  environment: PullRequestProjectEnvironmentOption;
  project: PullRequestProjectOption;
  unavailable?: string;
  showEnvironment?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <ProjectFavicon
        environmentId={environment.id}
        cwd={project.workspaceRoot}
        fallbackIcon={FolderGit2Icon}
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">{project.title}</span>
      {showEnvironment ? (
        <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
          {environment.label}
        </span>
      ) : null}
      {unavailable === undefined ? null : (
        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400/90">
          Unavailable
        </span>
      )}
    </span>
  );
}

function sortedProjects(
  environment: PullRequestProjectEnvironmentOption,
  unavailable: ReadonlyMap<string, string>,
) {
  return environment.projects.toSorted(
    (left, right) =>
      Number(unavailable.has(pullRequestProjectScopeValue(environment.id, left.id))) -
      Number(unavailable.has(pullRequestProjectScopeValue(environment.id, right.id))),
  );
}

function ProjectScopeItem({
  environment,
  project,
  unavailable,
  showEnvironment,
}: {
  environment: PullRequestProjectEnvironmentOption;
  project: PullRequestProjectOption;
  unavailable: ReadonlyMap<string, string>;
  showEnvironment?: boolean;
}) {
  const reason = unavailable.get(pullRequestProjectScopeValue(environment.id, project.id));
  return (
    <MenuRadioItem
      value={pullRequestProjectScopeValue(environment.id, project.id)}
      disabled={reason !== undefined}
      title={reason}
    >
      <ProjectLabel
        environment={environment}
        project={project}
        {...(reason === undefined ? {} : { unavailable: reason })}
        {...(showEnvironment === undefined ? {} : { showEnvironment })}
      />
    </MenuRadioItem>
  );
}

function PullRequestFilterRadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as Value);
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => (
        <MenuRadioItem
          key={option.value}
          value={option.value}
          // A host the server has already said it cannot read is not a choice here: offering
          // it would answer the press by replacing a working list with that failure.
          disabled={option.unavailable !== undefined}
          title={option.unavailable}
        >
          <span className="flex min-w-0 items-center gap-2">
            <option.Icon aria-hidden className="size-3.5" />
            {option.label}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

export function PullRequestFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  host,
  hostOptions,
  onHost,
  environmentId,
  environments,
  projectId,
  unavailable,
  onProjectScope,
}: {
  state: PullRequestListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;
  onState: (state: PullRequestListState) => void;
  involvement: PullRequestInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  host: string | undefined;
  /**
   * Includes the "all hosts" entry, whose value is the empty string. With fewer than two real
   * hosts there is nothing to switch between, so the whole group stays out of the menu.
   */
  hostOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
  /** The environment whose projects and pull requests are currently in scope. */
  environmentId: EnvironmentId | null;
  environments: ReadonlyArray<PullRequestProjectEnvironmentOption>;
  projectId: ProjectId | undefined;
  /**
   * Projects whose repository could not be read this time round. They are named here, where
   * the reader is already choosing between projects, rather than as a count above the list
   * that says something is missing without saying which.
   */
  unavailable: ReadonlyMap<string, string>;
  onProjectScope: (environmentId: EnvironmentId | null, projectId: ProjectId | undefined) => void;
}) {
  const selectedEnvironment =
    environments.find((environment) => environment.id === environmentId) ?? null;
  const selectedScopeValue =
    selectedEnvironment === null || projectId === undefined
      ? ALL_PROJECTS_VALUE
      : pullRequestProjectScopeValue(selectedEnvironment.id, projectId);
  const selectScopeValue = (next: string) => {
    if (next === selectedScopeValue) return;
    if (next === ALL_PROJECTS_VALUE) {
      onProjectScope(environmentId, undefined);
      return;
    }
    for (const environment of environments) {
      const project = environment.projects.find(
        (candidate) => next === pullRequestProjectScopeValue(environment.id, candidate.id),
      );
      if (project !== undefined) {
        onProjectScope(environment.id, project.id);
        return;
      }
    }
  };
  const filtered =
    state !== "open" ||
    involvement !== "all" ||
    host !== undefined ||
    environmentId !== null ||
    projectId !== undefined;
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          // The icon-button size that pairs with a full-height input, so the two read as one strip.
          "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:size-8",
          filtered && "text-foreground",
        )}
        aria-label="Filter pull requests"
      >
        <ListFilterIcon className="size-4" />
        {filtered ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-56">
        <PullRequestFilterRadioGroup
          label="State"
          value={state}
          options={stateOptions}
          onChange={onState}
        />
        <MenuSeparator />
        <PullRequestFilterRadioGroup
          label="Involvement"
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
        {hostOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
              label="Host"
              value={host ?? ALL_HOSTS_VALUE}
              options={hostOptions}
              onChange={(next) => onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
            />
          </>
        ) : null}
        <MenuSeparator />
        <MenuRadioGroup
          value={environmentId ?? ALL_ENVIRONMENTS_VALUE}
          onValueChange={(next) =>
            onProjectScope(
              next === ALL_ENVIRONMENTS_VALUE ? null : (next as EnvironmentId),
              undefined,
            )
          }
        >
          <MenuGroupLabel>Server</MenuGroupLabel>
          <MenuRadioItem value={ALL_ENVIRONMENTS_VALUE} closeOnClick={false}>
            <AllProjectsLabel label="All servers" />
          </MenuRadioItem>
          {environments.map((environment) => (
            <MenuRadioItem key={environment.id} value={environment.id} closeOnClick={false}>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentIcon isPrimary={environment.isPrimary} />
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuRadioGroup value={selectedScopeValue} onValueChange={selectScopeValue}>
          <MenuGroupLabel className="pt-2">Project</MenuGroupLabel>
          <MenuRadioItem value={ALL_PROJECTS_VALUE}>
            <AllProjectsLabel />
          </MenuRadioItem>
          {(selectedEnvironment === null ? environments : [selectedEnvironment]).flatMap(
            (environment) =>
              sortedProjects(environment, unavailable).map((project) => (
                <ProjectScopeItem
                  key={pullRequestProjectScopeValue(environment.id, project.id)}
                  environment={environment}
                  project={project}
                  unavailable={unavailable}
                  showEnvironment={selectedEnvironment === null}
                />
              )),
          )}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
