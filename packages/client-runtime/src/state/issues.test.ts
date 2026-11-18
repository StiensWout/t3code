import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueComment,
  type IssueCommentsPage,
  type IssueListEntry,
  type IssueListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { continueIssuePage, holdIssuePages } from "../issueList.ts";
import {
  createIssueCommentPager,
  createMergedIssueCandidatesAtoms,
  createMergedIssueListAtoms,
  issueEntryKey,
  mergeIssueListPage,
} from "./issues.ts";

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/app",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/app/issues/${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: "project-1" as ProjectId,
    projectTitle: "App",
    ...overrides,
  };
}

describe("mergeIssueListPage", () => {
  it("keeps rows from scopes the page did not continue and orders by update", () => {
    const held = [
      entry({ key: "1", updatedAt: "2026-10-03T00:00:00.000Z" }),
      entry({ key: "9", scope: "acme/other", updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const page = [entry({ key: "2", updatedAt: "2026-10-04T00:00:00.000Z" })];
    expect(mergeIssueListPage(held, page).map((row) => row.key)).toEqual(["2", "1", "9"]);
  });

  it("replaces a repeated row with the page's newer words", () => {
    const held = [entry({ key: "1", title: "Old title" })];
    const page = [
      entry({ key: "1", title: "New title", state: { category: "closed", name: "closed" } }),
    ];
    const merged = mergeIssueListPage(held, page);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("New title");
    expect(merged[0]?.state.category).toBe("closed");
  });

  it("keys rows case-insensitively by host and scope, exactly by key", () => {
    expect(issueEntryKey(entry({ key: "1", host: "GitHub.com", scope: "Acme/App" }))).toBe(
      issueEntryKey(entry({ key: "1" })),
    );
    expect(issueEntryKey(entry({ key: "ENG-1" }))).not.toBe(issueEntryKey(entry({ key: "eng-1" })));
  });
});

describe("createMergedIssueListAtoms", () => {
  it("keeps loaded rows during refresh and lets another environment continue", () => {
    const healthy = "healthy" as EnvironmentId;
    const refreshing = "refreshing" as EnvironmentId;
    const input = { state: "open" } as const;
    const targets = [
      { environmentId: healthy, input },
      { environmentId: refreshing, input },
    ];
    const cursorKey = "github.com acme/app";
    const first: IssueListResult = {
      viewers: {},
      trackers: [],
      entries: [entry({ key: "1" })],
      errors: [],
      nextCursors: { [cursorKey]: "page-2" },
    };
    const queries = Atom.family((_id: EnvironmentId) =>
      Atom.make<AsyncResult.AsyncResult<IssueListResult, string>>(AsyncResult.success(first)),
    );
    const registry = AtomRegistry.make();
    const lists = createMergedIssueListAtoms(
      ({ environmentId }) => queries(environmentId),
      () => "Refresh failed",
    );
    const listing = lists.atom(targets);
    const initial = registry.get(listing);
    const held = holdIssuePages(initial.answers, new Map(), input, initial.revisions);
    const loaded = new Map(held).set(
      refreshing,
      continueIssuePage(held.get(refreshing)!, {
        ...first,
        entries: [entry({ key: "2" })],
        nextCursors: { [cursorKey]: "page-3" },
      }),
    );

    const previous = AsyncResult.success(first);
    lists.refresh(registry, [{ environmentId: refreshing, input }]);
    registry.set(queries(refreshing), AsyncResult.waiting(previous));
    const pending = registry.get(listing);
    expect(pending.isPending).toBe(true);
    expect(pending.readyToContinue).toEqual(new Set([healthy]));
    expect(holdIssuePages(pending.answers, loaded, input, pending.revisions)).toBe(loaded);

    registry.set(
      queries(refreshing),
      AsyncResult.failWithPrevious("offline", { previous: Option.some(previous) }),
    );
    const failed = registry.get(listing);
    const retained = holdIssuePages(failed.answers, loaded, input, failed.revisions);
    expect(failed.error).toBe("Refresh failed");
    expect(failed.readyToContinue).toEqual(new Set([healthy, refreshing]));
    expect(retained.get(refreshing)?.entries.map((row) => row.key)).toEqual(["1", "2"]);
    expect(retained.get(refreshing)?.nextCursors).toEqual({ [cursorKey]: "page-3" });
  });
});

const comment = (id: string): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: "2026-10-01T00:00:00.000Z",
  url: null,
});

describe("createIssueCommentPager", () => {
  it("drops older pages on refresh, including one still loading, and pauses paging until it ends", async () => {
    // The refreshed detail hands back the same cursor, so only the refresh itself can tell pages apart.
    const detail = Atom.make(
      AsyncResult.success({ comments: [comment("newest")], commentsCursor: "first-page" }),
    );
    const pager = createIssueCommentPager(detail);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(pager.view);
    const ids = () => registry.get(pager.view).comments.map(({ id }) => id);
    const cursors: string[] = [];
    const page = AsyncResult.success<IssueCommentsPage>({
      comments: [comment("older"), comment("newest")],
      nextCursor: "second-page",
    });
    const read = async (cursor: string) => {
      cursors.push(cursor);
      return page;
    };
    try {
      await pager.loadOlder(registry, read);
      expect(ids()).toEqual(["older", "newest"]);

      const pending = Promise.withResolvers<typeof page>();
      const inFlight = pager.loadOlder(registry, () => pending.promise);
      const refreshed = Promise.withResolvers<void>();
      const refresh = pager.refresh(registry, () => refreshed.promise);
      pending.resolve(page);
      await inFlight;
      expect(ids()).toEqual(["newest"]);

      await pager.loadOlder(registry, read);
      expect(registry.get(pager.view).canLoadOlder).toBe(false);
      refreshed.resolve();
      await refresh;
      await pager.loadOlder(registry, read);
      expect(cursors).toEqual(["first-page", "first-page"]);
      expect(ids()).toEqual(["older", "newest"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("createMergedIssueCandidatesAtoms", () => {
  it("retries only failed scopes that are not already reloading", () => {
    const registry = AtomRegistry.make();
    const target = (scope: string) => ({
      environmentId: EnvironmentId.make("issues"),
      input: {
        projectId: ProjectId.make(scope),
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope,
      },
    });
    const targets = [target("acme/healthy"), target("acme/flaky")];
    const requests: string[] = [];
    const candidates = Atom.family((scope: string) =>
      Atom.make(
        Effect.suspend(() => {
          requests.push(scope);
          if (scope === "acme/healthy") {
            return Effect.succeed({ labels: [], assignees: [], truncated: false });
          }
          return requests.length === 2 ? Effect.fail("Repository unavailable") : Effect.never;
        }),
      ),
    );
    const merged = createMergedIssueCandidatesAtoms(
      (t) => candidates(t.input.scope),
      () => "Repository unavailable",
    );
    const view = merged.atom(targets);
    const unmount = registry.mount(view);
    try {
      expect(registry.get(view)).toMatchObject({
        error: "Repository unavailable",
        isPending: false,
      });

      merged.retry(registry, targets);
      expect(registry.get(view).isPending).toBe(true);
      merged.retry(registry, targets);

      expect(requests).toEqual(["acme/healthy", "acme/flaky", "acme/flaky"]);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
