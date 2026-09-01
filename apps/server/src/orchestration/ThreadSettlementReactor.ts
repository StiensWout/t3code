import { CommandId, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  isAutoSettlementCandidate,
  shouldAutoSettleThread,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Resolves once the first sweep has applied every settlement it can decide
     * without the network: branchless threads and threads whose pull request
     * answer was persisted by an earlier sweep. Startup waits on this so the
     * first snapshot carries those decisions while pull request lookups keep
     * running in the background.
     */
    readonly ready: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

/**
 * The last pull request answer per lookup key, kept on disk so a restart can
 * settle threads before GitHub answers. Keys match the sweep's grouping key
 * (linked pull request, or workspace root plus branch).
 */
const PersistedLookups = Schema.Struct({
  version: Schema.Literal(1),
  lookups: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        state: Schema.Literals(["open", "closed", "merged"]),
        updatedAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});

const PersistedLookupsJson = Schema.fromJsonString(PersistedLookups);
const decodePersistedLookups = Schema.decodeUnknownEffect(PersistedLookupsJson);
const encodePersistedLookups = Schema.encodeEffect(PersistedLookupsJson);

const samePullRequest = (
  left: SettlementPullRequest | null,
  right: SettlementPullRequest | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.state === right.state &&
    left.updatedAt === right.updatedAt);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const { settlementLookupsPath } = yield* ServerConfig.ServerConfig;
  const ready = yield* Deferred.make<void>();
  const lookups = new Map<string, SettlementPullRequest | null>();

  const loadLookups = Effect.gen(function* () {
    if (!(yield* fs.exists(settlementLookupsPath))) return;
    const persisted = yield* fs
      .readFileString(settlementLookupsPath)
      .pipe(Effect.flatMap(decodePersistedLookups));
    for (const [key, pullRequest] of Object.entries(persisted.lookups)) {
      lookups.set(key, pullRequest);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("settlement lookups unavailable, starting without them", {
        path: settlementLookupsPath,
        cause,
      }),
    ),
  );

  const saveLookups = (retain: ReadonlySet<string>) =>
    Effect.gen(function* () {
      for (const key of lookups.keys()) {
        if (!retain.has(key)) lookups.delete(key);
      }
      const contents = yield* encodePersistedLookups({
        version: 1,
        lookups: Object.fromEntries(lookups),
      });
      yield* writeFileStringAtomically({
        filePath: settlementLookupsPath,
        contents: `${contents}\n`,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("settlement lookups not persisted", {
          path: settlementLookupsPath,
          cause,
        }),
      ),
    );

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now));
    type Thread = (typeof snapshot.threads)[number];
    const needsLookup = (thread: Thread) =>
      thread.linkedPullRequest != null || thread.branch !== null;
    const lookupKey = (thread: Thread) => {
      if (thread.linkedPullRequest != null) {
        return JSON.stringify([
          "linked",
          thread.linkedPullRequest.projectId,
          thread.linkedPullRequest.repository,
          thread.linkedPullRequest.number,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const project = projects.get(thread.projectId);
      return JSON.stringify(
        project === undefined
          ? ["missing-project", thread.id]
          : ["branch", project.workspaceRoot, thread.branch],
      );
    };
    const groups = Map.groupBy(candidates, lookupKey);
    const settled = new Set<ThreadId>();

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: Thread,
    ) {
      if (thread.linkedPullRequest != null) {
        if (!projects.has(thread.linkedPullRequest.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const detail = yield* pullRequests.detail({
          projectId: thread.linkedPullRequest.projectId,
          repository: thread.linkedPullRequest.repository,
          number: thread.linkedPullRequest.number,
        });
        return { state: detail.state, updatedAt: detail.updatedAt } satisfies SettlementPullRequest;
      }
      if (thread.branch === null) return null;
      const project = projects.get(thread.projectId);
      if (project === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      return yield* git.branchPullRequest({ cwd: project.workspaceRoot, branch: thread.branch });
    });

    const decideGroup = (group: ReadonlyArray<Thread>, pullRequest: SettlementPullRequest | null) =>
      Effect.forEach(
        group,
        (thread) =>
          Effect.gen(function* () {
            if (settled.has(thread.id)) return;
            const settings = yield* settingsService.getSettings;
            const decisionNow = DateTime.formatIso(yield* DateTime.now);
            if (
              !shouldAutoSettleThread({
                thread,
                pullRequest,
                now: decisionNow,
                autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
                autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
              })
            ) {
              return;
            }
            const uuid = yield* crypto.randomUUIDv4;
            yield* engine.dispatch({
              type: "thread.auto-settle",
              commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
              threadId: thread.id,
              snapshotSequence: snapshot.snapshotSequence,
            });
            settled.add(thread.id);
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("automatic thread settlement skipped", {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        { discard: true },
      );

    // Local phase: everything decidable without the network, so startup can
    // continue before any pull request lookup returns.
    for (const [key, group] of groups) {
      const pullRequest = needsLookup(group[0]!) ? lookups.get(key) : null;
      if (pullRequest === undefined) continue;
      yield* decideGroup(group, pullRequest);
    }
    yield* Deferred.succeed(ready, undefined);

    // Network phase: refresh every lookup and only re-decide groups whose
    // answer is new or changed since the local phase.
    let changed = false;
    yield* Effect.forEach(
      groups,
      ([key, group]) =>
        Effect.gen(function* () {
          if (!needsLookup(group[0]!)) return;
          const pullRequest = yield* pullRequestFor(group[0]!);
          const previous = lookups.get(key);
          lookups.set(key, pullRequest);
          if (previous !== undefined && samePullRequest(previous, pullRequest)) return;
          changed = true;
          yield* decideGroup(group, pullRequest);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );

    const retain = new Set(snapshot.threads.map(lookupKey));
    const stale = [...lookups.keys()].some((key) => !retain.has(key));
    if (changed || stale) yield* saveLookups(retain);
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
      // A sweep that dies before its local phase must not hold startup.
      Effect.ensuring(Deferred.succeed(ready, undefined)),
    ),
  );

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    yield* loadLookups;
    const settingsChanges = yield* settingsService.subscribeChanges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        return worker.enqueue(undefined);
      }),
    );
  });

  return {
    start,
    ready: Deferred.await(ready),
    drain: worker.drain,
  } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
