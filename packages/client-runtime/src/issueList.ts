import {
  issueListCursorKey,
  parseIssueListCursorKey,
  type EnvironmentId,
  type IssueListCursors,
  type IssueListEntry,
  type IssueListInput,
  type IssueListProjectError,
  type IssueListResult,
  type IssueListSort,
  type IssueScopeRef,
  type IssueTrackerSummary,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import {
  INITIAL_ISSUE_LIST_REVISION,
  issueEntryKey,
  mergeIssueListPage,
  type IssueListRevision,
} from "./state/issues.ts";
import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject } from "./state/shell.ts";

export interface EnvironmentIssueEntry extends IssueListEntry {
  readonly environmentId: EnvironmentId;
}

interface IssuePageError<T> {
  readonly keys: ReadonlyArray<string>;
  readonly error: T;
}

interface FirstPageBoundary {
  readonly rows: ReadonlyArray<readonly [string, string]>;
  readonly cursor: string | undefined;
}

/** Rows from every environment that answered, with any continuation pages laid over them. */
export interface HeldIssuePage {
  readonly answer: IssueListResult;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly errors: ReadonlyArray<IssueListProjectError>;
  readonly moreErrors: ReadonlyArray<IssuePageError<IssueListProjectError>>;
  readonly nextCursors: IssueListCursors;
  readonly moreFailures: ReadonlyArray<IssuePageError<string>>;
  /** The last successful boundary of each scope; its identity also guards in-flight reads. */
  readonly boundaries: ReadonlyMap<string, FirstPageBoundary>;
  /** The listing these pages answer, as `JSON.stringify` of its input. */
  readonly listing: string;
  readonly revision: IssueListRevision;
}

function keepPageError<T>(failure: IssuePageError<T>, keepKey: (key: string) => boolean) {
  const keys = failure.keys.filter(keepKey);
  return keys.length === 0 ? [] : [{ ...failure, keys }];
}

function scopeWasEdited(key: string, before: IssueListRevision, after: IssueListRevision) {
  const target = parseIssueListCursorKey(key);
  if (target === undefined) return false;
  const normalized = issueListCursorKey(target.host.toLowerCase(), target.scope);
  return (
    before.byCursor.get(normalized) !== after.byCursor.get(normalized) ||
    before.anyHost.get(target.scope.toLowerCase()) !== after.anyHost.get(target.scope.toLowerCase())
  );
}

export function issueTrackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

function firstPageBoundaries(answer: IssueListResult, sort: IssueListSort) {
  const rowsByScope = new Map<string, Array<readonly [string, string]>>();
  for (const row of answer.entries) {
    const key = issueListCursorKey(row.host, row.scope);
    const item = [issueEntryKey(row), sort === "created" ? row.createdAt : row.updatedAt] as const;
    const rows = rowsByScope.get(key);
    if (rows) rows.push(item);
    else rowsByScope.set(key, [item]);
  }
  return new Map<string, FirstPageBoundary>(
    [...new Set([...rowsByScope.keys(), ...Object.keys(answer.nextCursors)])].map((key) => [
      key,
      { rows: rowsByScope.get(key) ?? [], cursor: answer.nextCursors[key] },
    ]),
  );
}

function errorCursorKeys(error: IssueListProjectError, scopes: ReadonlyArray<IssueScopeRef>) {
  if (error.cursorKey !== undefined) return [error.cursorKey];
  return scopes.flatMap((scope) =>
    scope.projectId === error.projectId && scope.host !== undefined
      ? [issueListCursorKey(scope.host, scope.scope)]
      : [],
  );
}

/** Keep the current rows and cursor only for scopes whose first page still supports them. */
export function holdIssuePages(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  pages: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  input: IssueListInput,
  revisions?: ReadonlyMap<EnvironmentId, IssueListRevision>,
): ReadonlyMap<EnvironmentId, HeldIssuePage> {
  const listing = JSON.stringify(input);
  const oldKeys = pages.keys();
  let changed = answers.length !== pages.size;
  const next = new Map<EnvironmentId, HeldIssuePage>();
  for (const [environmentId, answer] of answers) {
    const previous = pages.get(environmentId);
    const revision = revisions?.get(environmentId) ?? INITIAL_ISSUE_LIST_REVISION;
    if (oldKeys.next().value !== environmentId) changed = true;
    if (
      previous?.answer === answer &&
      previous.listing === listing &&
      previous.revision === revision
    ) {
      next.set(environmentId, previous);
      continue;
    }
    changed = true;
    const boundaries = firstPageBoundaries(answer, input.sort ?? "updated");
    const first: HeldIssuePage = {
      answer,
      entries: answer.entries,
      errors: answer.errors,
      moreErrors: [],
      nextCursors: answer.nextCursors,
      moreFailures: [],
      boundaries,
      listing,
      revision,
    };
    if (previous?.listing !== listing) {
      next.set(environmentId, first);
      continue;
    }
    const covered = answer.scopes?.flatMap((scope) =>
      scope.host === undefined ? [] : [issueListCursorKey(scope.host, scope.scope)],
    );
    const failed = new Set(
      answer.errors.flatMap((error) => errorCursorKeys(error, answer.scopes ?? previous.entries)),
    );
    const nextCursors = { ...answer.nextCursors };
    for (const [key, before] of previous.boundaries) {
      const after = boundaries.get(key);
      if (scopeWasEdited(key, previous.revision, revision)) continue;
      if (after === undefined) {
        if (!failed.has(key) || (covered !== undefined && !covered.includes(key))) continue;
      } else if (before.cursor !== after.cursor || !Equal.equals(before.rows, after.rows)) {
        continue;
      }
      boundaries.set(key, before);
      const cursor = previous.nextCursors[key];
      if (cursor === undefined) delete nextCursors[key];
      else nextCursors[key] = cursor;
    }
    const keepKey = (key: string) => {
      const before = previous.boundaries.get(key);
      return before !== undefined && boundaries.get(key) === before;
    };
    const moreErrors = previous.moreErrors.flatMap((failure) => keepPageError(failure, keepKey));
    next.set(environmentId, {
      ...first,
      entries: mergeIssueListPage(
        previous.entries.filter((row) => keepKey(issueListCursorKey(row.host, row.scope))),
        answer.entries,
      ),
      errors: [...answer.errors, ...moreErrors.map((failure) => failure.error)],
      moreErrors,
      moreFailures: previous.moreFailures.flatMap((failure) => keepPageError(failure, keepKey)),
      nextCursors,
    });
  }
  return changed ? next : pages;
}

/** The cursors of one tracker host, so its "Load more" leaves the other trackers where they are. */
export function issueCursorsForHost(cursors: IssueListCursors, host: string): IssueListCursors {
  return Object.fromEntries(Object.entries(cursors).filter(([key]) => cursorIsOnHost(key, host)));
}

function cursorIsOnHost(key: string, host: string): boolean {
  return parseIssueListCursorKey(key)?.host.toLowerCase() === host.toLowerCase();
}

export function issuePageFailuresForHost(page: HeldIssuePage, host: string): ReadonlyArray<string> {
  return page.moreFailures.flatMap(({ keys, error }) =>
    keys.some((key) => cursorIsOnHost(key, host)) ? [error] : [],
  );
}

/** Only the requested scopes advance or replace errors from a previous attempt. */
export function continueIssuePage(
  page: HeldIssuePage,
  next: IssueListResult | { readonly failure: string },
  asked: IssueListCursors = page.nextCursors,
  current: IssueListCursors = asked,
): HeldIssuePage {
  const keys = Object.keys(asked);
  const isCurrent = (key: string) => key in current;
  const notCurrent = (key: string) => !isCurrent(key);
  const moreFailures = page.moreFailures.flatMap((failure) => keepPageError(failure, notCurrent));
  if ("failure" in next) {
    return {
      ...page,
      moreFailures: [...moreFailures, { keys: Object.keys(current), error: next.failure }],
    };
  }
  const moreErrors = page.moreErrors.flatMap((failure) => keepPageError(failure, notCurrent));
  const scopes = next.scopes ?? page.answer.scopes ?? page.entries;
  for (const error of next.errors) {
    const candidates = errorCursorKeys(error, scopes);
    const matching = keys.filter((key) => candidates.includes(key));
    const affected = (
      matching.length === 0 && error.cursorKey === undefined ? keys : matching
    ).filter(isCurrent);
    if (affected.length > 0) moreErrors.push({ error, keys: affected });
  }
  const nextCursors = {
    ...Object.fromEntries(Object.entries(page.nextCursors).filter(([key]) => notCurrent(key))),
    ...Object.fromEntries(Object.entries(next.nextCursors).filter(([key]) => isCurrent(key))),
  };
  for (const { error } of moreErrors) {
    const key = error.cursorKey;
    if (key !== undefined && isCurrent(key)) nextCursors[key] = current[key]!;
  }
  return {
    ...page,
    entries: mergeIssueListPage(
      page.entries,
      current === asked
        ? next.entries
        : next.entries.filter((row) => isCurrent(issueListCursorKey(row.host, row.scope))),
    ),
    errors: [...page.answer.errors, ...moreErrors.map((failure) => failure.error)],
    moreErrors,
    nextCursors,
    moreFailures,
  };
}

/** Apply the slices that still have the boundary and cursor from when they were requested. */
export function finishIssuePage(
  pages: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  environmentId: EnvironmentId,
  requested: HeldIssuePage,
  next: IssueListResult | { readonly failure: string },
  asked: IssueListCursors = requested.nextCursors,
): ReadonlyMap<EnvironmentId, HeldIssuePage> {
  const page = pages.get(environmentId);
  if (page?.listing !== requested.listing) return pages;
  const current = Object.fromEntries(
    Object.entries(asked).filter(([key, cursor]) => {
      const boundary = requested.boundaries.get(key);
      return (
        boundary !== undefined &&
        page.boundaries.get(key) === boundary &&
        page.nextCursors[key] === cursor
      );
    }),
  );
  if (Object.keys(current).length === 0) return pages;
  return new Map(pages).set(environmentId, continueIssuePage(page, next, asked, current));
}

/** Newest first by the date the trackers were asked to sort on, so merged rows keep that order. */
export function issueOrder(sort: IssueListSort) {
  const date = (issue: IssueListEntry) =>
    Date.parse(sort === "created" ? issue.createdAt : issue.updatedAt);
  return (left: IssueListEntry, right: IssueListEntry) => date(right) - date(left);
}

export function groupIssues(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  query: string,
  projects: ReadonlyArray<EnvironmentProject>,
  sort: IssueListSort = "updated",
) {
  const byTracker = new Map<
    string,
    {
      tracker: IssueTrackerSummary;
      rows: EnvironmentIssueEntry[];
      errors: Array<{ projectTitle: string; message: string; environmentId: EnvironmentId }>;
      more: EnvironmentId[];
    }
  >();
  const listed = new Set<string>();
  const needle = query.toLowerCase();
  for (const [environmentId, page] of held) {
    for (const tracker of page.answer.trackers) {
      const key = issueTrackerKey(tracker);
      if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
      const group = byTracker.get(key)!;
      if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
      if (Object.keys(page.nextCursors).some((key) => cursorIsOnHost(key, tracker.host)))
        group.more.push(environmentId);
    }
    for (const entry of page.entries) {
      const key = issueTrackerKey(entry);
      const group = byTracker.get(key);
      if (!group) continue;
      // A tracker that cannot search is narrowed here instead.
      if (
        needle.length > 0 &&
        group.tracker.capabilities?.search !== true &&
        !entry.title.toLowerCase().includes(needle) &&
        !entry.displayKey.toLowerCase().includes(needle)
      )
        continue;
      // Environments holding the same repository answer the same issue; the first one keeps it.
      if (listed.has(entry.url)) continue;
      listed.add(entry.url);
      group.rows.push({ ...entry, environmentId });
    }
    for (const error of page.errors) {
      const project = projects.find(
        (p) => p.environmentId === environmentId && p.id === error.projectId,
      );
      const kind = project?.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
      const host = kind
        ? sourceControlClients.changeRequestHost(project?.repositoryIdentity, kind)
        : null;
      const cursorKey = error.cursorKey;
      const group = cursorKey
        ? [...byTracker.values()].find((group) => cursorIsOnHost(cursorKey, group.tracker.host))
        : ((host ? byTracker.get(`${kind} ${host.toLowerCase()}`) : undefined) ??
          [...byTracker.values()][0]);
      group?.errors.push({ ...error, environmentId });
    }
  }
  for (const group of byTracker.values()) group.rows.sort(issueOrder(sort));
  return [...byTracker.values()].sort((a, b) =>
    issueTrackerKey(a.tracker).localeCompare(issueTrackerKey(b.tracker)),
  );
}

/** The scopes whose labels and people a list filter offers, each reached through one project. */
export function issueFilterScopes(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  projects: ReadonlyArray<EnvironmentProject>,
) {
  const scopes: Array<{ readonly environmentId: EnvironmentId; readonly input: IssueScopeRef }> =
    [];
  for (const [environmentId, page] of held) {
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      const identity = project.repositoryIdentity;
      const kind = identity?.provider as SourceControlProviderKind | undefined;
      const scope = sourceControlClients.issueScope(identity);
      if (!identity || !kind || scope === null) continue;
      const host = sourceControlClients.changeRequestHost(identity, kind);
      const tracker = page.answer.trackers.find(
        (t) => String(t.tracker) === kind && t.host.toLowerCase() === host.toLowerCase(),
      );
      if (!tracker?.configured || tracker.capabilities === null) continue;
      if (
        scopes.some(
          (s) => s.input.scope.toLowerCase() === scope.toLowerCase() && s.input.host === host,
        )
      )
        continue;
      scopes.push({
        environmentId,
        input: { projectId: project.id, tracker: tracker.tracker, host, scope },
      });
    }
    // A tracker bound in settings (a Linear team) is no repository's; the answer names its scope,
    // matched or not. Older servers do not, so their rows stand in.
    const covered: ReadonlyArray<IssueScopeRef> =
      page.answer.scopes ??
      page.entries.map(({ projectId, tracker, host, scope }) => ({
        projectId,
        tracker,
        host,
        scope,
      }));
    for (const input of covered) {
      const host = input.host?.toLowerCase();
      const tracker = page.answer.trackers.find(
        (t) => t.tracker === input.tracker && t.host.toLowerCase() === host,
      );
      if (!tracker?.configured) continue;
      if (!tracker.capabilities?.labels && !tracker.capabilities?.assignees) continue;
      if (
        scopes.some(
          (s) =>
            s.input.scope.toLowerCase() === input.scope.toLowerCase() &&
            s.input.host?.toLowerCase() === host,
        )
      )
        continue;
      scopes.push({ environmentId, input });
    }
  }
  return scopes;
}
