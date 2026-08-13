import { describe, expect, it } from "@effect/vitest";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("exposes ACP Registry search and lifecycle methods", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(
      expect.arrayContaining([
        WS_METHODS.serverSearchAcpRegistry,
        WS_METHODS.serverPrepareAcpRegistryAgent,
        WS_METHODS.serverUninstallAcpRegistryManagedBinary,
      ]),
    );
  });
});
