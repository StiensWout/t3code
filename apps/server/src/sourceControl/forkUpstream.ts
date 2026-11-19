import {
  type OrchestrationProjectShell,
  type ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

// A fork keeps its parent; an hour bounds how long a deleted or re-parented one lingers.
const PARENT_TTL = Duration.hours(1);
const KEY_SEPARATOR = "\0";

export type ForkUpstreamPolicy = readonly [
  enabledByDefault: boolean,
  exceptions: ReadonlyArray<string>,
];

export function includesForkUpstream(policy: ForkUpstreamPolicy | null, projectId: ProjectId) {
  return policy !== null && policy[0] !== policy[1].includes(projectId);
}

/** Resolves fork parents for listings without making the fork's own rows depend on the lookup. */
export const makeForkUpstreamLookup = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  // A stable, settings-only key lets cached listings use the same policy they were keyed on.
  const readPolicy = serverSettings.getSettings.pipe(
    Effect.map((settings): ForkUpstreamPolicy => {
      const enabledByDefault = settings.includeForkUpstream;
      const exceptions = Object.entries(settings.projectSettingsOverrides)
        .filter(
          ([, overrides]) =>
            overrides.includeForkUpstream !== undefined &&
            overrides.includeForkUpstream !== enabledByDefault,
        )
        .map(([projectId]) => projectId)
        .sort();
      return [enabledByDefault, exceptions];
    }),
    Effect.orElseSucceed((): ForkUpstreamPolicy => [false, []]),
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

  const findParent = Effect.fn("ForkUpstream.lookup")(function* (input: {
    readonly project: OrchestrationProjectShell;
    readonly kind: SourceControlProviderKind;
    readonly host: string;
    readonly repository: string;
  }) {
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

  return { readPolicy, findParent };
});
