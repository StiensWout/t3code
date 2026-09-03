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
  /** Stable key for the account an instance points at; changes when its home is reconfigured. */
  readonly getInstanceIdentity: (instanceId: ProviderInstanceId) => Effect.Effect<string | null>;
  /** Fires whenever instances are added, removed, or rebuilt. */
  readonly instanceChanges: Stream.Stream<void>;
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

/** Stamp keys for the account-level fields, beside the window ids. */
const PLAN_STAMP = "$plan";
const CREDITS_STAMP = "$resetCredits";

interface InstanceState {
  readonly limits: UsageProviderLimits;
  /** Continuation identity at the time of the last write; a change means another account. */
  readonly identity: string | null;
  /** Window id → millis of the last change, so a slow read cannot undo a newer event. */
  readonly stamps: ReadonlyMap<string, number>;
}

export const make = Effect.fn("UsageLimitsService.make")(function* (sources: UsageLimitsSources) {
  /** Limits per instance plus when each window last changed, in one Ref so checks and writes are atomic. */
  const state = yield* Ref.make(new Map<ProviderInstanceId, InstanceState>());
  const changes = yield* PubSub.sliding<UsageLimitsSnapshot>(8);

  const snapshot: Effect.Effect<UsageLimitsSnapshot> = Ref.get(state).pipe(
    Effect.map((map) => ({
      providers: Array.from(map.values(), (entry) => entry.limits).toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.instanceId.localeCompare(right.instanceId),
      ),
    })),
  );

  /**
   * Merge a sparse update into one instance's limits and publish the result.
   * `since` is when a read began: windows that an event touched after that
   * moment keep the event's newer numbers. The stamp check and the write are
   * one `Ref.update`, so concurrent applies cannot interleave between them.
   */
  const apply = Effect.fn("UsageLimitsService.apply")(function* (
    instanceId: ProviderInstanceId,
    provider: UsageProviderKind,
    update: UsageLimitsUpdate,
    since: number,
    /** The account the numbers belong to, captured by the caller before its own yields. */
    identity: string | null,
  ) {
    const instanceLabel = yield* sources.getInstanceLabel(instanceId);
    // Stamp right before the write, after the last yield, so a read that
    // started while the label lookup ran still counts as older than this.
    const nowMs = yield* Clock.currentTimeMillis;
    const observedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    yield* Ref.update(state, (map) => {
      // An instance re-pointed at another provider or account starts from a clean slate.
      const stored = map.get(instanceId);
      const previous =
        stored?.limits.provider === provider && stored.identity === identity ? stored : undefined;
      const isFresh = (key: string) => (previous?.stamps.get(key) ?? 0) <= since;
      const fresh = update.windows.filter((window) => isFresh(window.id));
      const plan = update.plan !== undefined && isFresh(PLAN_STAMP);
      const credits = update.resetCredits !== undefined && isFresh(CREDITS_STAMP);
      const windows = new Map(
        (previous?.limits.windows ?? []).map((window) => [window.id, window]),
      );
      const stamps = new Map(previous?.stamps ?? []);
      if (update.complete) {
        // A full account snapshot: windows it no longer lists are gone,
        // unless an event refreshed them after this read began.
        const listed = new Set(update.windows.map((window) => window.id));
        for (const id of windows.keys()) {
          if (!listed.has(id) && isFresh(id)) {
            windows.delete(id);
            stamps.delete(id);
          }
        }
      }
      for (const window of fresh) {
        windows.set(window.id, window);
        stamps.set(window.id, nowMs);
      }
      if (plan) stamps.set(PLAN_STAMP, nowMs);
      if (credits) stamps.set(CREDITS_STAMP, nowMs);
      const next = new Map(map);
      next.set(instanceId, {
        limits: {
          provider,
          instanceId,
          instanceLabel,
          plan: plan ? (update.plan ?? null) : (previous?.limits.plan ?? null),
          windows: Array.from(windows.values()),
          resetCredits: credits
            ? (update.resetCredits ?? null)
            : (previous?.limits.resetCredits ?? null),
          observedAt,
          readError: null,
        },
        stamps,
        identity,
      });
      return next;
    });
    yield* PubSub.publish(changes, yield* snapshot);
  });

  /**
   * A failed on-demand read is visible: the entry keeps its last good numbers
   * and carries the failure, or exists only to carry it when nothing was read yet.
   */
  const recordReadError = Effect.fn("UsageLimitsService.recordReadError")(function* (
    instanceId: ProviderInstanceId,
    provider: UsageProviderKind,
    identity: string | null,
    detail: string,
  ) {
    const instanceLabel = yield* sources.getInstanceLabel(instanceId);
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(state, (map) => {
      const stored = map.get(instanceId);
      const previous =
        stored?.limits.provider === provider && stored.identity === identity ? stored : undefined;
      const next = new Map(map);
      next.set(instanceId, {
        limits: previous
          ? { ...previous.limits, readError: detail }
          : {
              provider,
              instanceId,
              instanceLabel,
              plan: null,
              windows: [],
              resetCredits: null,
              observedAt,
              readError: detail,
            },
        stamps: previous?.stamps ?? new Map(),
        identity,
      });
      return next;
    });
    yield* PubSub.publish(changes, yield* snapshot);
  });

  /** The provider an instance currently resolves to, or null when it is gone or has no limits. */
  const currentProvider = (instanceId: ProviderInstanceId) =>
    sources.getAdapter(instanceId).pipe(
      Effect.flatMap((adapter) =>
        Effect.map(sources.listInstances, (live) =>
          live.includes(instanceId) ? usageProviderFor(adapter.provider) : null,
        ),
      ),
      Effect.orElseSucceed(() => null),
    );

  const refreshInstance = Effect.fn("UsageLimitsService.refreshInstance")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const adapter = yield* sources.getAdapter(instanceId);
    const provider = usageProviderFor(adapter.provider);
    // Re-pointed at another provider, account, or one without limits: whatever
    // was there goes, even if the new configuration has nothing to say yet.
    const identity = yield* sources.getInstanceIdentity(instanceId);
    const dropped = yield* Ref.modify(state, (map) => {
      const stored = map.get(instanceId);
      if (
        stored === undefined ||
        (stored.limits.provider === provider && stored.identity === identity)
      ) {
        return [false, map] as const;
      }
      const next = new Map(map);
      next.delete(instanceId);
      return [true, next] as const;
    });
    if (dropped) yield* PubSub.publish(changes, yield* snapshot);
    if (provider === null || adapter.readAccountLimits === undefined) return;
    const startedAt = yield* Clock.currentTimeMillis;
    const read = yield* Effect.result(adapter.readAccountLimits);
    // The instance may have been removed or re-pointed at another provider
    // or account while the read ran; the result would belong to the old one.
    const current = yield* currentProvider(instanceId);
    const identityNow = yield* sources.getInstanceIdentity(instanceId);
    if (current !== provider || identityNow !== identity) return;
    if (read._tag === "Failure") {
      yield* recordReadError(instanceId, provider, identity, read.failure.message);
      return;
    }
    if (read.success === null) return;
    // Filed under the identity the read was made for: if the instance is
    // re-pointed after this point, the next refresh drops the entry.
    yield* apply(instanceId, provider, read.success, startedAt, identity);
  });

  const refresh: UsageLimitsService["Service"]["refresh"] = Effect.gen(function* () {
    const instances = yield* sources.listInstances;
    // Instances removed from settings take their limits with them.
    const live = new Set(instances);
    const pruned = yield* Ref.modify(state, (map) => {
      const next = new Map([...map].filter(([instanceId]) => live.has(instanceId)));
      return [next.size !== map.size, next] as const;
    });
    if (pruned) yield* PubSub.publish(changes, yield* snapshot);
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
      // A session outliving its instance's removal or re-pointing must not
      // resurrect the old provider's numbers.
      const current = yield* currentProvider(instanceId);
      if (current !== provider) return;
      const identity = yield* sources.getInstanceIdentity(instanceId);
      yield* apply(instanceId, provider, event.payload.limits, Number.POSITIVE_INFINITY, identity);
    });
  }).pipe(Effect.forkScoped);

  // Settings edits that add, remove, or rebuild an instance re-read straight
  // away, so a removed provider leaves the snapshot without waiting for a client.
  yield* Stream.runForEach(sources.instanceChanges, () => refresh).pipe(Effect.forkScoped);

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
    const instanceChanges = yield* registry.subscribeChanges;
    return yield* make({
      streamEvents: providerService.streamEvents,
      instanceChanges: Stream.fromSubscription(instanceChanges),
      listInstances: registry.listInstances(),
      getInstanceLabel: (instanceId) =>
        registry.getInstanceInfo(instanceId).pipe(
          Effect.map((info) => info.displayName?.trim() || null),
          Effect.orElseSucceed(() => null),
        ),
      getInstanceIdentity: (instanceId) =>
        registry.getInstanceInfo(instanceId).pipe(
          Effect.map((info) => info.continuationIdentity.continuationKey),
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
    instanceChanges: Stream.empty,
    listInstances: Effect.succeed([]),
    getInstanceLabel: () => Effect.succeed(null),
    getInstanceIdentity: () => Effect.succeed(null),
    getAdapter: () => Effect.die("UsageLimitsService.layerTest has no adapters"),
  }),
);
