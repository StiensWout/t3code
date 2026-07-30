import { useEffect } from "react";

import { useServerConfigs } from "../state/entities";
import { useEnvironments } from "../state/environments";
import {
  clearPendingServerUpdate,
  reconcilePendingServerUpdates,
  usePendingServerUpdates,
} from "../state/serverUpdate";

const INTERRUPTED_UPDATE_SETTLE_MS = 1_000;

export function ServerUpdateStateCoordinator() {
  const serverConfigs = useServerConfigs();
  const pendingServerUpdates = usePendingServerUpdates();
  const { environments } = useEnvironments();

  useEffect(() => {
    reconcilePendingServerUpdates(serverConfigs);

    const interruptedConnectedUpdates = environments.flatMap((environment) => {
      const update = pendingServerUpdates.get(environment.environmentId);
      return update?.phase === "interrupted" && environment.connection.phase === "connected"
        ? [{ environmentId: environment.environmentId, attempt: update.attempt }]
        : [];
    });
    if (interruptedConnectedUpdates.length === 0) return;

    // A boot-service update interrupts its RPC as the socket closes. Give the
    // supervisor one turn to publish that disconnect before treating an
    // interrupt on an otherwise stable connection as client cancellation.
    const timeout = setTimeout(() => {
      for (const update of interruptedConnectedUpdates) {
        clearPendingServerUpdate(update.environmentId, update.attempt);
      }
    }, INTERRUPTED_UPDATE_SETTLE_MS);
    return () => clearTimeout(timeout);
  }, [environments, pendingServerUpdates, serverConfigs]);

  return null;
}
