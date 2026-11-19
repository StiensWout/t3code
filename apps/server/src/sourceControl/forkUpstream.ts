import {
  type OrchestrationProjectShell,
  type ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  forkUpstreamPolicy,
  type ForkUpstreamPolicy,
  includesForkUpstream,
} from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

// A fork keeps its parent; an hour bounds how long a deleted or re-parented one lingers.
const PARENT_TTL = Duration.hours(1);
const KEY_SEPARATOR = "\0";

export const disabledPolicy = forkUpstreamPolicy(null);

interface ParentLookupInput {
  readonly project: OrchestrationProjectShell;
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
}

interface ForkListingRepository extends Omit<ParentLookupInput, "project"> {
  readonly key: string;
}

interface ParentLookupError {
  readonly projectId: ProjectId;
  readonly source: string;
  readonly projectTitle: string;
  readonly message: string;
}

interface ParentLookups<A> {
  readonly parents: ReadonlyArray<{ readonly candidate: A; readonly parent: string }>;
  readonly errors: ReadonlyArray<ParentLookupError>;
}

/**
 * What a listing page owes for failed parent lookups. A continuation cursor no listed repository
 * claims may belong to an upstream whose lookup failed: it is passed back unread, so the next page
 * retries the lookup, and the failures are reported only on a head or when they hold a cursor.
 */
export function heldUpstreamCursors(
  cursors: Readonly<Record<string, string>> | undefined,
  listedKeys: ReadonlySet<string>,
  errors: ReadonlyArray<ParentLookupError>,
): {
  readonly nextCursors: Record<string, string>;
  readonly errors: ReadonlyArray<ParentLookupError>;
} {
  if (cursors === undefined) return { nextCursors: {}, errors };
  if (errors.length === 0) return { nextCursors: {}, errors: [] };
  const nextCursors = Object.fromEntries(
    Object.entries(cursors).filter(([key]) => !listedKeys.has(key)),
  );
  return { nextCursors, errors: Object.keys(nextCursors).length === 0 ? [] : errors };
}

/** Resolves fork parents for listings without making the fork's own rows depend on the lookup. */
export class ForkUpstream extends Context.Service<
  ForkUpstream,
  {
    readonly readPolicy: Effect.Effect<ForkUpstreamPolicy>;
    readonly findParents: <A extends { readonly project: OrchestrationProjectShell }>(
      candidates: Iterable<A>,
      policy: ForkUpstreamPolicy,
      repositoryOf: (candidate: A) => ForkListingRepository | undefined,
      concurrency: number,
    ) => Effect.Effect<ParentLookups<A>>;
  }
>()("t3/sourceControl/forkUpstream") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const readPolicy = serverSettings.getSettings.pipe(
    Effect.map(forkUpstreamPolicy),
    Effect.orElseSucceed(() => disabledPolicy),
    Effect.withSpan("ForkUpstream.readPolicy"),
  );
  const parents = yield* Cache.makeWith(
    (key: string) => {
      const [kind = "", host = "", repository = "", cwd = ""] = key.split(KEY_SEPARATOR);
      return providers
        .get(SourceControlProviderKind.make(kind))
        .pipe(
          Effect.flatMap(
            (provider) =>
              provider.getRepositoryParent?.({ cwd, host, repository }) ?? Effect.succeed(null),
          ),
        );
    },
    {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PARENT_TTL : Duration.zero),
    },
  );

  const findParent = Effect.fn("ForkUpstream.findParent")(function* (input: ParentLookupInput) {
    const key = [input.kind, input.host, input.repository, input.project.workspaceRoot].join(
      KEY_SEPARATOR,
    );
    return yield* Cache.get(parents, key).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("The fork's upstream repository could not be read.", { cause }),
      ),
    );
  });

  const findParents = Effect.fn("ForkUpstream.findParents")(function* <
    A extends { readonly project: OrchestrationProjectShell },
  >(
    candidates: Iterable<A>,
    policy: ForkUpstreamPolicy,
    repositoryOf: (candidate: A) => ForkListingRepository | undefined,
    concurrency: number,
  ) {
    const forks = new Map<string, { candidate: A; repository: ForkListingRepository }>();
    for (const candidate of candidates) {
      if (!includesForkUpstream(policy, candidate.project.id)) continue;
      const repository = repositoryOf(candidate);
      if (repository !== undefined && !forks.has(repository.key)) {
        forks.set(repository.key, { candidate, repository });
      }
    }
    const lookups = yield* Effect.forEach(
      forks.values(),
      ({ candidate, repository }) =>
        findParent({ ...repository, project: candidate.project }).pipe(
          Effect.result,
          Effect.map((result) => ({ candidate, repository, result })),
        ),
      { concurrency },
    );
    const parents: Array<ParentLookups<A>["parents"][number]> = [];
    const errors: Array<ParentLookupError> = [];
    for (const { candidate, repository, result } of lookups) {
      if (result._tag === "Failure") {
        const detail = result.failure.detail.trim();
        errors.push({
          projectId: candidate.project.id,
          source: `parent:${repository.key}`,
          projectTitle: candidate.project.title,
          message: `The upstream of ${repository.repository} could not be read.${detail === "" ? "" : ` ${detail}`}`,
        });
      } else if (result.success !== null) {
        parents.push({ candidate, parent: result.success });
      }
    }
    return { parents, errors };
  });

  return ForkUpstream.of({ readPolicy, findParents });
});

export const layer = Layer.effect(ForkUpstream, make);
