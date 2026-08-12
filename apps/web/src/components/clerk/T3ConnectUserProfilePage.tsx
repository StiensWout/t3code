import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { ServerIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "../../cloud/managedRelayState";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? "Link date unavailable"
    : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

function T3ConnectEnvironmentRow(props: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly mutationPending: boolean;
  readonly onDeregister: (environment: RelayClientEnvironmentRecord) => void;
}) {
  const { environment } = props;
  return (
    <li className="flex items-center gap-4 border-t py-4 first:border-t-0">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium text-foreground">{environment.label}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {linkedAtLabel(environment.linkedAt)} · {endpointLabel(environment)}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button size="sm" variant="destructive-outline" disabled={props.mutationPending}>
              Deregister
            </Button>
          }
        />
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Deregister “{environment.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes this server’s T3 Connect access, removes any managed tunnel, and frees a
              host space. Local connections on your devices are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
            <AlertDialogClose
              render={
                <Button variant="destructive" onClick={() => props.onDeregister(environment)}>
                  Deregister server
                </Button>
              }
            />
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

export function T3ConnectUserProfilePage() {
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const mutationPendingRef = useRef(false);
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      environmentsState.refresh();
      toastManager.add({
        type: "success",
        title: "Server deregistered",
        description: "T3 Connect access was revoked and a host space is now available.",
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    toastManager.add({
      type: "error",
      title: "Could not deregister server",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);

  return (
    <div className="flex min-h-[30rem] w-full flex-col bg-background text-foreground">
      <header className="flex flex-col gap-4 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-[-0.01em]">T3 Connect</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Environments registered to your account. Connections on this device are managed in
            Settings.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={environmentsState.isPending || deregisteringEnvironmentId !== null}
          onClick={environmentsState.refresh}
        >
          {environmentsState.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      <div className="flex-1 p-6">
        {environmentsState.error ? (
          <div className="mb-4 border-y border-destructive/35 py-3 text-sm" role="alert">
            <p className="font-medium text-destructive-foreground">
              Could not load T3 Connect environments
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{environmentsState.error}</p>
          </div>
        ) : null}

        {isInitialLoad ? (
          <p className="py-6 text-sm text-muted-foreground" role="status">
            Loading environments…
          </p>
        ) : environments.length > 0 ? (
          <ul>
            {environments.map((environment) => (
              <T3ConnectEnvironmentRow
                key={environment.environmentId}
                environment={environment}
                mutationPending={deregisteringEnvironmentId !== null}
                onDeregister={(selected) => void handleDeregister(selected)}
              />
            ))}
          </ul>
        ) : environmentsState.error ? null : (
          <Empty className="min-h-72 border-y">
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No T3 Connect environments</EmptyTitle>
              <EmptyDescription>
                Link an environment from its local Settings to make it available through T3 Connect.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
