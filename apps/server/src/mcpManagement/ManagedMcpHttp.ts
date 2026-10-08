import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import type * as McpOAuthClient from "./McpOAuthClient.ts";

export class ManagedMcpHttpError extends Schema.TaggedError<ManagedMcpHttpError>()(
  "ManagedMcpHttpError",
  {
    reason: Schema.Literals([
      "not-allowed",
      "body-too-large",
      "request",
      "upstream",
      "upstream-auth",
      "upstream-redirect",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-allowed":
        return "This MCP server is disabled for this provider session.";
      case "body-too-large":
        return "The MCP request is too large.";
      case "request":
        return "Could not read the MCP request.";
      case "upstream-auth":
        return "The MCP server rejected its sign-in credentials. Sign in again.";
      case "upstream-redirect":
        return "The MCP endpoint redirected the request. Update its server URL.";
      case "upstream":
        return "Could not connect to the MCP server.";
    }
  }
}

type ForwardError = ManagedMcpHttpError | McpOAuthClient.McpOAuthClientError;

export class ManagedMcpHttp extends Context.Service<
  ManagedMcpHttp,
  {
    readonly forward: (input: {
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly accessToken: Effect.Effect<string, ForwardError>;
      readonly refreshToken: (rejectedToken: string) => Effect.Effect<string, ForwardError>;
      /** Rechecks the session credential, catalog identity, and assignment before each request. */
      readonly validate: Effect.Effect<void, ForwardError>;
    }) => Effect.Effect<HttpServerResponse.HttpServerResponse, ForwardError, Scope.Scope>;
  }
>()("t3/mcpManagement/ManagedMcpHttp") {}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const FORWARDED_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "authorization",
  "proxy-authenticate",
  "proxy-authorization",
  "www-authenticate",
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "upgrade",
  "trailer",
  "te",
  "location",
]);

/** For OAuth MCPs only, forwards opaque HTTP and SSE while T3 owns token refresh. */
const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);

  const forward: ManagedMcpHttp["Service"]["forward"] = Effect.fn("ManagedMcpHttp.forward")(
    function* (input) {
      yield* input.validate;
      if (!["POST", "GET", "DELETE"].includes(input.request.method))
        return yield* new ManagedMcpHttpError({ reason: "not-allowed" });
      const body =
        input.request.method === "GET"
          ? undefined
          : yield* input.request.stream.pipe(
              Stream.mapError((cause) => new ManagedMcpHttpError({ reason: "request", cause })),
              Stream.runFoldEffect(
                () => ({ chunks: [] as Uint8Array[], length: 0 }),
                (acc, chunk) => {
                  if (acc.length + chunk.byteLength > MAX_REQUEST_BYTES)
                    return Effect.fail(new ManagedMcpHttpError({ reason: "body-too-large" }));
                  acc.chunks.push(chunk);
                  acc.length += chunk.byteLength;
                  return Effect.succeed(acc);
                },
              ),
              Effect.map(({ chunks, length }) => {
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                return bytes;
              }),
            );
      const configured = new Headers(input.headers);
      for (const [name, value] of Object.entries(input.request.headers)) {
        if (value !== undefined && FORWARDED_HEADERS.has(name)) configured.set(name, value);
      }
      configured.delete("host");
      configured.delete("content-length");
      configured.delete("connection");

      const send = Effect.fnUntraced(function* (token: string) {
        yield* input.validate;
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        const headers = new Headers(configured);
        headers.set("authorization", `Bearer ${token}`);
        const request = HttpClientRequest.make(input.request.method)(input.url).pipe(
          HttpClientRequest.setHeaders(headers),
          body === undefined
            ? (self) => self
            : HttpClientRequest.bodyUint8Array(body, headers.get("content-type") ?? undefined),
        );
        const response = yield* http.execute(request).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          // MCP URLs and custom headers can contain secrets beyond the standard Authorization header.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError((cause) => new ManagedMcpHttpError({ reason: "upstream", cause })),
        );
        return { response, scope };
      });

      const token = yield* input.accessToken;
      let upstream = yield* send(token);
      if (upstream.response.status === 401) {
        yield* Scope.close(upstream.scope, Exit.void);
        yield* input.validate;
        const refreshed = yield* input.refreshToken(token);
        upstream = yield* send(refreshed);
      }
      if (upstream.response.status === 401) {
        yield* Scope.close(upstream.scope, Exit.void);
        return yield* new ManagedMcpHttpError({ reason: "upstream-auth" });
      }
      if (upstream.response.status >= 300 && upstream.response.status < 400) {
        yield* Scope.close(upstream.scope, Exit.void);
        return yield* new ManagedMcpHttpError({ reason: "upstream-redirect" });
      }
      const headers: Record<string, string> = {};
      const connectionHeaders = new Set(
        (upstream.response.headers.connection ?? "")
          .toLowerCase()
          .split(",")
          .map((name) => name.trim()),
      );
      for (const [name, value] of Object.entries(upstream.response.headers)) {
        if (
          value !== undefined &&
          !DROPPED_RESPONSE_HEADERS.has(name) &&
          !connectionHeaders.has(name)
        )
          headers[name] = value;
      }
      headers["cache-control"] = "no-store, no-transform";
      const responseScope = upstream.scope;
      return HttpServerResponse.stream(
        upstream.response.stream.pipe(Stream.ensuring(Scope.close(responseScope, Exit.void))),
        {
          status: upstream.response.status,
          headers,
          ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
        },
      );
    },
  );

  return ManagedMcpHttp.of({ forward });
});

export const layer = Layer.effect(ManagedMcpHttp, make);
