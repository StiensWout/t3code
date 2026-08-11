import { createPullRequestEnvironmentAtoms } from "@t3tools/client-runtime/state/pull-requests";
import type {
  EnvironmentId,
  PullRequestDiffStat,
  PullRequestListEntry,
  PullRequestListInput,
  PullRequestListProjectError,
  PullRequestListResult,
  PullRequestListStatsResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);

export interface ScopedPullRequestListEntry extends PullRequestListEntry {
  readonly environmentId: EnvironmentId;
  /** Captured per environment so two servers using the same host can have different accounts. */
  readonly viewerLogin: string | null;
}

export interface ScopedPullRequestListProjectError extends PullRequestListProjectError {
  readonly environmentId: EnvironmentId;
}

export interface ScopedPullRequestListResult extends Omit<
  PullRequestListResult,
  "entries" | "errors"
> {
  readonly entries: ReadonlyArray<ScopedPullRequestListEntry>;
  readonly errors: ReadonlyArray<ScopedPullRequestListProjectError>;
}

export interface ScopedPullRequestDiffStat extends PullRequestDiffStat {
  readonly environmentId: EnvironmentId;
}

export interface ScopedPullRequestListStatsResult extends Omit<
  PullRequestListStatsResult,
  "stats"
> {
  readonly stats: ReadonlyArray<ScopedPullRequestDiffStat>;
}

interface MultiEnvironmentListKey {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly input: PullRequestListInput;
}

interface MultiEnvironmentStatsKey {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly refs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: PullRequestDiffStat["projectId"];
    readonly repository: string;
    readonly number: number;
  }>;
}

function scopedCursorKey(environmentId: EnvironmentId, key: string): string {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed[0] === environmentId && typeof parsed[1] === "string") {
      return key;
    }
  } catch {
    // An ordinary server cursor key is not JSON and is scoped below.
  }
  return JSON.stringify([environmentId, key]);
}

export function pullRequestCursorsForEnvironment(
  environmentId: EnvironmentId,
  cursors: PullRequestListInput["cursors"],
): PullRequestListInput["cursors"] {
  if (cursors === undefined) return undefined;
  const scoped = Object.fromEntries(
    Object.entries(cursors).flatMap(([key, cursor]) => {
      try {
        const parsed: unknown = JSON.parse(key);
        return Array.isArray(parsed) && parsed[0] === environmentId && typeof parsed[1] === "string"
          ? [[parsed[1], cursor] as const]
          : [];
      } catch {
        return [];
      }
    }),
  );
  return Object.keys(scoped).length === 0 ? undefined : scoped;
}

function combineResults<A, B, E>(
  results: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly result: AsyncResult.AsyncResult<A, E>;
  }>,
  merge: (values: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly value: A }>) => B,
): AsyncResult.AsyncResult<B, E> {
  const values = results.flatMap(({ environmentId, result }) =>
    Option.match(AsyncResult.value(result), {
      onNone: () => [],
      onSome: (value) => [{ environmentId, value }],
    }),
  );
  const waiting = results.some(({ result }) => result.waiting);
  const failure = results.find(({ result }) => result._tag === "Failure")?.result;
  if (values.length === 0) {
    return failure?._tag === "Failure"
      ? AsyncResult.failure(failure.cause, { waiting })
      : AsyncResult.initial(waiting);
  }
  const success = AsyncResult.success(merge(values), { waiting });
  return failure?._tag === "Failure"
    ? AsyncResult.failure(failure.cause, { previousSuccess: Option.some(success), waiting })
    : success;
}

function mergeProviders(values: ReadonlyArray<PullRequestListResult>) {
  const providers = new Map<string, PullRequestListResult["providers"][number]>();
  for (const provider of values.flatMap((value) => value.providers)) {
    const previous = providers.get(provider.host);
    providers.set(
      provider.host,
      previous === undefined
        ? provider
        : {
            ...previous,
            projectCount: previous.projectCount + provider.projectCount,
            searchesOnHost: previous.searchesOnHost && provider.searchesOnHost,
            configured: previous.configured && provider.configured,
            detail: previous.detail ?? provider.detail,
          },
    );
  }
  return [...providers.values()];
}

export function scopePullRequestListResult(
  environmentId: EnvironmentId,
  value: PullRequestListResult,
): ScopedPullRequestListResult {
  return {
    ...value,
    entries: value.entries.map((entry) => ({
      ...entry,
      environmentId,
      viewerLogin: value.viewers[entry.host] ?? null,
    })),
    errors: value.errors.map((error) => ({ ...error, environmentId })),
    nextCursors: Object.fromEntries(
      Object.entries(value.nextCursors).map(([key, cursor]) => [
        scopedCursorKey(environmentId, key),
        cursor,
      ]),
    ),
  };
}

export function mergePullRequestLists(
  values: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly value: PullRequestListResult;
  }>,
): ScopedPullRequestListResult {
  const scopedValues = values.map(({ environmentId, value }) => ({
    raw: value,
    scoped: scopePullRequestListResult(environmentId, value),
  }));
  return {
    viewers: Object.assign({}, ...values.map(({ value }) => value.viewers)),
    providers: mergeProviders(values.map(({ value }) => value)),
    entries: scopedValues
      .flatMap(({ scoped }) => scoped.entries)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    errors: scopedValues.flatMap(({ scoped }) => scoped.errors),
    truncated: scopedValues.some(({ raw }) => raw.truncated),
    nextCursors: Object.assign({}, ...scopedValues.map(({ scoped }) => scoped.nextCursors)),
  };
}

const multiEnvironmentList = Atom.family((key: string) => {
  const { environmentIds, input } = JSON.parse(key) as MultiEnvironmentListKey;
  const atoms = environmentIds.flatMap((environmentId) => {
    const cursors = pullRequestCursorsForEnvironment(environmentId, input.cursors);
    // A continuation only asks environments named by a cursor. Re-reading an exhausted
    // environment from the top would append its first page again beside another server's next.
    if (input.cursors !== undefined && cursors === undefined) return [];
    return [
      {
        environmentId,
        atom: pullRequestEnvironment.list({
          environmentId,
          input: { ...input, ...(cursors === undefined ? {} : { cursors }) },
        }),
      },
    ];
  });
  return Atom.readable(
    (get) =>
      combineResults(
        atoms.map(({ environmentId, atom }) => ({ environmentId, result: get(atom) })),
        mergePullRequestLists,
      ),
    (refresh) => {
      for (const { atom } of atoms) refresh(atom);
    },
  ).pipe(Atom.withLabel(`web-pull-requests:multi-list:${key}`));
});

const multiEnvironmentStats = Atom.family((key: string) => {
  const { environmentIds, refs } = JSON.parse(key) as MultiEnvironmentStatsKey;
  const atoms = environmentIds.flatMap((environmentId) => {
    const environmentRefs = refs
      .filter((ref) => ref.environmentId === environmentId)
      .map(({ environmentId: _environmentId, ...ref }) => ref);
    return environmentRefs.length === 0
      ? []
      : [
          {
            environmentId,
            atom: pullRequestEnvironment.listStats({
              environmentId,
              input: { refs: environmentRefs },
            }),
          },
        ];
  });
  return Atom.readable(
    (get) =>
      combineResults(
        atoms.map(({ environmentId, atom }) => ({ environmentId, result: get(atom) })),
        (values): ScopedPullRequestListStatsResult => ({
          stats: values.flatMap(({ environmentId, value }) =>
            value.stats.map((stat) => ({ ...stat, environmentId })),
          ),
        }),
      ),
    (refresh) => {
      for (const { atom } of atoms) refresh(atom);
    },
  ).pipe(Atom.withLabel(`web-pull-requests:multi-stats:${key}`));
});

export const pullRequestsAcrossEnvironments = {
  list: (key: MultiEnvironmentListKey) =>
    key.environmentIds.length === 0 ? null : multiEnvironmentList(JSON.stringify(key)),
  listStats: (key: MultiEnvironmentStatsKey) =>
    key.environmentIds.length === 0 || key.refs.length === 0
      ? null
      : multiEnvironmentStats(JSON.stringify(key)),
};
