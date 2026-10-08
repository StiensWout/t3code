import { EnvironmentId, ManagedMcpServerId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

interface McpAuthDelivery {
  environmentId: EnvironmentId;
  id: string;
  callbackUrl: string;
}
let pending: McpAuthDelivery | undefined;
const decodeEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);
const decodeServerId = Schema.decodeUnknownSync(ManagedMcpServerId);

/** Keep OAuth credentials out of router state and client telemetry. */
export function prepareMcpAuthDelivery() {
  const url = new URL(window.location.href);
  if (url.pathname !== "/auth/mcp-callback") return;
  try {
    const environmentId = decodeEnvironmentId(url.searchParams.get("environmentId"));
    const id = decodeServerId(url.searchParams.get("id"));
    if (url.searchParams.get("state")) {
      pending = { environmentId, id, callbackUrl: url.toString() };
    }
  } catch {
    pending = undefined;
  }
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  window.history.replaceState(window.history.state, "", url.toString());
}

export const pendingMcpAuthDelivery = () => pending;
export const clearMcpAuthDelivery = () => {
  pending = undefined;
};
