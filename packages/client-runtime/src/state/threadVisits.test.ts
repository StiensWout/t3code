import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { recordThreadOpen, type ThreadOpenStats } from "@t3tools/shared/paletteSearch";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import type { VisitThreadInput } from "../operations/commands.ts";
import type { AtomCommandResult } from "./runtime.ts";
import { claimThreadOpen, threadSearchPickAtom } from "./threadSearch.ts";
import { createThreadVisitTracker, VISIT_DISPATCH_THROTTLE_MS } from "./threadVisits.ts";

const environmentId = EnvironmentId.make("env-visits");

interface Shell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly lastVisitedAt?: string | null;
  readonly latestRun: { readonly completedAt: string | null } | null;
  readonly wokeAt?: string | null;
}

function at(seconds: number) {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

// claimThreadOpen dedupes per thread in module state, so each test opens its own thread.
function setup(threadName: string, initial: Omit<Shell, "environmentId" | "id"> | null) {
  const start = Date.UTC(2026, 0, 1);
  vi.useFakeTimers({ now: start });
  const threadId = ThreadId.make(threadName);
  const ref = { environmentId, threadId };
  const shellAtom = Atom.make<Shell | null>(
    initial === null ? null : { environmentId, id: threadId, ...initial },
  );
  // Visits the server accepted; offline ones fail without reaching it.
  const visits: Array<VisitThreadInput> = [];
  const localVisits: Array<string> = [];
  let online = true;
  let loseNextOpenAck = false;
  let serverOpens: ThreadOpenStats | null = null;
  let serverTime = start;
  let commandCount = 0;
  const received = new Set<CommandId>();
  const liveSessionAtom = Atom.make<object | null>({});
  let pendingResult: Promise<AtomCommandResult<void, string>> | undefined;
  const attempts: Array<VisitThreadInput> = [];
  const visit = async ({ input }: { readonly input: VisitThreadInput }) => {
    const { commandId, expectedSession: _expectedSession, ...payload } = input;
    attempts.push(payload);
    if (loseNextOpenAck && input.opened) {
      loseNextOpenAck = false;
      acceptOpen();
      return AsyncResult.failure(Cause.fail("acknowledgment lost"));
    }
    function acceptOpen() {
      if (commandId !== undefined && received.has(commandId)) return;
      if (commandId !== undefined) received.add(commandId);
      serverOpens = recordThreadOpen(serverOpens, serverTime, input.searchQuery);
    }
    const pending = pendingResult;
    pendingResult = undefined;
    const result = pending
      ? await pending
      : online
        ? AsyncResult.success(undefined)
        : AsyncResult.failure(Cause.fail("disconnected"));
    if (AsyncResult.isSuccess(result)) {
      if (input.opened) acceptOpen();
      visits.push(payload);
    }
    return result;
  };
  const tracker = createThreadVisitTracker({
    threadShellAtom: () => shellAtom,
    liveSessionAtom: () => liveSessionAtom,
    newCommandId: () => CommandId.make(`${threadName}:${++commandCount}`),
    visit: {
      label: "test-visit",
      run: (_registry, value) => visit(value),
    },
    markLocalVisit: (_ref, visitedAt) => localVisits.push(visitedAt),
  });
  const registry = AtomRegistry.make();
  return {
    ref,
    visits,
    localVisits,
    attempts,
    deferNextVisit: () => {
      const deferred = Promise.withResolvers<AtomCommandResult<void, string>>();
      pendingResult = deferred.promise;
      return (accepted = false) =>
        deferred.resolve(
          accepted ? AsyncResult.success(undefined) : AsyncResult.failure(Cause.fail("rejected")),
        );
    },
    reconnect: (caughtUp = true) => {
      registry.set(liveSessionAtom, caughtUp ? {} : null);
    },
    synchronizeShell: () => {
      registry.set(liveSessionAtom, {});
    },
    loseNextOpenAck: () => {
      loseNextOpenAck = true;
    },
    serverOpens: () => serverOpens,
    setServerTime: (value: number) => {
      serverTime = value;
    },
    mount: () => registry.mount(tracker(ref)),
    pick: (query = " Needle ") => registry.set(threadSearchPickAtom(ref), query),
    setOnline: (value: boolean) => {
      online = value;
    },
    update: (patch: Partial<Shell>) => {
      const current = registry.get(shellAtom);
      registry.set(shellAtom, {
        environmentId,
        id: threadId,
        updatedAt: at(0),
        latestRun: null,
        ...current,
        ...patch,
      });
    },
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

it("records the open once, then throttles streaming visits", () => {
  using t = setup("thread-throttle", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);

  vi.advanceTimersByTime(1_000);
  t.update({ updatedAt: at(11) });
  t.update({ updatedAt: at(12) });
  expect(t.visits).toHaveLength(1);

  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS - 1_000);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(12) }]);
});

it("sends an unseen completion without waiting for the throttle", () => {
  using t = setup("thread-completion", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.mount();
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(20) }]);
});

it("still advances the watermark on a deduped reopen", () => {
  using t = setup("thread-palette", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1));
  t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10) }]);
});

it("keeps a mark-unread on the open thread until new activity lands", () => {
  using t = setup("thread-unread", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  t.update({ lastVisitedAt: at(5) });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);

  t.update({ updatedAt: at(30) });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
});

it("keeps a mark-unread on a read thread reopened within the open dedupe window", () => {
  using t = setup("thread-unread-reopened", {
    updatedAt: at(10),
    lastVisitedAt: at(10),
    latestRun: { completedAt: at(9) },
  });
  claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1));
  t.mount();
  t.update({ lastVisitedAt: at(8) });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);

  // An authoritative snapshot can briefly replace the row with an older one.
  t.update({ updatedAt: at(5), lastVisitedAt: at(5), latestRun: { completedAt: at(4) } });
  t.update({ updatedAt: at(10), lastVisitedAt: at(8), latestRun: { completedAt: at(9) } });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);
});

it("keeps mark unread sticky after an expired wake is retired", () => {
  using t = setup("thread-unread-retired-wake", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: { completedAt: at(9) },
    wokeAt: at(15),
  });
  t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(15), opened: true }]);
  t.update({ lastVisitedAt: at(15) });
  t.update({ lastVisitedAt: at(8), wokeAt: null });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);

  t.update({ updatedAt: at(30) });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
});

it("waits for the shell and records local visits for servers without tracking", () => {
  using t = setup("thread-local", null);
  t.mount();
  expect(t.visits).toEqual([]);
  t.update({ updatedAt: at(10), latestRun: null });
  t.update({ updatedAt: at(11) });
  expect(t.visits).toEqual([]);
  expect(t.localVisits).toEqual([at(10), at(11)]);
});

it("drops a pending visit when the thread is no longer viewed", () => {
  using t = setup("thread-unmount", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  const unmount = t.mount();
  t.update({ updatedAt: at(11) });
  unmount();
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);
});

it("sends the open with the first visit when the shell arrives after the thread is shown", () => {
  using t = setup("thread-shell-missing", null);
  t.mount();
  expect(claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1))).toBe(false);
  expect(t.visits).toEqual([]);

  t.update({ updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);

  t.update({ updatedAt: at(10), lastVisitedAt: at(10) });
  vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toHaveLength(1);
});

it("advances the watermark to a wake without waiting for the throttle", () => {
  using t = setup("thread-wake", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  t.mount();
  t.update({ wokeAt: at(15) });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(15) }]);

  vi.advanceTimersByTime(1_000);
  t.update({ updatedAt: at(16) });
  expect(t.visits).toHaveLength(2);
});

it.each(["unread", "already read"] as const)(
  "retries a failed open on the first %s shell after reconnect",
  async (readState) => {
    using t = setup(`thread-retry-failed-${readState}`, {
      updatedAt: at(10),
      lastVisitedAt: readState === "already read" ? at(10) : at(0),
      latestRun: null,
    });
    t.setOnline(false);
    t.mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.visits).toEqual([]);

    t.setOnline(true);
    t.reconnect(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.visits).toEqual([]);
    t.synchronizeShell();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);
  },
);

it.each([
  ["accepted", "before", null],
  ["accepted", "after", null],
  ["rejected", "before", null],
  ["rejected", "after", null],
  ["rejected", "after", "newer"],
] as const)(
  "records the palette pick when the in-flight open is %s %s remount (new pick %s)",
  async (outcome, settlement, newerPick) => {
    const accepted = outcome === "accepted";
    using t = setup(`thread-left-in-flight-${outcome}-${settlement}-${newerPick}`, {
      updatedAt: at(10),
      lastVisitedAt: at(10),
      latestRun: null,
    });
    t.setOnline(accepted);
    const settle = t.deferNextVisit();
    t.pick();
    const unmount = t.mount();
    if (settlement === "before") {
      settle(accepted);
      await vi.advanceTimersByTimeAsync(0);
    }
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);

    t.setOnline(true);
    t.reconnect();
    if (newerPick !== null) t.pick(newerPick);
    t.mount();
    expect(t.attempts).toHaveLength(!accepted && settlement === "before" ? 2 : 1);
    if (settlement === "after") settle(accepted);
    await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);

    expect(t.attempts).toHaveLength(accepted ? 1 : 2);
    expect(t.visits).toEqual([
      {
        threadId: t.ref.threadId,
        visitedAt: at(10),
        opened: true,
        searchQuery: newerPick ?? "needle",
      },
    ]);
  },
);

it.each(["before", "after"] as const)(
  "records an open when a palette pick fails %s reconnect while the thread stays visible",
  async (settlement) => {
    using t = setup(`thread-pick-fails-${settlement}-reconnect`, {
      updatedAt: at(10),
      lastVisitedAt: at(10),
      latestRun: null,
    });
    t.setOnline(false);
    const fail = t.deferNextVisit();
    t.pick();
    t.mount();
    expect(t.attempts).toEqual([
      { threadId: t.ref.threadId, visitedAt: at(10), opened: true, searchQuery: "needle" },
    ]);
    if (settlement === "before") {
      fail();
      await vi.advanceTimersByTimeAsync(0);
    }

    t.setOnline(true);
    t.reconnect();
    if (settlement === "after") {
      fail();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);

    expect(t.serverOpens()?.picks.map((pick) => pick.query)).toEqual(["needle"]);
  },
);

it("records a palette query on an already visible thread even within the dedupe window", async () => {
  using t = setup("thread-pick-already-visible", {
    updatedAt: at(10),
    lastVisitedAt: at(10),
    latestRun: null,
  });
  t.mount();
  await vi.advanceTimersByTimeAsync(0);

  t.pick();
  await vi.advanceTimersByTimeAsync(0);

  expect(t.serverOpens()).toEqual({
    openedAt: Date.UTC(2026, 0, 1),
    score: 1,
    picks: [{ query: "needle", at: Date.UTC(2026, 0, 1) }],
  });
});

it("retries an open after a newer visit is acknowledged ahead of its shell update", async () => {
  using t = setup("thread-retry-before-visit-echo", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  const rejectOpen = t.deferNextVisit();
  t.mount();
  t.reconnect();
  const acceptVisit = t.deferNextVisit();
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });

  rejectOpen();
  await vi.advanceTimersByTimeAsync(0);
  acceptVisit(true);
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  t.update({ lastVisitedAt: at(20) });

  expect(t.visits).toEqual([
    { threadId: t.ref.threadId, visitedAt: at(10), opened: true },
    { threadId: t.ref.threadId, visitedAt: at(20) },
  ]);
});

it("keeps recording visits when a newer visit overtakes a rejected open", async () => {
  using t = setup("thread-visit-after-superseded-open", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  const rejectOpen = t.deferNextVisit();
  t.mount();
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  await vi.advanceTimersByTimeAsync(0);
  rejectOpen();
  await vi.advanceTimersByTimeAsync(0);

  t.update({ updatedAt: at(30), lastVisitedAt: at(20) });
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);

  expect(t.visits).toEqual([
    { threadId: t.ref.threadId, visitedAt: at(20) },
    { threadId: t.ref.threadId, visitedAt: at(30) },
  ]);
});

it("records an open after leaving an offline thread and reopening it online", async () => {
  using t = setup("thread-reopen-after-offline", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  const unmount = t.mount();
  await vi.advanceTimersByTimeAsync(0);
  unmount();
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);

  t.setOnline(true);
  t.reconnect();
  const reopenedAt = Date.UTC(2026, 0, 1, 0, 0, 10);
  t.mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.visits.at(-1)?.visitedAt).toBe(at(10));
  const recorded = t.visits.reduce<ThreadOpenStats | null>(
    (opens, visit) =>
      visit.opened ? recordThreadOpen(opens, reopenedAt, visit.searchQuery) : opens,
    null,
  );
  expect(recorded, "server open history after reconnect").toEqual({
    openedAt: reopenedAt,
    score: 1,
    picks: [],
  });
});

it("leaves a null watermark untouched when retrying an open after a rewind", async () => {
  using t = setup("thread-failed-seen", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  await vi.advanceTimersByTimeAsync(0);

  t.setOnline(true);
  t.reconnect(false);
  t.update({ lastVisitedAt: null });
  t.synchronizeShell();
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.visits).toEqual([]);
});

it("retries an open at the rewound watermark after losing its acknowledgment", async () => {
  using t = setup("thread-accepted-rewound-failure", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  const fail = t.deferNextVisit();
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  t.update({ lastVisitedAt: at(5) });
  fail();
  await vi.advanceTimersByTimeAsync(0);
  t.reconnect();
  t.update({});
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
  expect(t.attempts).toEqual([
    { threadId: t.ref.threadId, visitedAt: at(10), opened: true },
    { threadId: t.ref.threadId, visitedAt: at(5), opened: true },
  ]);
});

it.each(["unchanged shell", "new shell snapshot"] as const)(
  "retries with %s when reconnect arrives before the pending visit fails",
  async (snapshot) => {
    using t = setup(`thread-reconnect-before-failure-${snapshot}`, {
      updatedAt: at(10),
      lastVisitedAt: at(0),
      latestRun: null,
    });
    t.setOnline(false);
    const fail = t.deferNextVisit();
    t.mount();
    t.setOnline(true);
    t.reconnect();
    if (snapshot === "new shell snapshot") t.update({});
    fail();
    await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);
    expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);
  },
);

it("retries rejected opens only once per connection generation", async () => {
  using t = setup("thread-rejection-throttle", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  await vi.advanceTimersByTimeAsync(0);
  for (let second = 1; second < 10; second++) {
    await vi.advanceTimersByTimeAsync(1_000);
    t.update({});
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(t.attempts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.attempts).toHaveLength(1);
  t.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.attempts).toHaveLength(2);
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  await vi.advanceTimersByTimeAsync(3 * VISIT_DISPATCH_THROTTLE_MS);
  expect(t.attempts).toHaveLength(2);
});

it("waits for reconnect catch-up before retrying an open on a thread marked unread elsewhere", async () => {
  using t = setup("thread-rewind-during-catch-up", {
    updatedAt: at(20),
    lastVisitedAt: at(10),
    latestRun: { completedAt: at(10) },
  });
  t.setOnline(false);
  t.mount();
  await vi.advanceTimersByTimeAsync(2 * VISIT_DISPATCH_THROTTLE_MS);

  t.setOnline(true);
  t.reconnect(false);
  expect(t.attempts).toHaveLength(1);
  const rewoundAt = "2026-01-01T00:00:09.999Z";
  t.update({ lastVisitedAt: rewoundAt });
  t.synchronizeShell();
  await vi.advanceTimersByTimeAsync(VISIT_DISPATCH_THROTTLE_MS);

  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: rewoundAt, opened: true }]);

  t.update({ updatedAt: at(30), latestRun: { completedAt: at(30) } });
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
});

it("does not count a committed open again after its acknowledgment was lost", async () => {
  using t = setup("thread-open-committed-without-ack", {
    updatedAt: at(10),
    lastVisitedAt: at(10),
    latestRun: null,
  });
  t.loseNextOpenAck();
  t.mount();
  const elevenMinutes = 11 * 60_000;
  await vi.advanceTimersByTimeAsync(elevenMinutes);
  t.setServerTime(Date.UTC(2026, 0, 1) + elevenMinutes);

  t.reconnect();
  t.update({});
  await vi.advanceTimersByTimeAsync(0);

  expect(t.attempts).toHaveLength(2);
  expect(t.serverOpens()).toEqual({
    openedAt: Date.UTC(2026, 0, 1),
    score: 1,
    picks: [],
  });
});
