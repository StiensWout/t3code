import {
  type OrchestrationProjectShell,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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

export type ForkUpstreamPolicy = ReadonlyArray<ProjectId>;

interface ParentLookupInput {
  readonly project: OrchestrationProjectShell;
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly repository: string;
}

/** Resolves fork parents for listings without making the fork's own rows depend on the lookup. */
export class ForkUpstream extends Context.Service<
  ForkUpstream,
  {
    readonly readPolicy: <E>(
      projectIds: Effect.Effect<Iterable<ProjectId>, E>,
    ) => Effect.Effect<ForkUpstreamPolicy, E>;
    readonly findParent: (input: ParentLookupInput) => Effect.Effect<string | null>;
  }
>()("t3/sourceControl/forkUpstream") {}

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const readPolicy = Effect.fn("ForkUpstream.readPolicy")(function* <E>(
    projectIds: Effect.Effect<Iterable<ProjectId>, E>,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return [];
    const enabled = (projectId: ProjectId | null) =>
      resolveProjectSettings(settings, projectId).settings.includeForkUpstream;
    // Skip reading the project catalog when no project could be opted in.
    if (
      !enabled(null) &&
      !Object.keys(settings.projectSettingsOverrides).some((id) => enabled(ProjectId.make(id)))
    ) {
      return [];
    }
    return [...new Set(yield* projectIds)].filter(enabled).sort();
  });
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
      Effect.orElseSucceed(() => null),
    );
  });

  return ForkUpstream.of({ readPolicy, findParent });
});

export const layer = Layer.effect(ForkUpstream, make);
