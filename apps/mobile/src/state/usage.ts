/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * Mirror of `apps/web/src/state/usage.ts` over mobile's atom wiring; the merge
 * rules themselves live in `@t3tools/shared/usageMerge`.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type UsageProviderLimits,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`mobile-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsage(input: UsageSummaryInput): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so pull-to-refresh always rescans.
  //
  // Each environment refetches model pricing first, so a model released since
  // its last daily fetch gets priced by the rescan. The rescan runs whether or
  // not the refetch succeeds: an offline environment still recounts tokens.
  const refresh = useCallback(() => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    for (const environment of environments) {
      const { environmentId } = environment;
      const query = serverEnvironment.usageSummary({ environmentId, input });
      void runAtomCommand(
        appAtomRegistry,
        serverEnvironment.refreshUsageRates,
        { environmentId, input: {} },
        { reportFailure: false },
      ).finally(() => appAtomRegistry.refresh(query));
    }
  }, [environments, windowKey]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [environments]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}

/** One provider instance's limits, tagged with the environment that reported them. */
export interface EnvironmentProviderLimits extends UsageProviderLimits {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

interface EnvironmentLimitsStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly failed: boolean;
  readonly providers: readonly UsageProviderLimits[] | null;
}

/**
 * Every environment's live limits subscription. Subscribing makes the server
 * read fresh numbers first, so a refresh is a resubscribe.
 */
const usageLimitsAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentLimitsStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.usageLimits({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      failed: result._tag === "Failure",
      providers: snapshot?.providers ?? null,
    });
  }
  // Countdowns anchor to the moment a report lands rather than ticking.
  return { environments: statuses, receivedAt: Date.now() };
}).pipe(Atom.withLabel("mobile-usage:limits"));

export interface UsageLimitsView {
  readonly providers: readonly EnvironmentProviderLimits[];
  readonly failedEnvironments: readonly string[];
  /** Labels of environments that have not answered yet while others have. */
  readonly pendingEnvironments: readonly string[];
  /** True while any environment is re-reading after a refresh. */
  readonly isRefreshing: boolean;
  /** Wall-clock time of the latest report, for reset countdowns. */
  readonly receivedAt: number;
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useUsageLimits(): UsageLimitsView {
  const { environments, receivedAt } = useAtomValue(usageLimitsAtom);

  const providers = useMemo(
    () =>
      environments.flatMap((environment) =>
        (environment.providers ?? []).map((entry) => ({
          ...entry,
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
        })),
      ),
    [environments],
  );
  const failedEnvironments = useMemo(
    () => environments.filter((environment) => environment.failed).map((e) => e.label),
    [environments],
  );

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.usageLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  const pendingEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => environment.isPending && !environment.failed)
        .map((e) => e.label),
    [environments],
  );

  return {
    providers,
    failedEnvironments,
    pendingEnvironments,
    isRefreshing: environments.some(
      (environment) => environment.providers !== null && environment.isPending,
    ),
    receivedAt,
    isPending:
      environments.length > 0 &&
      environments.every((environment) => environment.providers === null) &&
      environments.some((environment) => environment.isPending),
    refresh,
  };
}
