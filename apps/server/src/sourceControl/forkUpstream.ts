import { type OrchestrationProjectShell, SourceControlProviderKind } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

// A fork keeps its parent; an hour bounds how long a deleted or re-parented one lingers.
const PARENT_TTL = Duration.hours(1);
const KEY_SEPARATOR = "\0";

/**
 * Builds the lookup of the repository a project's fork was made from, which pull request and
 * issue listings read beside the fork when the project's `includeForkUpstream` setting is on.
 * Null when the setting is off, for a repository that is no fork, and when the host does not say
 * or cannot be read: the fork's own listing goes on without it.
 */
export const makeForkUpstreamLookup = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
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

  return Effect.fn("ForkUpstream.lookup")(function* (input: {
    readonly project: OrchestrationProjectShell;
    readonly kind: SourceControlProviderKind;
    readonly host: string;
    readonly repository: string;
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (
      settings === null ||
      !resolveProjectSettings(settings, input.project.id).settings.includeForkUpstream
    ) {
      return null;
    }
    const key = [
      input.kind,
      input.host,
      input.repository.toLowerCase(),
      input.project.workspaceRoot,
    ].join(KEY_SEPARATOR);
    const parent = yield* Cache.get(parents, key).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("The fork's upstream repository could not be read.", { cause }),
      ),
      Effect.orElseSucceed(() => null),
    );
    return parent !== null && parent.toLowerCase() !== input.repository.toLowerCase()
      ? parent
      : null;
  });
});
