import {
  PullRequestDiffStat,
  PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { persistQuery, type QueryPersistence } from "./queryPersistence.ts";

const requestKey = Schema.fromJsonString(Schema.Tuple([Schema.String, PullRequestListStatsInput]));
export const pullRequestStatKey = (
  ref: Pick<PullRequestRef, "host" | "repository" | "number"> & { readonly projectId: string },
) =>
  JSON.stringify([
    ref.projectId,
    ref.host?.toLowerCase(),
    ref.repository.toLowerCase(),
    ref.number,
  ]);

export function persistPullRequestStats(): QueryPersistence<PullRequestListStatsResult> {
  // Older caches could store a hostless answer under several different hosts.
  const statKey = (ref: PullRequestRef) => `pull-request-stat-v2:${pullRequestStatKey(ref)}`;
  const row = persistQuery(PullRequestDiffStat);
  return {
    load: Effect.fn("pullRequestStatsPersistence.load")(
      function* (environmentId, key) {
        const [, input] = yield* Schema.decodeEffect(requestKey)(key);
        const rows = yield* Effect.forEach(
          input.refs,
          (ref) => row.load(environmentId, statKey(ref)),
          { concurrency: "unbounded" },
        );
        const stats = rows.flatMap((value) => (Option.isSome(value) ? [value.value] : []));
        return stats.length ? Option.some({ stats }) : Option.none();
      },
      Effect.orElseSucceed(() => Option.none()),
    ),
    save: Effect.fn("pullRequestStatsPersistence.save")(
      function* (environmentId, key, result) {
        const [, input] = yield* Schema.decodeEffect(requestKey)(key);
        const keys = new Set(input.refs.map(statKey));
        yield* Effect.forEach(
          result.stats.filter((stat) => keys.has(statKey(stat))),
          (stat) => row.save(environmentId, statKey(stat), stat),
          { discard: true },
        );
      },
      (effect, _environmentId, _key, _result) => effect.pipe(Effect.ignore),
    ),
  };
}
