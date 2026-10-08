import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { McpManagement } from "./McpManagement.ts";

/** Provider-session authentication and OAuth refresh live in the shared service. */
const layerForward = HttpRouter.add(
  "*",
  "/mcp/managed/:id",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const route = yield* HttpRouter.RouteContext;
    const management = yield* McpManagement;
    return yield* management.forward(route.params.id ?? "", request).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: error._tag, message: error.message },
            {
              status:
                error._tag === "McpOAuthClientError"
                  ? 503
                  : error.reason === "not-allowed"
                    ? 403
                    : error.reason === "body-too-large"
                      ? 413
                      : 502,
              headers: { "cache-control": "no-store" },
            },
          ),
        ),
      ),
    );
  }),
);

// A started OAuth flow's random state authorizes only its own redirect exchange.
// Use the registered URI inside the service, because relay hosts can differ here.
const layerCallback = HttpRouter.add(
  "GET",
  "/oauth/managed-mcp/callback",
  HttpMiddleware.withLoggerDisabled(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const management = yield* McpManagement;
      const params = new URL(request.url, "http://callback").searchParams;
      const id = params.get("id");
      const state = params.get("state");
      if (
        !id ||
        !state ||
        ["id", "state", "code", "error", "iss"].some((key) => params.getAll(key).length > 1)
      )
        return HttpServerResponse.text(
          "This MCP sign-in is invalid. Return to T3 Code and try again.",
          {
            status: 400,
            headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
          },
        );
      return yield* management
        .completeOAuthRedirect({
          id,
          state,
          ...(params.get("code") ? { code: params.get("code")! } : {}),
          ...(params.get("error") ? { error: params.get("error")! } : {}),
          ...(params.has("iss") ? { iss: params.get("iss")! } : {}),
        })
        .pipe(
          Effect.as(
            HttpServerResponse.text(
              "MCP sign-in complete. You can close this window and return to T3 Code.",
              { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
            ),
          ),
          Effect.catch(() =>
            Effect.succeed(
              HttpServerResponse.text(
                "MCP sign-in could not be completed. Return to T3 Code and try again.",
                {
                  status: 400,
                  headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
                },
              ),
            ),
          ),
        );
    }),
  ),
);

export const layer = Layer.merge(layerForward, layerCallback);
