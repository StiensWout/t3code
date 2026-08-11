import type { EnvironmentId, ProjectId, PullRequestListResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergePullRequestLists, pullRequestCursorsForEnvironment } from "./pullRequests";

const localEnvironmentId = "local" as EnvironmentId;
const remoteEnvironmentId = "remote" as EnvironmentId;

function result(title: string, cursor: string): PullRequestListResult {
  return {
    viewers: { "github.com": "octocat" },
    providers: [
      {
        host: "github.com",
        kind: "github",
        searchesOnHost: true,
        projectCount: 1,
        configured: true,
        detail: null,
      },
    ],
    entries: [
      {
        provider: "github",
        host: "github.com",
        projectId: "project-1" as ProjectId,
        projectTitle: title,
        repository: "acme/project",
        number: 1,
        title: "A pull request",
        url: "https://github.com/acme/project/pull/1",
        author: { login: "octocat", name: null, avatarUrl: null },
        headBranch: "feature",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        additions: 0,
        deletions: 0,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-02T00:00:00Z",
        viewerReviewRequested: false,
        labels: [],
      },
    ],
    errors: [],
    truncated: true,
    nextCursors: { "github.com acme/project": cursor },
  } satisfies PullRequestListResult;
}

describe("pull request aggregation across environments", () => {
  it("keeps rows and cursors scoped to their owning server", () => {
    const merged = mergePullRequestLists([
      { environmentId: localEnvironmentId, value: result("Local", "local-cursor") },
      { environmentId: remoteEnvironmentId, value: result("Remote", "remote-cursor") },
    ]);

    expect(merged.entries.map((entry) => entry.environmentId)).toEqual([
      localEnvironmentId,
      remoteEnvironmentId,
    ]);
    expect(Object.keys(merged.nextCursors)).toEqual([
      JSON.stringify([localEnvironmentId, "github.com acme/project"]),
      JSON.stringify([remoteEnvironmentId, "github.com acme/project"]),
    ]);
  });

  it("returns only the continuation that belongs to one server", () => {
    const cursors = {
      [JSON.stringify([localEnvironmentId, "github.com acme/project"])]: "local-cursor",
      [JSON.stringify([remoteEnvironmentId, "github.com acme/project"])]: "remote-cursor",
    };

    expect(pullRequestCursorsForEnvironment(remoteEnvironmentId, cursors)).toEqual({
      "github.com acme/project": "remote-cursor",
    });
    expect(pullRequestCursorsForEnvironment("other" as EnvironmentId, cursors)).toBeUndefined();
  });
});
