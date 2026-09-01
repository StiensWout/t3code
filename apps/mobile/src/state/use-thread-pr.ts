import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createLinkedPullRequestDetailAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@t3tools/client-runtime/state/pull-requests";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { presentThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";
import { vcsEnvironment } from "./vcs";

const linkedPullRequestDetailAtom = createLinkedPullRequestDetailAtomFamily(connectionAtomRuntime);
const threadPrSnapshotAtoms = Atom.family((key: string) =>
  Atom.make<ThreadPrPresentation | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:thread-pr-snapshot:${key}`),
  ),
);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

/**
 * Live PR status for a thread's branch. Subscriptions are deduplicated per
 * (environmentId, cwd) by the atom family, so many rows on the same worktree
 * or project root share one stream — and virtualization means only visible
 * rows subscribe at all.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  projectCwd: string | null,
): ThreadPrPresentation | null {
  const cwd = thread.worktreePath ?? projectCwd;
  const snapshotKey = JSON.stringify([
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    thread.linkedPullRequest ?? { branch: thread.branch, cwd },
  ]);
  const snapshotAtom = useMemo(() => threadPrSnapshotAtoms(snapshotKey), [snapshotKey]);
  const snapshot = useAtomValue(snapshotAtom);
  const gitStatus = useEnvironmentQuery(
    thread.linkedPullRequest == null && thread.branch !== null && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd },
        })
      : null,
  );
  const linkedPullRequest = useEnvironmentQuery(
    thread.linkedPullRequest == null
      ? null
      : linkedPullRequestDetailAtom({
          environmentId: thread.environmentId,
          input: {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            number: thread.linkedPullRequest.number,
          },
        }),
  );

  const live = useMemo<ThreadPrPresentation | null | undefined>(() => {
    if (thread.linkedPullRequest != null) {
      const detail = linkedPullRequest.data;
      return detail === null
        ? undefined
        : presentThreadPr(pullRequestDetailToVcsStatus(detail), {
            kind: detail.provider,
            name: detail.provider,
            baseUrl: "",
          });
    }

    const status = gitStatus.data;
    if (thread.branch === null) return null;
    if (status === null) return undefined;
    if (status.refName !== thread.branch || !status.pr) return null;
    return presentThreadPr(status.pr, status.sourceControlProvider);
  }, [gitStatus.data, linkedPullRequest.data, thread.branch, thread.linkedPullRequest]);

  useEffect(() => {
    if (live !== undefined && snapshot !== live) appAtomRegistry.set(snapshotAtom, live);
  }, [live, snapshot, snapshotAtom]);

  return live === undefined ? snapshot : live;
}
