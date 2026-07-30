import { useEffect } from "react";

import { useServerConfigs } from "../state/entities";
import { reconcilePendingServerUpdates, usePendingServerUpdates } from "../state/serverUpdate";

export function ServerUpdateStateCoordinator() {
  const serverConfigs = useServerConfigs();
  const pendingServerUpdates = usePendingServerUpdates();

  useEffect(() => {
    reconcilePendingServerUpdates(serverConfigs);
  }, [pendingServerUpdates, serverConfigs]);

  return null;
}
