import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as McpManagement from "./McpManagement.ts";
import * as ManagedMcpHttp from "./ManagedMcpHttp.ts";
import * as McpOAuthClient from "./McpOAuthClient.ts";
import * as ManagedMcpRoutes from "./ManagedMcpRoutes.ts";

it.each([
  {
    name: "signed-out upstream",
    error: new McpOAuthClient.McpOAuthClientError({
      id: "example",
      operation: "token",
      reason: "not-authorized",
    }),
    status: 503,
  },
  {
    name: "invalid provider credential",
    error: new ManagedMcpHttp.ManagedMcpHttpError({ reason: "not-allowed" }),
    status: 403,
  },
])("rejects $name without offering T3 OAuth", async ({ error, status }) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    ManagedMcpRoutes.layer.pipe(
      Layer.provideMerge(
        Layer.mock(McpManagement.McpManagement)({ forward: () => Effect.fail(error) }),
      ),
    ),
    { disableLogger: true },
  );
  try {
    const response = await handler(
      new Request("http://t3.test/mcp/managed/example", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({ error: error._tag, message: error.message });
  } finally {
    await dispose();
  }
});
