import type {
  EnvironmentId,
  IssueListEntry,
  IssueListInput,
  IssueListResult,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  continueIssuePage,
  finishIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  issueFilterScopes,
  issuePageFailuresForHost,
} from "./issueList.ts";

const environmentId = "env-1" as EnvironmentId;
const api = "api" as ProjectId;
const listing: IssueListInput = { state: "open", involvement: "all", limit: 50 };

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/api",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/api/issues/${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: api,
    projectTitle: "api",
    ...overrides,
  };
}

function answer(overrides: Partial<IssueListResult>): IssueListResult {
  return { viewers: {}, trackers: [], entries: [], errors: [], nextCursors: {}, ...overrides };
}

function hold(first: IssueListResult) {
  return holdIssuePages([[environmentId, first]], new Map(), listing).get(environmentId)!;
}

describe("holdIssuePages", () => {
  it("keeps loaded pages over a refreshed first page and forgets them for another listing", () => {
    const cursors = { "github.com acme/web": "w2" };
    const first = answer({ entries: [entry({ key: "1" })], nextCursors: cursors });
    const loaded = new Map([
      [environmentId, continueIssuePage(hold(first), answer({ entries: [entry({ key: "3" })] }))],
    ]);
    const refreshed = answer({
      entries: [entry({ key: "1", title: "Renamed" })],
      nextCursors: cursors,
    });

    const kept = holdIssuePages([[environmentId, refreshed]], loaded, listing).get(environmentId)!;
    expect(kept.entries.map((row) => row.title)).toEqual(["Renamed", "Issue 3"]);
    expect(kept.nextCursors).toEqual({});

    const closed = holdIssuePages([[environmentId, refreshed]], loaded, {
      ...listing,
      state: "closed",
    }).get(environmentId)!;
    expect(closed.entries.map((row) => row.title)).toEqual(["Renamed"]);
    expect(closed.nextCursors).toEqual(cursors);
  });

  it("prefers a refreshed first page's row over an older copy in a continuation", () => {
    const first = answer({ entries: [entry({ key: "1" })], nextCursors: { "github.com x": "c" } });
    const older = answer({ entries: [entry({ key: "1" }), entry({ key: "3" })] });
    const loaded = new Map([[environmentId, continueIssuePage(hold(first), older)]]);
    const refreshed = answer({ entries: [entry({ key: "1", title: "Renamed" })] });

    const kept = holdIssuePages([[environmentId, refreshed]], loaded, listing).get(environmentId)!;
    expect(kept.entries.map((row) => row.title)).toEqual(["Renamed", "Issue 3"]);
  });

  it.each(["moved", "closed"] as const)(
    "restarts only the affected repository when a continuation issue is %s",
    (change) => {
      const secondRepo = (key: string) =>
        entry({
          key,
          scope: "acme/web",
          projectId: "web" as ProjectId,
          url: `https://github.com/acme/web/issues/${key}`,
        });
      const firstCursors = { "github.com acme/api": "a2", "github.com acme/web": "w2" };
      const first = answer({
        entries: [entry({ key: "1" }), entry({ key: "2" }), secondRepo("5")],
        nextCursors: firstCursors,
      });
      const moved = entry({ key: "4", updatedAt: "2026-10-02T00:00:00.000Z" });
      const pages = new Map([
        [
          environmentId,
          continueIssuePage(
            hold(first),
            answer({
              entries: [entry({ key: "3" }), entry({ key: "4" }), secondRepo("6")],
              nextCursors: { "github.com acme/api": "a3", "github.com acme/web": "w3" },
            }),
          ),
        ],
      ]);
      const refreshed = answer({
        ...first,
        entries: change === "moved" ? [moved, entry({ key: "1" }), secondRepo("5")] : first.entries,
      });
      const revisions = new Map(
        change === "closed" ? [[environmentId, new Map([["github.com acme/api", 1]])]] : [],
      );
      const held = holdIssuePages([[environmentId, refreshed]], pages, listing, revisions).get(
        environmentId,
      )!;
      expect(held.entries.map((row) => row.key).sort()).toEqual(
        change === "moved" ? ["1", "4", "5", "6"] : ["1", "2", "5", "6"],
      );
      expect(held.nextCursors).toEqual({
        "github.com acme/api": "a2",
        "github.com acme/web": "w3",
      });
    },
  );

  it("keeps pagination on a live refresh when the first page is unchanged", () => {
    const first = answer({
      entries: [entry({ key: "1" })],
      nextCursors: { "github.com acme/api": "a2" },
    });
    const loaded = continueIssuePage(
      hold(first),
      answer({ entries: [entry({ key: "2" })], nextCursors: { "github.com acme/api": "a3" } }),
    );
    const refreshed = holdIssuePages(
      [[environmentId, { ...first }]],
      new Map([[environmentId, loaded]]),
      listing,
    ).get(environmentId)!;

    expect(refreshed.entries.map((row) => row.key)).toEqual(["1", "2"]);
    expect(refreshed.nextCursors).toEqual(loaded.nextCursors);
  });

  it("keeps creation-sorted pages when update times reorder the first page", () => {
    const byCreation = { ...listing, sort: "created" } as const;
    const repo = "github.com acme/api";
    const newest = entry({ key: "1", createdAt: "2026-10-02T00:00:00.000Z" });
    const tied = entry({ key: "2", createdAt: newest.createdAt });
    const first = answer({ entries: [newest, tied], nextCursors: { [repo]: "a2" } });
    const held = holdIssuePages([[environmentId, first]], new Map(), byCreation);
    const loaded = continueIssuePage(
      held.get(environmentId)!,
      answer({ entries: [entry({ key: "3" })], nextCursors: { [repo]: "a3" } }),
    );
    const refreshed = holdIssuePages(
      [
        [
          environmentId,
          { ...first, entries: [{ ...tied, updatedAt: "2026-10-03T00:00:00.000Z" }, newest] },
        ],
      ],
      new Map([[environmentId, loaded]]),
      byCreation,
    ).get(environmentId)!;

    expect(refreshed.entries.map((row) => row.key).sort()).toEqual(["1", "2", "3"]);
    expect(refreshed.nextCursors).toEqual({ [repo]: "a3" });
  });

  it("keeps a failed continuation only for the repository that still needs to retry", () => {
    const host = "GitHub.Example.com";
    const web = "web" as ProjectId;
    const entries = [
      entry({ key: "1", host }),
      entry({ key: "5", host, scope: "acme/web", projectId: web }),
    ];
    const apiKey = "GitHub.Example.com acme/api";
    const webKey = "GitHub.Example.com acme/web";
    const cursors = { [apiKey]: "a2", [webKey]: "w2" };
    const first = answer({ entries, nextCursors: cursors });
    const loaded = continueIssuePage(
      hold(first),
      answer({
        entries: [entry({ key: "2", host })],
        nextCursors: { ...cursors, [apiKey]: "a3" },
      }),
    );
    const apiError = { projectId: api, projectTitle: "api", message: "api failed" };
    const webError = { projectId: web, projectTitle: "web", message: "web failed" };
    const failed = continueIssuePage(
      loaded,
      answer({ errors: [apiError, webError], nextCursors: loaded.nextCursors }),
    );
    const revisions = new Map([[environmentId, new Map([["github.example.com acme/api", 1]])]]);
    const refreshed = holdIssuePages(
      [[environmentId, { ...first }]],
      new Map([[environmentId, failed]]),
      listing,
      revisions,
    ).get(environmentId)!;

    expect(refreshed.entries.map((row) => row.key).sort()).toEqual(["1", "5"]);
    expect(refreshed.nextCursors).toEqual(cursors);
    expect(refreshed.errors).toEqual([webError]);
    expect(continueIssuePage(refreshed, answer({}), { [webKey]: "w2" }).errors).toEqual([]);
  });

  it("keeps an in-flight page for a same-named repository on another host", () => {
    const github = "github.com acme/api";
    const gitlab = "gitlab.com acme/api";
    const gitlabIssue = (key: string) =>
      entry({ key, tracker: "gitlab" as IssueTrackerKind, host: "gitlab.com" });
    const first = answer({
      entries: [entry({ key: "1" }), gitlabIssue("5")],
      nextCursors: { [github]: "a2", [gitlab]: "w2" },
    });
    const requested = hold(first);
    const refreshed = holdIssuePages(
      [[environmentId, first]],
      new Map([[environmentId, requested]]),
      listing,
      new Map([[environmentId, new Map([[github, 1]])]]),
    );
    const finished = finishIssuePage(
      refreshed,
      environmentId,
      requested,
      answer({
        entries: [entry({ key: "2" }), gitlabIssue("6")],
        nextCursors: { [github]: "a3", [gitlab]: "w3" },
      }),
    ).get(environmentId)!;
    expect(finished.entries.map((row) => row.key).sort()).toEqual(["1", "5", "6"]);
    expect(finished.nextCursors).toEqual({ [github]: "a2", [gitlab]: "w3" });
  });

  it("keeps an untouched scope's rows and cursor through a first-page failure and recovery", () => {
    const github = "github.com acme/api";
    const gitlab = "gitlab.com acme/web";
    const web = "web" as ProjectId;
    const webIssue = (key: string) =>
      entry({
        key,
        tracker: "gitlab" as IssueTrackerKind,
        host: "gitlab.com",
        scope: "acme/web",
        projectId: web,
      });
    const first = answer({
      entries: [entry({ key: "1" }), webIssue("5")],
      nextCursors: { [github]: "a2", [gitlab]: "w2" },
    });
    const loaded = continueIssuePage(
      hold(first),
      answer({
        entries: [entry({ key: "2" }), webIssue("6")],
        nextCursors: { [github]: "a3", [gitlab]: "w3" },
      }),
    );
    const error = {
      projectId: web,
      projectTitle: "web",
      message: "rate limited",
      cursorKey: gitlab,
    };
    const revisions = new Map([[environmentId, new Map([[github, 1]])]]);
    const failed = holdIssuePages(
      [
        [
          environmentId,
          answer({
            entries: [entry({ key: "1", title: "Renamed" })],
            nextCursors: { [github]: "a2" },
            errors: [error],
          }),
        ],
      ],
      new Map([[environmentId, loaded]]),
      listing,
      revisions,
    );
    expect(
      failed
        .get(environmentId)
        ?.entries.map((row) => row.key)
        .sort(),
    ).toEqual(["1", "5", "6"]);
    expect(failed.get(environmentId)?.nextCursors).toEqual({ [github]: "a2", [gitlab]: "w3" });
    expect(failed.get(environmentId)?.errors).toEqual([error]);

    const recovered = holdIssuePages([[environmentId, first]], failed, listing, revisions);
    expect(
      recovered
        .get(environmentId)
        ?.entries.map((row) => row.key)
        .sort(),
    ).toEqual(["1", "5", "6"]);
    expect(recovered.get(environmentId)?.nextCursors).toEqual({ [github]: "a2", [gitlab]: "w3" });
    expect(recovered.get(environmentId)?.errors).toEqual([]);

    const removed = holdIssuePages(
      [
        [
          environmentId,
          answer({ entries: [entry({ key: "1" })], nextCursors: { [github]: "a2" }, scopes: [] }),
        ],
      ],
      failed,
      listing,
      revisions,
    );
    expect(removed.get(environmentId)?.entries.map((row) => row.key)).toEqual(["1"]);
    expect(removed.get(environmentId)?.nextCursors).toEqual({ [github]: "a2" });
  });

  it("forgets loaded rows and rejects a late continuation when switching away and back", () => {
    const first = answer({
      entries: [entry({ key: "1" })],
      nextCursors: { "github.com acme/api": "a2" },
    });
    const loaded = continueIssuePage(
      hold(first),
      answer({ entries: [entry({ key: "2" })], nextCursors: { "github.com acme/api": "a3" } }),
    );
    const switched = holdIssuePages([], new Map([[environmentId, loaded]]), {
      ...listing,
      state: "closed",
    });
    const returned = holdIssuePages([[environmentId, first]], switched, listing);
    const late = finishIssuePage(returned, environmentId, loaded, { failure: "rate limited" });

    expect(late.get(environmentId)?.entries.map((row) => row.key)).toEqual(["1"]);
    expect(late.get(environmentId)?.nextCursors).toEqual({ "github.com acme/api": "a2" });
    expect(late.get(environmentId)?.moreFailures).toEqual([]);
  });
});

describe("continueIssuePage", () => {
  const failure = { projectId: api, projectTitle: "api", message: "rate limited" };
  const firstPageFailure = { projectId: "web" as ProjectId, projectTitle: "web", message: "boom" };
  const cursors = { "github.com acme/api": "c1", "linear.app eng": "l1" };

  it("drops a continuation's error once a retry of the same cursors works", () => {
    const first = hold(answer({ errors: [firstPageFailure], nextCursors: cursors }));
    const failed = continueIssuePage(
      first,
      answer({ errors: [failure], nextCursors: cursors }),
      cursors,
    );
    expect(failed.errors.map((error) => error.message)).toEqual(["boom", "rate limited"]);
    const retried = continueIssuePage(failed, answer({ entries: [entry({ key: "2" })] }), cursors);
    // The first page's failure has no cursor, so no continuation retried it.
    expect(retried.errors.map((error) => error.message)).toEqual(["boom"]);
  });

  it("clears the retried scope's error when two trackers share a project", () => {
    const github = "github.com acme/api";
    const linear = "linear.app eng";
    const githubFailure = { ...failure, cursorKey: github };
    const linearFailure = { ...failure, message: "Linear failed", cursorKey: linear };
    const first = hold(answer({ nextCursors: cursors }));
    const failed = continueIssuePage(
      first,
      answer({ errors: [githubFailure, linearFailure], nextCursors: cursors }),
    );
    const linearRetry = continueIssuePage(
      failed,
      answer({ errors: [linearFailure], nextCursors: { [linear]: "l2" } }),
      { [linear]: cursors[linear] },
    );
    expect(linearRetry.nextCursors).toEqual({ ...cursors, [linear]: "l2" });
    const retried = continueIssuePage(failed, answer({}), { [github]: cursors[github] });
    expect(retried.errors).toEqual([linearFailure]);
    expect(retried.nextCursors).toEqual({ [linear]: cursors[linear] });
  });

  it("keeps transport failures separate until each host is retried", () => {
    const first = hold(answer({ nextCursors: cursors }));
    const github = issueCursorsForHost(cursors, "github.com");
    const linear = issueCursorsForHost(cursors, "linear.app");
    const githubFailed = continueIssuePage(first, { failure: "GitHub failed" }, github);
    const bothFailed = continueIssuePage(githubFailed, { failure: "Linear failed" }, linear);
    expect(issuePageFailuresForHost(bothFailed, "github.com")).toEqual(["GitHub failed"]);
    expect(issuePageFailuresForHost(bothFailed, "linear.app")).toEqual(["Linear failed"]);

    const retried = continueIssuePage(bothFailed, answer({}), github);
    expect(issuePageFailuresForHost(retried, "github.com")).toEqual([]);
    expect(issuePageFailuresForHost(retried, "linear.app")).toEqual(["Linear failed"]);
  });

  it("moves only the cursors asked for and keeps the other trackers' errors", () => {
    const first = hold(answer({ nextCursors: cursors }));
    const linear = issueCursorsForHost(cursors, "linear.app");
    expect(linear).toEqual({ "linear.app eng": "l1" });
    const linearFailed = continueIssuePage(
      first,
      answer({ errors: [failure], nextCursors: linear }),
      linear,
    );
    const github = issueCursorsForHost(linearFailed.nextCursors, "github.com");
    const next = continueIssuePage(
      linearFailed,
      answer({ entries: [entry({ key: "2" })], nextCursors: { "github.com acme/api": "c2" } }),
      github,
    );
    expect(next.nextCursors).toEqual({ "github.com acme/api": "c2", "linear.app eng": "l1" });
    expect(next.errors).toEqual([failure]);
    const done = continueIssuePage(
      next,
      answer({}),
      issueCursorsForHost(next.nextCursors, "github.com"),
    );
    expect(done.nextCursors).toEqual({ "linear.app eng": "l1" });
  });
});

describe("issueFilterScopes", () => {
  const tracker = (overrides: Partial<IssueTrackerSummary>): IssueTrackerSummary =>
    ({
      tracker: "linear",
      host: "linear.app",
      projectCount: 1,
      capabilities: { labels: true, assignees: true },
      configured: true,
      detail: null,
      ...overrides,
    }) as IssueTrackerSummary;
  const linearRow = entry({
    key: "ENG-1",
    tracker: "linear" as IssueTrackerKind,
    host: "linear.app",
    scope: "ENG",
  });

  it("offers a bound standalone tracker's scope, named by the rows it listed", () => {
    const held = new Map([
      [
        environmentId,
        hold(
          answer({
            trackers: [tracker({})],
            entries: [linearRow, { ...linearRow, key: "ENG-2" }],
          }),
        ),
      ],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([
      {
        environmentId,
        input: { projectId: api, tracker: "linear", host: "linear.app", scope: "ENG" },
      },
    ]);
  });

  it("offers a bound tracker's scope the answer names when a search matches nothing", () => {
    const scope = {
      projectId: api,
      tracker: "linear" as IssueTrackerKind,
      host: "linear.app",
      scope: "ENG",
    };
    const held = new Map([
      [environmentId, hold(answer({ trackers: [tracker({})], entries: [], scopes: [scope] }))],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([{ environmentId, input: scope }]);
  });

  it("skips a tracker that cannot be read", () => {
    const held = new Map([
      [
        environmentId,
        hold(answer({ trackers: [tracker({ configured: false })], entries: [linearRow] })),
      ],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([]);
  });
});

describe("groupIssues", () => {
  it("shows a scoped failure even when that tracker host has no group", () => {
    const github: IssueTrackerSummary = {
      tracker: "github" as IssueTrackerKind,
      host: "github.com",
      projectCount: 1,
      capabilities: null,
      configured: true,
      detail: null,
    };
    const error = {
      projectId: api,
      projectTitle: "api",
      message: "GitLab failed",
      cursorKey: "gitlab.com acme/api",
    };
    const held = holdIssuePages(
      [[environmentId, answer({ trackers: [github], errors: [error] })]],
      new Map(),
      listing,
    );

    expect(groupIssues(held, "", [])[0]?.errors.map(({ message }) => message)).toEqual([
      "GitLab failed",
    ]);
  });

  it("lists an issue once when two environments hold the same repository", () => {
    const github = {
      tracker: "github",
      host: "github.com",
      projectCount: 1,
      capabilities: { labels: true, assignees: true },
      configured: true,
      detail: null,
    } as IssueTrackerSummary;
    const page = answer({
      trackers: [github],
      entries: [entry({ key: "1" }), entry({ key: "2" })],
    });
    const held = holdIssuePages(
      [
        [environmentId, page],
        [
          "env-2" as EnvironmentId,
          answer({
            ...page,
            entries: page.entries.map((row) => ({ ...row, projectId: "other" as ProjectId })),
          }),
        ],
      ],
      new Map(),
      listing,
    );
    const [group] = groupIssues(held, "", []);
    expect(group!.rows.map((row) => row.displayKey)).toEqual(["#1", "#2"]);
  });

  it("keeps same-keyed issues from two Linear workspaces apart", () => {
    const linear = {
      tracker: "linear",
      host: "linear.app",
      projectCount: 1,
      capabilities: { labels: true, assignees: true },
      configured: true,
      detail: null,
    } as IssueTrackerSummary;
    const inWorkspace = (workspace: string) =>
      answer({
        trackers: [linear],
        entries: [
          entry({
            tracker: "linear" as IssueTrackerKind,
            host: "linear.app",
            scope: "ENG",
            key: "ENG-1",
            url: `https://linear.app/${workspace}/issue/ENG-1`,
          }),
        ],
      });
    const held = holdIssuePages(
      [
        [environmentId, inWorkspace("acme")],
        ["env-2" as EnvironmentId, inWorkspace("globex")],
      ],
      new Map(),
      listing,
    );
    const [group] = groupIssues(held, "", []);
    expect(group!.rows.map((row) => row.url)).toEqual([
      "https://linear.app/acme/issue/ENG-1",
      "https://linear.app/globex/issue/ENG-1",
    ]);
  });
});
