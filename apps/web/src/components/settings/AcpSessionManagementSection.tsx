import type {
  AcpRegistrySession,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface AcpSessionProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The ACP operation failed.",
  });
}

export function AcpSessionManagementSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly projects: ReadonlyArray<AcpSessionProject>;
  readonly readOnly: boolean;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  const [sessions, setSessions] = useState<ReadonlyArray<AcpRegistrySession>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const listSessions = useAtomCommand(serverEnvironment.listAcpRegistrySessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAcpRegistrySession, {
    reportFailure: false,
  });
  const logout = useAtomCommand(serverEnvironment.logoutAcpRegistry, { reportFailure: false });
  const canList = props.provider.nativeSessions?.canList === true;
  const canImport =
    props.provider.nativeSessions?.canLoad === true ||
    props.provider.nativeSessions?.canResume === true;
  const canLogout = props.provider.auth.canLogout === true;

  if (!canList && !canLogout) return null;

  const loadSessions = async (cursor?: string) => {
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    setLoading(false);
    if (result._tag === "Success") {
      setSessions((current) =>
        cursor === undefined ? result.value.sessions : [...current, ...result.value.sessions],
      );
      setNextCursor(result.value.nextCursor);
      return;
    }
    reportFailure("Could not list ACP sessions", result);
  };

  const importNativeSession = async (session: AcpRegistrySession) => {
    if (projectId === null || importingSessionId !== null) return;
    setImportingSessionId(session.sessionId);
    const result = await importSession({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    setImportingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.sessionId === session.sessionId
            ? { ...candidate, importedThreadId: result.value.threadId }
            : candidate,
        ),
      );
      toastManager.add({
        type: "success",
        title: result.value.imported ? "ACP session imported" : "ACP session already imported",
      });
      return;
    }
    reportFailure("Could not import ACP session", result);
  };

  const logoutProvider = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    const result = await logout({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    setLoggingOut(false);
    if (result._tag === "Success") {
      setSessions([]);
      setNextCursor(null);
      toastManager.add({ type: "success", title: "Logged out of ACP agent" });
      return;
    }
    reportFailure("Could not log out of ACP agent", result);
  };

  return (
    <div className="grid gap-3 border-t border-border/60 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-foreground">Native sessions</p>
          <p className="text-xs text-muted-foreground">
            Resume agent-owned conversations as T3 threads.
          </p>
        </div>
        {canLogout ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={props.readOnly || loggingOut}
            onClick={() => void logoutProvider()}
          >
            {loggingOut ? "Logging out" : "Log out"}
          </Button>
        ) : null}
      </div>

      {canList ? (
        props.projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add a project on this device before importing native sessions.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={projectId ?? ""}
                disabled={props.readOnly || loading}
                onChange={(event) => {
                  setProjectId(event.target.value as ProjectId);
                  setSessions([]);
                  setNextCursor(null);
                }}
                className="h-8 min-w-48 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                aria-label="Project for ACP sessions"
              >
                {props.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={props.readOnly || loading || projectId === null}
                onClick={() => void loadSessions()}
              >
                {loading ? "Loading" : sessions.length === 0 ? "List sessions" : "Refresh"}
              </Button>
            </div>

            {sessions.length > 0 ? (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {sessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex min-w-0 items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-foreground">
                        {session.title ?? session.sessionId}
                      </p>
                      <code className="block truncate text-[10px] text-muted-foreground">
                        {session.sessionId}
                      </code>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      disabled={
                        props.readOnly ||
                        !canImport ||
                        session.importedThreadId !== null ||
                        importingSessionId !== null
                      }
                      onClick={() => void importNativeSession(session)}
                    >
                      {session.importedThreadId !== null
                        ? "Imported"
                        : importingSessionId === session.sessionId
                          ? "Importing"
                          : "Import"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            {nextCursor !== null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                className="w-fit"
                disabled={props.readOnly || loading}
                onClick={() => void loadSessions(nextCursor)}
              >
                {loading ? "Loading" : "Load more"}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
