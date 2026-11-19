import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type PullRequestListInput,
  type PullRequestListResult,
} from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  failPage: false,
  pendingHead: undefined as Promise<void> | undefined,
  pendingPage: undefined as Promise<void> | undefined,
  pageRequests: 0,
  revision: undefined as Atom.Writable<string> | undefined,
}));

vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      sessionGenerationAtom: Atom.family((_environmentId: string) => Atom.make(0)),
    },
  };
});

vi.mock("../../state/pull-requests", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Schema = await import("effect/Schema");
  class PullRequestListTestError extends Schema.TaggedError<PullRequestListTestError>()(
    "PullRequestListTestError",
    { message: Schema.String },
  ) {}
  const page = (nextCursors: PullRequestListResult["nextCursors"]): PullRequestListResult => ({
    entries: [],
    nextCursors,
    truncated: false,
    viewers: {},
    providers: [],
    errors: [],
  });
  const revision = Atom.make("enabled");
  mocks.revision = revision;
  const { pullRequestListHead } = await import("./pullRequestList");
  const pages = Atom.family((_key: string) =>
    Atom.make<ReturnType<typeof pullRequestListHead> | null>(null),
  );
  const pagesKey = (target: unknown, settings: string) => JSON.stringify([target, settings]);
  const list = Atom.family((key: string) => {
    const target: { environmentId: string; input: PullRequestListInput } = JSON.parse(key);
    return Atom.make((get) => {
      const settings = get(revision);
      const continuation = target.input.cursors !== undefined;
      return Effect.gen(function* () {
        if (target.environmentId === "offline")
          return yield* new PullRequestListTestError({ message: "Environment is not connected." });
        if (continuation) {
          mocks.pageRequests += 1;
          if (mocks.failPage)
            return yield* new PullRequestListTestError({ message: "Page failed." });
        }
        const pending = continuation ? mocks.pendingPage : mocks.pendingHead;
        yield* Effect.promise(() => pending ?? Promise.resolve());
        const response = page(
          continuation || settings === "disabled" ? {} : { "github.com org/repo": "next" },
        );
        if (!continuation) {
          get.registry.update(pages(pagesKey(target, settings)), (previous) =>
            pullRequestListHead(previous, response),
          );
        }
        return response;
      });
    });
  });
  return {
    pullRequestListPagesKey: (target: unknown, read: (atom: typeof revision) => string) =>
      pagesKey(target, read(revision)),
    pullRequestListPagesFamily: pages,
    pullRequestListStatsFamily: Atom.family((_key: string) => Atom.make(new Map())),
    composerPullRequests: {
      listRevision: () => revision,
      list: (target: unknown) => list(JSON.stringify(target)),
      listStats: Atom.family(() => Atom.make(AsyncResult.success({ stats: [] }))),
      invalidate: {
        run: async () => AsyncResult.success({}),
      },
    },
  };
});

import { composerPullRequests } from "../../state/pull-requests";
import { usePullRequestList } from "./usePullRequestList";

async function setup(ids: readonly string[]) {
  mocks.failPage = false;
  mocks.pendingHead = undefined;
  mocks.pendingPage = undefined;
  mocks.pageRequests = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const targets = ids.map((id) => ({
    environmentId: EnvironmentId.make(id),
    input: { state: "open" as const },
  }));
  let latest: ReturnType<typeof usePullRequestList>;
  function Probe() {
    const result = usePullRequestList(targets);
    useLayoutEffect(() => {
      latest = result;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    );
  });
  return {
    registry,
    targets,
    get latest() {
      return latest;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("keeps a refresh failure in the source errors and allows healthy pagination", async () => {
  using probe = await setup(["healthy", "offline"]);
  await act(async () => probe.latest.onRefresh());
  expect(probe.latest.data.errors.map((error) => error.message)).toEqual([
    "Environment is not connected.",
  ]);
  expect(probe.latest.refreshing).toBe(false);
  expect(probe.latest.loadMoreError).toBeNull();

  await act(async () => probe.latest.loadMore());
  expect(probe.latest.continued).toBe(true);
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.loadMoreError).toBeNull();
});

it("keeps load-more failures retryable", async () => {
  using probe = await setup(["healthy"]);
  await act(async () => probe.latest.onRefresh());
  mocks.failPage = true;
  await act(async () => probe.latest.loadMore());
  expect(probe.latest.loadMoreError).toBe("Page failed.");
  expect(probe.latest.hasMore).toBe(true);
  expect(probe.latest.continued).toBe(false);

  mocks.failPage = false;
  await act(async () => probe.latest.loadMore(true));
  expect(probe.latest.loadMoreError).toBeNull();
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.continued).toBe(true);
});

it("waits for the new list head before loading more after upstream is turned off", async () => {
  using probe = await setup(["healthy"]);
  expect(probe.latest.hasMore).toBe(true);
  const head = Promise.withResolvers<void>();
  mocks.pendingHead = head.promise;
  await act(async () => probe.registry.set(mocks.revision!, "disabled"));

  await act(async () => probe.latest.loadMore());
  expect(mocks.pageRequests).toBe(0);

  await act(async () => head.resolve());
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.continued).toBe(false);
});

it("discards a continuation if its source head is replaced before the page answers", async () => {
  using probe = await setup(["healthy"]);
  const page = Promise.withResolvers<void>();
  mocks.pendingPage = page.promise;
  await act(async () => probe.latest.loadMore());
  expect(probe.latest.loadingMore).toBe(true);

  await act(async () => probe.registry.refresh(composerPullRequests.list(probe.targets[0]!)));
  await act(async () => page.resolve());
  expect(probe.latest.continued).toBe(false);
  expect(probe.latest.hasMore).toBe(true);
});
