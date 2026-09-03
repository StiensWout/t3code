/**
 * UsageLimitsService - latest account limits per provider instance.
 *
 * Limits are account state, not thread history, so nothing is persisted: the
 * service folds `account.rate-limits.updated` runtime events into an in-memory
 * snapshot and asks adapters that can answer on demand (Codex) for a fresh
 * read whenever a client subscribes.
 *
 * @module UsageLimitsService
 */
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type UsageLimitsConsumeResetInput,
  type UsageLimitsConsumeResetOutcome,
  type UsageLimitsConsumeResetResult,
  UsageLimitsError,
  type UsageLimitsSnapshot,
  type UsageLimitsUpdate,
  type UsageProviderKind,
  type UsageProviderLimits,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../provider/Errors.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  type SnapshotSubscription,
  subscribeBeforeSnapshotWithoutMutex,
} from "../utils/subscribeBeforeSnapshot.ts";

export class UsageLimitsService extends Context.Service<
  UsageLimitsService,
  {
    /** Fresh read, then the latest snapshot plus every later change. */
    readonly subscribe: Effect.Effect<
      SnapshotSubscription<UsageLimitsSnapshot>,
      never,
      Scope.Scope
    >;
    /** Ask every adapter that can answer for its current limits. Never fails. */
    readonly refresh: Effect.Effect<void>;
    readonly consumeReset: (
      input: UsageLimitsConsumeResetInput,
    ) => Effect.Effect<UsageLimitsConsumeResetResult, UsageLimitsError>;
  }
>()("t3/usage/UsageLimitsService") {}

/** Adapter surface the service needs; the registry hands back full adapters. */
export interface UsageLimitsAdapter {
  readonly provider: ProviderDriverKind;
  readonly readAccountLimits?: Effect.Effect<UsageLimitsUpdate | null, ProviderAdapterError>;
  readonly consumeRateLimitResetCredit?: Effect.Effect<
    UsageLimitsConsumeResetOutcome,
    ProviderAdapterError
  >;
}

export interface UsageLimitsSources {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly getAdapter: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<UsageLimitsAdapter, UsageLimitsError>;
  /** Configured display name for an instance, null when it has none. */
  readonly getInstanceLabel: (instanceId: ProviderInstanceId) => Effect.Effect<string | null>;
}

/** Only subscription providers report limits; everything else is ignored. */
function usageProviderFor(driver: ProviderDriverKind): UsageProviderKind | null {
  switch (driver) {
    case "codex":
      return "codex";
    case "claudeAgent":
      return "claude";
    default:
      return null;
  }
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const make = Effect.fn("UsageLimitsService.make")(function* (sources: UsageLimitsSources) {
  const state = yield* Ref.make(new Map<ProviderInstanceId, UsageProviderLimits>());
  /** When each window last changed, so a slow read cannot undo a newer event. */
  const windowStamps = yield* Ref.make(new Map<string, number>());
  const stampKey = (instanceId: ProviderInstanceId, windowId: string) =>
    `${instanceId}:${windowId}`;
  const changes = yield* PubSub.sliding<UsageLimitsSnapshot>(8);

  const snapshot: Effect.Effect<UsageLimitsSnapshot> = Ref.get(state).pipe(
    Effect.map((map) => ({
      providers: Array.from(map.values()).toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.instanceId.localeCompare(right.instanceId),
      ),
    })),
  );

  /**
   * Merge a sparse update into one instance's limits and publish the result.
   * `since` is when a read began: windows that an event touched after that
   * moment keep the event's newer numbers.
   */
  const apply = Effect.fn("UsageLimitsService.apply")(function* (
    instanceId: ProviderInstanceId,
    provider: UsageProviderKind,
    update: UsageLimitsUpdate,
    since: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const instanceLabel = yield* sources.getInstanceLabel(instanceId);
    const stamps = yield* Ref.get(windowStamps);
    const fresh = update.windows.filter(
      (window) => (stamps.get(stampKey(instanceId, window.id)) ?? 0) <= since,
    );
    yield* Ref.update(windowStamps, (map) => {
      const next = new Map(map);
      for (const window of fresh) next.set(stampKey(instanceId, window.id), nowMs);
      return next;
    });
    yield* Ref.update(state, (map) => {
      const previous = map.get(instanceId);
      const windows = new Map((previous?.windows ?? []).map((window) => [window.id, window]));
      for (const window of fresh) windows.set(window.id, window);
      const next = new Map(map);
      next.set(instanceId, {
        provider,
        instanceId,
        instanceLabel,
        plan: update.plan === undefined ? (previous?.plan ?? null) : update.plan,
        windows: Array.from(windows.values()),
        resetCredits:
          update.resetCredits === undefined
            ? (previous?.resetCredits ?? null)
            : update.resetCredits,
        observedAt,
      });
      return next;
    });
    yield* PubSub.publish(changes, yield* snapshot);
  });

  const refreshInstance = Effect.fn("UsageLimitsService.refreshInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const adapter = yield* sources.getAdapter(instanceId);
    const provider = usageProviderFor(adapter.provider);
    if (provider === null || adapter.readAccountLimits === undefined) return;
    const startedAt = yield* Clock.currentTimeMillis;
    const update = yield* adapter.readAccountLimits;
    if (update === null) return;
    yield* apply(instanceId, provider, update, startedAt);
  });

  const refresh: UsageLimitsService["Service"]["refresh"] = Effect.gen(function* () {
    const instances = yield* sources.listInstances;
    // Instances removed from settings take their limits with them.
    const live = new Set(instances);
    const pruned = yield* Ref.modify(state, (map) => {
      const next = new Map([...map].filter(([instanceId]) => live.has(instanceId)));
      return [next.size !== map.size, next] as const;
    });
    if (pruned) {
      yield* Ref.update(windowStamps, (map) => {
        const next = new Map(map);
        for (const key of next.keys()) {
          if (!live.has(key.slice(0, key.indexOf(":")) as ProviderInstanceId)) next.delete(key);
        }
        return next;
      });
      yield* PubSub.publish(changes, yield* snapshot);
    }
    yield* Effect.forEach(
      instances,
      (instanceId) =>
        refreshInstance(instanceId).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("usage limits refresh skipped", {
              instanceId,
              detail: errorDetail(cause),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  yield* Stream.runForEach(sources.streamEvents, (event) => {
    if (event.type !== "account.rate-limits.updated" || event.providerInstanceId === undefined) {
      return Effect.void;
    }
    const provider = usageProviderFor(event.provider);
    if (provider === null) return Effect.void;
    const instanceId = event.providerInstanceId;
    return Effect.gen(function* () {
      // A session outliving its instance's removal must not resurrect it.
      const live = yield* sources.listInstances;
      if (!live.includes(instanceId)) return;
      yield* apply(instanceId, provider, event.payload.limits, Number.POSITIVE_INFINITY);
    });
  }).pipe(Effect.forkScoped);

  const subscribe: UsageLimitsService["Service"]["subscribe"] = Effect.gen(function* () {
    // Read first so the initial snapshot already carries fresh numbers and a
    // client never mistakes the boot-time empty map for "nothing reported".
    yield* refresh;
    return yield* subscribeBeforeSnapshotWithoutMutex(changes, snapshot);
  });

  const consumeReset: UsageLimitsService["Service"]["consumeReset"] = Effect.fn(
    "UsageLimitsService.consumeReset",
  )(function* (input) {
    const adapter = yield* sources.getAdapter(input.instanceId);
    const consume = adapter.consumeRateLimitResetCredit;
    if (consume === undefined) {
      return yield* new UsageLimitsError({
        reason: "unsupported",
        detail: `Provider '${adapter.provider}' does not bank reset credits.`,
      });
    }
    const outcome = yield* consume.pipe(
      Effect.mapError(
        (cause) =>
          new UsageLimitsError({
            reason: "requestFailed",
            detail: `Provider '${adapter.provider}' could not redeem the reset credit.`,
            cause,
          }),
      ),
    );
    yield* refresh;
    return { outcome };
  });

  return { subscribe, refresh, consumeReset } satisfies UsageLimitsService["Service"];
});

export const layer = Layer.effect(
  UsageLimitsService,
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const registry = yield* ProviderAdapterRegistry;
    return yield* make({
      streamEvents: providerService.streamEvents,
      listInstances: registry.listInstances(),
      getInstanceLabel: (instanceId) =>
        registry.getInstanceInfo(instanceId).pipe(
          Effect.map((info) => info.displayName?.trim() || null),
          Effect.orElseSucceed(() => null),
        ),
      getAdapter: (instanceId) =>
        registry.getByInstance(instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new UsageLimitsError({
                reason: "requestFailed",
                detail: `Provider instance '${instanceId}' is not available.`,
                cause,
              }),
          ),
        ),
    });
  }),
);

/** No adapters and no events: the snapshot stays empty. */
export const layerTest = Layer.effect(
  UsageLimitsService,
  make({
    streamEvents: Stream.empty,
    listInstances: Effect.succeed([]),
    getInstanceLabel: () => Effect.succeed(null),
    getAdapter: () => Effect.die("UsageLimitsService.layerTest has no adapters"),
  }),
);
