/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Refreshing Issues keeps older rows already loaded",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    // Serve a stable two-page tracker through the list RPC; all other RPCs use the real server.
    await browser.addInitScript(() => {
      const scope = "demo/issues";
      const cursorKey = "github.com demo/issues";
      const timestamp = "2026-10-01T00:00:00.000Z";
      const row = (key: string, title: string, updatedAt: string) => ({
        projectId: "demo-project",
        projectTitle: "demo",
        tracker: "github",
        host: "github.com",
        scope,
        key,
        displayKey: `#${key}`,
        url: `https://github.com/${scope}/issues/${key}`,
        title,
        author: null,
        state: { category: "open", name: "Open" },
        createdAt: timestamp,
        updatedAt,
        closedAt: null,
        assignees: [],
        labels: [],
        commentCount: 0,
      });
      const reads = new WeakMap<WebSocket, Map<string, boolean>>();
      const rewritten = new WeakMap<Event, Event>();
      let refresh = false;
      window.addEventListener("scenario-refresh-issues", () => {
        refresh = true;
        const now = Date.now;
        // @effect-diagnostics-next-line globalDate:off -- The browser focus handler uses this clock.
        Date.now = () => now() + 11_000;
        try {
          window.dispatchEvent(new Event("focus"));
        } finally {
          Date.now = now;
        }
      });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const message of [JSON.parse(data)].flat()) {
            if (message?._tag !== "Request" || message.tag !== "issues.list") continue;
            let pending = reads.get(this);
            if (pending === undefined) {
              pending = new Map();
              reads.set(this, pending);
            }
            pending.set(String(message.id), message.payload.cursors?.[cursorKey] !== undefined);
          }
        }
        return send.call(this, data);
      };
      const addEventListener = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (
        this: WebSocket,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "message" || typeof listener !== "function") {
          return addEventListener.call(this, type, listener, options);
        }
        return addEventListener.call(
          this,
          type,
          (event) => {
            const prior = rewritten.get(event);
            if (prior !== undefined) return listener.call(this, prior);
            const data = (event as MessageEvent).data;
            const pending = reads.get(this);
            if (!pending?.size || typeof data !== "string") return listener.call(this, event);
            const parsed = JSON.parse(data);
            let changed = false;
            const messages = [parsed].flat().map((message) => {
              if (message._tag !== "Exit") return message;
              const id = String(message.requestId);
              const more = pending.get(id);
              if (more === undefined) return message;
              pending.delete(id);
              changed = true;
              return {
                ...message,
                exit: {
                  _tag: "Success",
                  value: {
                    viewers: {},
                    trackers: [
                      {
                        tracker: "github",
                        host: "github.com",
                        projectCount: 1,
                        configured: true,
                        detail: null,
                        capabilities: null,
                      },
                    ],
                    entries: [
                      more
                        ? row("1", "Older issue from page two", timestamp)
                        : row(
                            "2",
                            refresh ? "Refreshed first issue" : "First issue",
                            "2026-10-02T00:00:00.000Z",
                          ),
                    ],
                    errors: [],
                    nextCursors: more ? {} : { [cursorKey]: "second-page" },
                  },
                },
              };
            });
            if (!changed) return listener.call(this, event);
            const replacement = new MessageEvent("message", {
              data: JSON.stringify(Array.isArray(parsed) ? messages : messages[0]),
            });
            rewritten.set(event, replacement);
            return listener.call(this, replacement);
          },
          options,
        );
      } as typeof WebSocket.prototype.addEventListener;
    });

    await t3.open("/issues?host=github.com");
    await screen.getByRole("button", "Load more").tap();
    const older = screen.getByText("Older issue from page two");
    await older.waitFor();

    await browser.evaluate(() => {
      window.dispatchEvent(new Event("scenario-refresh-issues"));
      return null;
    });
    await screen.getByText("Refreshed first issue").waitFor();
    await app.screenshot("issues-after-focus-refresh");
    await expect(older).toBeVisible();
  },
);
