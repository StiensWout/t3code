// @effect-diagnostics globalTimers:off globalDate:off - The tracker runs in atom subscriptions, outside an Effect runtime.
import type { CommandId, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { pickedQuery } from "@t3tools/shared/paletteSearch";
import { AsyncResult, Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "./entities.ts";
import { type AtomCommand, runAtomCommand } from "./runtime.ts";
import { claimThreadOpen, releaseThreadOpen, threadSearchPickAtom } from "./threadSearch.ts";
import type { VisitThreadInput } from "../operations/commands.ts";

// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers.
export const VISIT_DISPATCH_THROTTLE_MS = 10_000;

const IDLE_TRACKER: Atom.Atom<void> = Atom.make(undefined).pipe(
  Atom.withLabel("thread-visit-tracker:idle"),
);

interface VisitedShell {
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
  /** The current session once its shell has caught up, or null while offline or synchronizing. */
  readonly liveSessionAtom: (environmentId: EnvironmentId) => Atom.Atom<object | null>;
  readonly newCommandId: () => CommandId;
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

interface VisitInputs {
  readonly shell: VisitedShell | null;
  readonly session: object | null;
  readonly pick: string | null;
}

interface VisitAttempt {
  readonly at: number;
  readonly session: object;
  readonly visitedAtMs: number;
  failed: boolean;
}

interface OpenIntent {
  readonly claim: number | null;
  readonly commandId: CommandId;
  readonly pick: string | null;
}

type PendingOpen =
  | { readonly status: "pending"; readonly claim: number }
  | {
      readonly status: "failed";
      readonly intent: OpenIntent;
      readonly session: object;
      readonly visitedAt: string;
    };

/**
 * While mounted, records an open for search ranking and keeps the read
 * watermark current, throttling ordinary visits while a run streams.
 */
export function createThreadVisitTracker(options: ThreadVisitTrackerOptions) {
  const family = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    const pickAtom = threadSearchPickAtom(ref);
    const inputsAtom = Atom.make((get): VisitInputs => ({
      shell: get(options.threadShellAtom(ref)),
      session: get(options.liveSessionAtom(ref.environmentId)),
      pick: get(pickAtom),
    }));
    let inFlightOpen: Promise<void> | null = null;

    return Atom.make((get) => {
      const registry = get.registry;
      const openedAt = Date.now();
      const claimOpen = (at: number) =>
        claimThreadOpen(ref.environmentId, ref.threadId, at) ? at : null;
      const releaseOpen = (claim: number | null) => {
        if (claim !== null) releaseThreadOpen(ref.environmentId, ref.threadId, claim);
      };
      const abandonOpen = (intent: OpenIntent) => {
        releaseOpen(intent.claim);
        // Restore the pick only while its slot still exists and no newer pick is waiting.
        if (
          intent.pick !== null &&
          registry.getNodes().has(pickAtom) &&
          registry.get(pickAtom) === null
        ) {
          registry.set(pickAtom, intent.pick);
        }
      };
      const claim = claimOpen(openedAt);
      let open: PendingOpen | null = claim === null ? null : { status: "pending", claim };
      let lastVisit: VisitAttempt | null = null;
      let acceptedThrough = Number.NEGATIVE_INFINITY;
      let observedThrough = Number.NEGATIVE_INFINITY;
      let observedReadActivityThrough = Number.NEGATIVE_INFINITY;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => {
        clearTimeout(timer);
        timer = undefined;
      };
      get.addFinalizer(() => {
        active = false;
        clearTimer();
        if (open?.status === "pending") releaseOpen(open.claim);
        if (open?.status === "failed") abandonOpen(open.intent);
      });

      const visit = (session: object, visitedAt: string, intent?: OpenIntent) => {
        const searchQuery = intent?.pick ? pickedQuery(intent.pick) : null;
        const attempt: VisitAttempt = {
          at: Date.now(),
          session,
          visitedAtMs: Date.parse(visitedAt),
          failed: false,
        };
        if (
          !intent ||
          lastVisit === null ||
          lastVisit.session !== session ||
          attempt.visitedAtMs >= lastVisit.visitedAtMs
        ) {
          lastVisit = attempt;
        }
        return runAtomCommand(
          registry,
          options.visit,
          {
            environmentId: ref.environmentId,
            input: {
              threadId: ref.threadId,
              visitedAt,
              expectedSession: session,
              ...(intent ? { opened: true, commandId: intent.commandId } : {}),
              ...(searchQuery ? { searchQuery } : {}),
            },
          },
          { reportFailure: false },
        ).then((result) => {
          attempt.failed = AsyncResult.isFailure(result);
          if (!attempt.failed) acceptedThrough = Math.max(acceptedThrough, attempt.visitedAtMs);
          return !attempt.failed;
        });
      };

      const sendOpen = (session: object, visitedAt: string, intent: OpenIntent) => {
        open = null;
        inFlightOpen = visit(session, visitedAt, intent).then((accepted) => {
          if (!active && !accepted) abandonOpen(intent);
          inFlightOpen = null;
          if (!active) return;
          if (!accepted) open = { status: "failed", intent, session, visitedAt };
          update(registry.get(inputsAtom));
        });
      };

      const updateOpen = (session: object, visitedAt: string | null, pick: string | null) => {
        if (inFlightOpen !== null) return false;
        if (open?.status === "failed") {
          if (open.session === session) return false;
          if (visitedAt !== null) {
            // A receipt can only prove the original watermark. After a rewind, first
            // execution must use the lower watermark to keep the thread unread.
            const retryAt =
              Date.parse(visitedAt) < Date.parse(open.visitedAt) ? visitedAt : open.visitedAt;
            sendOpen(session, retryAt, open.intent);
            return true;
          }
          releaseOpen(open.intent.claim);
          open = null;
        }
        if (open === null && pick === null) return false;

        const claim = open?.claim ?? claimOpen(Date.now());
        if (visitedAt === null) {
          releaseOpen(claim);
          open = null;
        } else {
          sendOpen(session, visitedAt, {
            claim,
            commandId: options.newCommandId(),
            pick,
          });
        }
        if (pick !== null) registry.set(pickAtom, null);
        return visitedAt !== null;
      };

      const update = ({ shell, session, pick }: VisitInputs) => {
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
          if (pick !== null) registry.set(pickAtom, null);
          return;
        }

        const lastVisitedAtMs =
          shell.lastVisitedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(shell.lastVisitedAt);
        const completedAtMs = shell.latestRun?.completedAt
          ? Date.parse(shell.latestRun.completedAt)
          : NaN;
        if (completedAtMs <= lastVisitedAtMs) {
          observedReadActivityThrough = Math.max(observedReadActivityThrough, shellUpdatedAtMs);
        }
        if (!Number.isNaN(lastVisitedAtMs)) {
          observedThrough = Math.max(observedThrough, lastVisitedAtMs);
          acceptedThrough = Math.max(acceptedThrough, lastVisitedAtMs);
        }
        if (session === null) return;

        // A watermark that once covered this activity and now falls short signals a rewind.
        const rewound =
          (observedThrough >= updatedAtMs && lastVisitedAtMs < updatedAtMs) ||
          (observedReadActivityThrough >= updatedAtMs &&
            observedThrough >= completedAtMs &&
            lastVisitedAtMs < completedAtMs);
        if (updateOpen(session, rewound ? shell.lastVisitedAt : visitedAt, pick)) return;

        if (rewound || acceptedThrough >= updatedAtMs) return;
        const retryVisit = lastVisit?.failed && lastVisit.visitedAtMs > acceptedThrough;
        if (retryVisit && lastVisit?.session === session) return;
        if (!retryVisit && lastVisit && lastVisit.visitedAtMs >= updatedAtMs) return;

        const elapsed = lastVisit === null ? Infinity : Date.now() - lastVisit.at;
        if (
          retryVisit ||
          completedAtMs > lastVisitedAtMs ||
          wakeIsLatest ||
          elapsed >= VISIT_DISPATCH_THROTTLE_MS
        ) {
          void visit(session, visitedAt).then((accepted) => {
            if (!accepted && active) update(registry.get(inputsAtom));
          });
        } else {
          timer = setTimeout(
            () => update(registry.get(inputsAtom)),
            VISIT_DISPATCH_THROTTLE_MS - elapsed,
          );
        }
      };

      // A quick remount can share the outcome of an open that is still in flight.
      if (inFlightOpen !== null) {
        void inFlightOpen.then(() => {
          if (!active) return;
          if (open === null) {
            const claim = claimOpen(openedAt);
            if (claim !== null) open = { status: "pending", claim };
          }
          update(registry.get(inputsAtom));
        });
      }
      get.subscribe(inputsAtom, update, { immediate: true });
    }).pipe(Atom.withLabel(`thread-visit-tracker:${key}`));
  });
  return (ref: ScopedThreadRef | null) => (ref === null ? IDLE_TRACKER : family(threadKey(ref)));
}
