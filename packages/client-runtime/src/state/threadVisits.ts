// @effect-diagnostics globalTimers:off globalDate:off - The tracker runs in atom subscriptions, outside an Effect runtime.
import type { CommandId, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "./entities.ts";
import { type AtomCommand, runAtomCommand } from "./runtime.ts";
import {
  claimThreadOpen,
  clearThreadSearchPick,
  releaseThreadOpen,
  threadSearchPickAtom,
  type ThreadSearchPick,
} from "./threadSearch.ts";
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
  readonly pick: ThreadSearchPick | null;
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
  readonly pick: ThreadSearchPick | null;
}

type OpenState =
  | { readonly status: "pending"; readonly claim: number }
  | { readonly status: "sending"; readonly finished: Promise<void> }
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
    // Keep an in-flight open visible to a quick remount until its result arrives.
    let open: OpenState | null = null;

    return Atom.make((get) => {
      const registry = get.registry;
      const openedAt = Date.now();
      const claimOpen = (at: number) =>
        claimThreadOpen(ref.environmentId, ref.threadId, at) ? at : null;
      const releaseOpen = (claim: number | null) => {
        if (claim !== null) releaseThreadOpen(ref.environmentId, ref.threadId, claim);
      };
      const claimOnMount = () => {
        const claim = claimOpen(openedAt);
        if (claim !== null) open = { status: "pending", claim };
      };
      if (open === null) claimOnMount();
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
        if (open?.status === "failed") releaseOpen(open.intent.claim);
        if (open?.status !== "sending") open = null;
      });

      const visit = (
        session: object,
        visitedAt: string,
        observedLastVisitedAt: string | null,
        intent?: OpenIntent,
      ) => {
        const searchQuery = intent?.pick?.query;
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
              ...(observedLastVisitedAt === null ? {} : { observedLastVisitedAt }),
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

      const sendOpen = (
        session: object,
        visitedAt: string,
        observedLastVisitedAt: string | null,
        intent: OpenIntent,
      ) => {
        const finished = visit(session, visitedAt, observedLastVisitedAt, intent).then(
          (accepted) => {
            if (active && !accepted) open = { status: "failed", intent, session, visitedAt };
            else open = null;
            if (!active && !accepted) releaseOpen(intent.claim);
            if (accepted && intent.pick !== null) clearThreadSearchPick(registry, ref, intent.pick);
            if (active) update(registry.get(inputsAtom));
          },
        );
        open = { status: "sending", finished };
      };

      const updateOpen = (
        session: object,
        visitedAt: string | null,
        observedLastVisitedAt: string | null,
        pick: ThreadSearchPick | null,
      ) => {
        if (open?.status === "sending") return false;
        if (open?.status === "failed" && (pick === null || open.intent.pick === pick)) {
          if (open.session === session) return false;
          if (visitedAt !== null) {
            // A receipt can only prove the original watermark. After a rewind, first
            // execution must use the lower watermark to keep the thread unread.
            const retryAt =
              Date.parse(visitedAt) < Date.parse(open.visitedAt) ? visitedAt : open.visitedAt;
            sendOpen(session, retryAt, observedLastVisitedAt, open.intent);
            return true;
          }
          const { intent } = open;
          open = null;
          releaseOpen(intent.claim);
          if (intent.pick !== null) clearThreadSearchPick(registry, ref, intent.pick);
          return false;
        }
        if (open === null && pick === null) return false;

        const claim =
          open?.status === "failed" ? open.intent.claim : (open?.claim ?? claimOpen(Date.now()));
        if (visitedAt === null) {
          releaseOpen(claim);
          open = null;
        } else {
          sendOpen(session, visitedAt, observedLastVisitedAt, {
            claim,
            commandId: pick?.commandId ?? options.newCommandId(),
            pick,
          });
        }
        if (visitedAt === null && pick !== null) clearThreadSearchPick(registry, ref, pick);
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
          if (pick !== null) clearThreadSearchPick(registry, ref, pick);
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
        if (
          updateOpen(session, rewound ? shell.lastVisitedAt : visitedAt, shell.lastVisitedAt, pick)
        )
          return;

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
          void visit(session, visitedAt, shell.lastVisitedAt).then((accepted) => {
            if (!accepted && active) update(registry.get(inputsAtom));
          });
        } else {
          timer = setTimeout(
            () => update(registry.get(inputsAtom)),
            VISIT_DISPATCH_THROTTLE_MS - elapsed,
          );
        }
      };

      if (open?.status === "sending") {
        void open.finished.then(() => {
          if (!active) return;
          if (open === null) claimOnMount();
          update(registry.get(inputsAtom));
        });
      }
      get.subscribe(inputsAtom, update, { immediate: true });
    }).pipe(Atom.withLabel(`thread-visit-tracker:${key}`));
  });
  return (ref: ScopedThreadRef | null) => (ref === null ? IDLE_TRACKER : family(threadKey(ref)));
}
