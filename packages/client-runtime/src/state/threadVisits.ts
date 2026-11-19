// @effect-diagnostics globalTimers:off globalDate:off - The tracker runs in atom subscriptions, outside an Effect runtime.
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "./entities.ts";
import { type AtomCommand, runAtomCommand } from "./runtime.ts";
import { claimThreadOpen, claimThreadOpenOnRelease, releaseThreadOpen } from "./threadSearch.ts";
import type { VisitThreadInput } from "../operations/commands.ts";

// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers.
export const VISIT_DISPATCH_THROTTLE_MS = 10_000;

const IDLE_TRACKER: Atom.Atom<void> = Atom.make(undefined).pipe(
  Atom.withLabel("thread-visit-tracker:idle"),
);

interface VisitedShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly lastVisitedAt?: string | null | undefined;
  readonly latestRun: { readonly completedAt: string | null } | null;
  /**
   * When a scheduled wake the user is looking at took effect. A wake later
   * than `updatedAt` is an update the server never sent, so the watermark
   * advances to it, and at once: leaving within the throttle would cancel
   * the dispatch and keep the thread marked Woke.
   */
  readonly wokeAt?: string | null | undefined;
}

export interface ThreadVisitTrackerOptions {
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<VisitedShell | null>;
  readonly sessionGenerationAtom: (environmentId: EnvironmentId) => Atom.Atom<number>;
  readonly visit: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: VisitThreadInput },
    unknown,
    unknown
  >;
  /**
   * Servers without visit tracking leave `lastVisitedAt` undefined; a client
   * that keeps its own watermark for them records the visit here instead.
   */
  readonly markLocalVisit?: (ref: ScopedThreadRef, visitedAt: string) => void;
}

/**
 * While mounted, a tracker counts as the user viewing the thread: mounting it
 * records one open (which also feeds search ranking), and every shell update
 * after that advances the visit watermark, throttled while a run streams.
 */
export function createThreadVisitTracker(options: ThreadVisitTrackerOptions) {
  const family = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const registry = get.registry;
      // Showing the thread is the open, whether or not its shell has arrived;
      // the shell only decides when the server hears about it.
      // Record it locally even when the server cannot take opens.
      const openedAt = Date.now();
      let pendingOpen: { failedAttempt?: { at: number; generation: number } } | null =
        claimThreadOpen(ref.environmentId, ref.threadId, openedAt) ? {} : null;
      const releaseOpen = () => releaseThreadOpen(ref.environmentId, ref.threadId, openedAt);
      // Dedupe per watermark: the shell updates again before the command's echo
      // lands. It also keeps a mark-unread on the open thread sticky, since the
      // rewind leaves updatedAt untouched.
      let lastDispatchedUpdatedAt: string | null = null;
      let lastAcceptedVisitedAtMs = Number.NEGATIVE_INFINITY;
      let lastObservedVisitedAtMs = Number.NEGATIVE_INFINITY;
      let retryPending = false;
      const sessionGenerationAtom = options.sessionGenerationAtom(ref.environmentId);
      let lastDispatch = { at: 0, generation: registry.get(sessionGenerationAtom) };
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
      };
      get.addFinalizer(() => {
        active = false;
        clearTimer();
        if (pendingOpen !== null) releaseOpen();
      });

      const dispatch = (shell: VisitedShell, visitedAt: string, opened: boolean) => {
        clearTimer();
        retryPending = false;
        lastDispatchedUpdatedAt = visitedAt;
        const attempt = { at: Date.now(), generation: registry.get(sessionGenerationAtom) };
        lastDispatch = attempt;
        void runAtomCommand(
          registry,
          options.visit,
          {
            environmentId: shell.environmentId,
            input: {
              threadId: shell.id,
              visitedAt,
              ...(opened ? { opened: true } : {}),
            },
          },
          { reportFailure: false },
        ).then((result) => {
          if (!active) {
            if (opened && AsyncResult.isFailure(result)) releaseOpen();
            return;
          }
          const visitedAtMs = Date.parse(visitedAt);
          if (!AsyncResult.isFailure(result)) {
            lastAcceptedVisitedAtMs = Math.max(lastAcceptedVisitedAtMs, visitedAtMs);
            return;
          }
          // Keep acceptance across a subsequent mark-unread, even if the ack was lost.
          if (lastDispatch === attempt && lastAcceptedVisitedAtMs < visitedAtMs) {
            retryPending = true;
          }
          if (opened) pendingOpen = { failedAttempt: attempt };
          if (opened || retryPending) onShell(registry.get(options.threadShellAtom(ref)));
        });
      };

      const onShell = (shell: VisitedShell | null) => {
        clearTimer();
        if (shell === null) return;

        const shellUpdatedAtMs = Date.parse(shell.updatedAt);
        if (Number.isNaN(shellUpdatedAtMs)) return;
        const wokeAtMs = shell.wokeAt ? Date.parse(shell.wokeAt) : NaN;
        const wakeIsLatest = wokeAtMs > shellUpdatedAtMs;
        const visitedAt = wakeIsLatest && shell.wokeAt ? shell.wokeAt : shell.updatedAt;
        const updatedAtMs = wakeIsLatest ? wokeAtMs : shellUpdatedAtMs;
        if (shell.lastVisitedAt === undefined) {
          options.markLocalVisit?.(ref, visitedAt);
          return;
        }
        const lastVisitedAtMs = shell.lastVisitedAt ? Date.parse(shell.lastVisitedAt) : NaN;
        if (!Number.isNaN(lastVisitedAtMs)) {
          lastAcceptedVisitedAtMs = Math.max(lastAcceptedVisitedAtMs, lastVisitedAtMs);
          lastObservedVisitedAtMs = Math.max(lastObservedVisitedAtMs, lastVisitedAtMs);
        }
        if (
          retryPending &&
          lastDispatchedUpdatedAt !== null &&
          lastAcceptedVisitedAtMs >= Date.parse(lastDispatchedUpdatedAt)
        ) {
          retryPending = false;
        }
        // A rejected visit waits for a new session, even if streaming changes the shell.
        const retry = pendingOpen?.failedAttempt ?? (retryPending ? lastDispatch : undefined);
        if (retry && registry.get(sessionGenerationAtom) === retry.generation) return;
        const now = Date.now();
        if (retry && now - retry.at < VISIT_DISPATCH_THROTTLE_MS) {
          timer = setTimeout(
            () => onShell(registry.get(options.threadShellAtom(ref))),
            VISIT_DISPATCH_THROTTLE_MS - (now - retry.at),
          );
          return;
        }
        const elapsed = now - lastDispatch.at;
        // The open rides on the first visit the server hears, however late
        // the shell arrives, so it still counts toward search ranking.
        if (pendingOpen !== null) {
          // A plain visit's ack can precede its shell update during a handoff.
          // Only a rewind of the observed watermark should suppress that open.
          const previousVisitAtMs = pendingOpen.failedAttempt
            ? lastAcceptedVisitedAtMs
            : lastObservedVisitedAtMs;
          const rewound = previousVisitAtMs >= updatedAtMs && !(lastVisitedAtMs >= updatedAtMs);
          pendingOpen = null;
          if (!rewound) {
            dispatch(shell, visitedAt, true);
            return;
          }
          releaseOpen();
        }
        if (!Number.isNaN(lastVisitedAtMs) && lastVisitedAtMs >= updatedAtMs) {
          // Already seen, so a later mark-unread stays sticky even when no open was sent.
          if (lastDispatchedUpdatedAt === null || Date.parse(lastDispatchedUpdatedAt) < updatedAtMs)
            lastDispatchedUpdatedAt = visitedAt;
          return;
        }
        if (
          !retryPending &&
          lastDispatchedUpdatedAt !== null &&
          Date.parse(lastDispatchedUpdatedAt) >= updatedAtMs
        )
          return;

        const completedAtMs = shell.latestRun?.completedAt
          ? Date.parse(shell.latestRun.completedAt)
          : NaN;
        const hasUnseenCompletion =
          !Number.isNaN(completedAtMs) &&
          (Number.isNaN(lastVisitedAtMs) || completedAtMs > lastVisitedAtMs);
        if (hasUnseenCompletion || wakeIsLatest || elapsed >= VISIT_DISPATCH_THROTTLE_MS) {
          dispatch(shell, visitedAt, false);
          return;
        }
        timer = setTimeout(
          () => dispatch(shell, visitedAt, false),
          VISIT_DISPATCH_THROTTLE_MS - elapsed,
        );
      };

      if (pendingOpen === null) {
        get.addFinalizer(
          claimThreadOpenOnRelease(ref.environmentId, ref.threadId, openedAt, () => {
            pendingOpen = {};
            onShell(registry.get(options.threadShellAtom(ref)));
          }),
        );
      }
      // `subscribe`, not `get`: a rebuild would reset the open and throttle
      // state on every streaming tick.
      get.subscribe(options.threadShellAtom(ref), onShell, { immediate: true });
      get.subscribe(sessionGenerationAtom, () =>
        onShell(registry.get(options.threadShellAtom(ref))),
      );
    }).pipe(Atom.withLabel(`thread-visit-tracker:${key}`));
  });
  return (ref: ScopedThreadRef | null) => (ref === null ? IDLE_TRACKER : family(threadKey(ref)));
}
