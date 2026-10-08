// @effect-diagnostics nodeBuiltinImport:off -- Native HTTP fixtures verify the production fetch client's redirect behavior.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttp from "node:http";
import {
  HttpClient,
  FetchHttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as ManagedMcpHttp from "./ManagedMcpHttp.ts";

const SOURCE = "http://t3.test/mcp/managed/server";
const UPSTREAM = "https://mcp.test/mcp";
const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<{ server: NodeHttp.Server; url: string }>((resolve, reject) => {
          const server = NodeHttp.createServer(handler);
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string")
              return reject(new ManagedMcpHttp.ManagedMcpHttpError({ reason: "upstream" }));
            resolve({ server, url: `http://127.0.0.1:${address.port}` });
          });
        }),
      catch: (cause) => new ManagedMcpHttp.ManagedMcpHttpError({ reason: "upstream", cause }),
    }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
const fixture = (
  reply: (request: HttpClientRequest.HttpClientRequest, signal: AbortSignal) => Response,
) =>
  ManagedMcpHttp.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, signal) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, reply(request, signal))),
        ),
      ),
    ),
  );

it.effect(
  "the production fetch client rejects redirects before credentials or opaque bodies reach another endpoint",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let redirectedRequests = 0;
        let resourceRequests = 0;
        let redirectStatus = 307;
        const destination = yield* listen((request, response) => {
          redirectedRequests += 1;
          request.resume();
          response.end("unexpected redirected request");
        });
        const resource = yield* listen((request, response) => {
          resourceRequests += 1;
          request.resume();
          response.writeHead(redirectStatus, { location: `${destination.url}/collect` });
          response.end();
        });
        yield* Effect.gen(function* () {
          const service = yield* ManagedMcpHttp.ManagedMcpHttp;
          for (const status of [302, 307]) {
            redirectStatus = status;
            const result = yield* service
              .forward({
                url: `${resource.url}/mcp`,
                headers: { "x-api-key": "resource-only-secret" },
                request: HttpServerRequest.fromWeb(
                  new Request(SOURCE, {
                    method: "POST",
                    body: '{"method":"tools/call","params":{"private":"opaque-body"}}',
                    headers: { "content-type": "application/json" },
                  }),
                ),
                accessToken: Effect.succeed("oauth-secret"),
                refreshToken: () => Effect.die("unexpected refresh"),
                validate: Effect.void,
              })
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") expect(result.failure.reason).toBe("upstream-redirect");
          }
          expect(resourceRequests).toBe(2);
          expect(redirectedRequests).toBe(0);
        }).pipe(Effect.provide(ManagedMcpHttp.layer.pipe(Layer.provide(FetchHttpClient.layer))));
      }),
    ),
);

it.effect(
  "forwards opaque SSE, protocol headers and identical request bodies through one token refresh",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        let refreshes = 0;
        let validated = 0;
        let aborted = 0;
        const layer = fixture((request, signal) => {
          requests.push(request);
          signal.addEventListener("abort", () => {
            aborted += 1;
          });
          if (requests.length === 1) return new Response("expired", { status: 401 });
          return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "upstream-session",
              "mcp-protocol-version": "2025-11-25",
              "set-cookie": "upstream-secret=never-forward",
              authorization: "Bearer never-forward",
              connection: "x-private",
              "x-private": "never-forward",
            },
          });
        });
        yield* Effect.gen(function* () {
          const service = yield* ManagedMcpHttp.ManagedMcpHttp;
          const response = yield* service.forward({
            url: UPSTREAM,
            headers: { "x-api-version": "2" },
            request: HttpServerRequest.fromWeb(
              new Request(SOURCE, {
                method: "POST",
                body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
                headers: {
                  authorization: "Bearer t3-secret",
                  cookie: "browser-secret=never-forward",
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                  "mcp-protocol-version": "2025-11-25",
                  "mcp-session-id": "upstream-session",
                },
              }),
            ),
            accessToken: Effect.succeed("stale"),
            refreshToken: (rejected) =>
              Effect.sync(() => {
                expect(rejected).toBe("stale");
                refreshes += 1;
                return "replacement";
              }),
            validate: Effect.sync(() => {
              validated += 1;
            }),
          });
          const web = HttpServerResponse.toWeb(response);
          expect(web.headers.get("mcp-session-id")).toBe("upstream-session");
          expect(web.headers.get("set-cookie")).toBeNull();
          expect(web.headers.get("authorization")).toBeNull();
          expect(web.headers.get("x-private")).toBeNull();
          expect(yield* Effect.promise(() => web.text())).toBe(
            'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
          );
          expect(requests.map((request) => request.headers.authorization)).toEqual([
            "Bearer stale",
            "Bearer replacement",
          ]);
          expect(requests.map((request) => request.url)).toEqual([UPSTREAM, UPSTREAM]);
          expect(
            requests.map((request) =>
              request.body._tag === "Uint8Array"
                ? new TextDecoder().decode(request.body.body)
                : undefined,
            ),
          ).toEqual([
            '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
            '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          ]);
          expect(requests[1]?.headers.cookie).toBeUndefined();
          expect(requests[1]?.headers["mcp-session-id"]).toBe("upstream-session");
          expect(requests[1]?.headers["x-api-version"]).toBe("2");
          expect(refreshes).toBe(1);
          expect(validated).toBeGreaterThanOrEqual(2);
          expect(aborted).toBe(2);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "forwards GET resumptions immediately and aborts the upstream stream when the client disconnects",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let upstreamAborted = false;
        const layer = fixture((request, signal) => {
          expect(request.method).toBe("GET");
          expect(request.headers["last-event-id"]).toBe("event-7");
          signal.addEventListener("abort", () => {
            upstreamAborted = true;
          });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* ManagedMcpHttp.ManagedMcpHttp;
          const response = yield* service.forward({
            url: UPSTREAM,
            request: HttpServerRequest.fromWeb(
              new Request(SOURCE, { headers: { "last-event-id": "event-7" } }),
            ),
            accessToken: Effect.succeed("token"),
            refreshToken: () => Effect.die("not rejected"),
            validate: Effect.void,
          });
          const reader = HttpServerResponse.toWeb(response).body!.getReader();
          const first = yield* Effect.promise(() => reader.read());
          expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
          expect(upstreamAborted).toBe(false);
          yield* Effect.promise(() => reader.cancel());
          expect(upstreamAborted).toBe(true);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("stops after a second rejection and refuses to send credentials through redirects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const status of [401, 307]) {
        let sent = 0;
        let refreshed = 0;
        const layer = fixture(() => {
          sent += 1;
          return new Response(null, { status, headers: { location: "https://other.test/mcp" } });
        });
        yield* Effect.gen(function* () {
          const service = yield* ManagedMcpHttp.ManagedMcpHttp;
          const result = yield* service
            .forward({
              url: UPSTREAM,
              request: HttpServerRequest.fromWeb(new Request(SOURCE)),
              accessToken: Effect.succeed("token"),
              refreshToken: () =>
                Effect.sync(() => {
                  refreshed += 1;
                  return "new-token";
                }),
              validate: Effect.void,
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.reason).toBe(
              status === 401 ? "upstream-auth" : "upstream-redirect",
            );
          expect(sent).toBe(status === 401 ? 2 : 1);
          expect(refreshed).toBe(status === 401 ? 1 : 0);
        }).pipe(Effect.provide(layer));
      }
    }),
  ),
);

it.effect("rejects disabled assignments and oversized requests before forwarding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let sent = 0;
      const layer = fixture(() => {
        sent += 1;
        return new Response("should not send");
      });
      yield* Effect.gen(function* () {
        const service = yield* ManagedMcpHttp.ManagedMcpHttp;
        for (const disabled of [true, false]) {
          const result = yield* service
            .forward({
              url: UPSTREAM,
              request: HttpServerRequest.fromWeb(
                new Request(SOURCE, { method: "POST", body: new Uint8Array(5 * 1024 * 1024) }),
              ),
              accessToken: Effect.succeed("token"),
              refreshToken: () => Effect.die("unused"),
              validate: disabled
                ? Effect.fail(new ManagedMcpHttp.ManagedMcpHttpError({ reason: "not-allowed" }))
                : Effect.void,
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.reason).toBe(disabled ? "not-allowed" : "body-too-large");
        }
        expect(sent).toBe(0);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
