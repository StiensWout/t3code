import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestListEntry,
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
  pageRequests: [] as PullRequestListResult["nextCursors"][],
  revision: undefined as Atom.Writable<string> | undefined,
  partialPage: false,
  copyHeadResult: false,
}));

vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      sessionGenerationAtom: Atom.family((_environmentId: string) => Atom.make(0)),
    },
  };
});

vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const revision = Atom.make("enabled");
  mocks.revision = revision;
  return { serverEnvironment: { forkUpstreamSettingsAtom: () => revision } };
});

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));

vi.mock("@t3tools/client-runtime/state/pull-requests", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@t3tools/client-runtime/state/pull-requests")>();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Schema = await import("effect/Schema");
  const { serverEnvironment } = await import("../../state/server");
  class PullRequestListTestError extends Schema.TaggedError<PullRequestListTestError>()(
    "PullRequestListTestError",
    { message: Schema.String },
  ) {}
  return {
    ...original,
    createPullRequestStackAtomFamily: () => undefined,
    createPullRequestEnvironmentAtoms: (
      _runtime: unknown,
      options: Parameters<typeof original.createPullRequestEnvironmentAtoms>[1],
    ) => {
      const list = Atom.family((key: string) => {
        const target: { environmentId: EnvironmentId; input: PullRequestListInput } =
          JSON.parse(key);
        const settingsAtom = serverEnvironment.forkUpstreamSettingsAtom(target.environmentId);
        // Like the real head query: kept while idle, and read again only when the settings differ
        // from the ones its answer was read under, so turning one off and back on keeps the head.
        let readUnder: string | undefined;
        const query = Atom.make((get) => {
          const settings = get.once(settingsAtom);
          readUnder = settings;
          const cursors = target.input.cursors;
          return Effect.gen(function* () {
            if (target.environmentId === "offline")
              return yield* new PullRequestListTestError({
                message: "Environment is not connected.",
              });
            if (cursors !== undefined) {
              mocks.pageRequests.push(cursors);
              if (mocks.failPage)
                return yield* new PullRequestListTestError({ message: "Page failed." });
            }
            const pending = cursors === undefined ? mocks.pendingHead : mocks.pendingPage;
            yield* Effect.promise(() => pending ?? Promise.resolve());
            const partial = cursors !== undefined && mocks.partialPage;
            const response: PullRequestListResult = {
              entries: cursors?.["github.com org/repo"] === "next" ? [continuedEntry] : [],
              nextCursors: partial
                ? { "github.com org/other": "retry" }
                : cursors !== undefined || settings === "disabled"
                  ? {}
                  : { "github.com org/repo": "next", "github.com org/other": "retry" },
              truncated: false,
              viewers: {},
              providers: [],
              errors: partial
                ? [
                    {
                      projectId: ProjectId.make("other"),
                      projectTitle: "Other",
                      message: "Page failed.",
                      upstream: true,
                    },
                  ]
                : [],
            };
            yield* options?.list?.(target, response, get.registry) ?? Effect.void;
            return mocks.copyHeadResult && cursors === undefined ? { ...response } : response;
          });
        });
        if (target.input.cursors !== undefined) return query;
        const head = Atom.keepAlive(query);
        return Atom.transform(
          head,
          (get) => {
            const current = get(settingsAtom);
            get.subscribe(head, (value) => get.setSelf(value));
            if (readUnder !== undefined && readUnder !== current) get.refresh(head);
            return get.once(head);
          },
          { initialValueTarget: head },
        );
      });
      return {
        listRevision: serverEnvironment.forkUpstreamSettingsAtom,
        list: (target: unknown) => list(JSON.stringify(target)),
        listStats: Atom.family(() => Atom.make(AsyncResult.success({ stats: [] }))),
        invalidate: { run: async () => AsyncResult.success({}) },
      };
    },
  };
});

import { composerPullRequests } from "../../state/pull-requests";
import { usePullRequestList } from "./usePullRequestList";

const continuedEntry: PullRequestListEntry = {
  number: 2,
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "org/repo",
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  title: "Second pull request",
  url: "https://github.com/org/repo/pull/2",
  author: null,
  headBranch: "change",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "unknown",
  additions: 0,
  deletions: 0,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  viewerReviewRequested: false,
  labels: [],
};

async function setup(ids: readonly string[]) {
  mocks.failPage = false;
  mocks.pendingHead = undefined;
  mocks.pendingPage = undefined;
  mocks.pageRequests = [];
  mocks.partialPage = false;
  mocks.copyHeadResult = false;
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
  const showList = (visible: boolean) =>
    act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          {visible ? <Probe /> : null}
        </RegistryContext.Provider>,
      );
    });
  await showList(true);
  return {
    registry,
    showList,
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

it("shows the successful rows from a partial page and allows retrying the failed repository", async () => {
  using probe = await setup(["healthy"]);
  mocks.partialPage = true;
  await act(async () => probe.latest.loadMore());
  expect(probe.latest.entries.map(({ number }) => number)).toEqual([2]);
  expect(probe.latest.loadMoreError).toBe("Page failed.");
  expect(probe.latest.hasMore).toBe(true);

  mocks.partialPage = false;
  await act(async () => probe.latest.loadMore(true));
  expect(mocks.pageRequests.at(-1)).toEqual({ "github.com org/other": "retry" });
  expect(probe.latest.entries.map(({ number }) => number)).toEqual([2]);
  expect(probe.latest.loadMoreError).toBeNull();
  expect(probe.latest.hasMore).toBe(false);
});

it("waits for the new list head before loading more after upstream is turned off", async () => {
  using probe = await setup(["healthy"]);
  expect(probe.latest.hasMore).toBe(true);
  const head = Promise.withResolvers<void>();
  mocks.pendingHead = head.promise;
  await act(async () => probe.registry.set(mocks.revision!, "disabled"));

  await act(async () => probe.latest.loadMore());
  expect(mocks.pageRequests).toEqual([]);

  await act(async () => head.resolve());
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.continued).toBe(false);
});

it("starts from a fresh head when upstream is turned off and back on", async () => {
  using probe = await setup(["healthy"]);
  await act(async () => probe.latest.loadMore());
  expect(probe.latest.continued).toBe(true);
  expect(probe.latest.hasMore).toBe(false);
  expect(probe.latest.entries.map(({ number }) => number)).toEqual([2]);

  await probe.showList(false);
  await act(async () => probe.registry.set(mocks.revision!, "disabled"));
  await act(async () => probe.registry.set(mocks.revision!, "enabled"));
  await probe.showList(true);
  expect(probe.latest.continued).toBe(false);
  expect(probe.latest.hasMore).toBe(true);
  expect(probe.latest.entries).toEqual([]);

  mocks.pageRequests = [];
  await act(async () => probe.latest.loadMore());
  expect(mocks.pageRequests).toEqual([
    { "github.com org/repo": "next", "github.com org/other": "retry" },
  ]);
  expect(probe.latest.entries.map(({ number }) => number)).toEqual([2]);
  expect(probe.latest.continued).toBe(true);
});

it("drops loaded pages when manually refreshing an upstream-enabled list", async () => {
  using probe = await setup(["healthy"]);
  await act(async () => probe.latest.loadMore());
  expect(probe.latest.entries.map(({ number }) => number)).toEqual([2]);

  mocks.copyHeadResult = true;
  await act(async () => probe.latest.onRefresh());
  expect(probe.latest.entries).toEqual([]);
  expect(probe.latest.continued).toBe(false);
  expect(probe.latest.hasMore).toBe(true);
});

it.each(["before", "during"])("keeps a page requested %s a background refresh", async (when) => {
  using probe = await setup(["healthy"]);
  const head = Promise.withResolvers<void>();
  const page = Promise.withResolvers<void>();
  mocks.pendingHead = head.promise;
  mocks.pendingPage = page.promise;
  if (when === "before") await act(async () => probe.latest.loadMore());
  await act(async () => probe.registry.refresh(composerPullRequests.list(probe.targets[0]!)));
  if (when === "during") await act(async () => probe.latest.loadMore());

  await act(async () => page.resolve());
  expect(probe.latest.entries.map(({ number }) => number)).toEqual([2]);

  await act(async () => head.resolve());
  expect(probe.latest.hasMore).toBe(false);
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
