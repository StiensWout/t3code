import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopNotifications from "./DesktopNotifications.ts";

class FakeNativeNotification implements DesktopNotifications.NativeNotification {
  readonly listeners = new Map<"click" | "close", () => void>();
  shown = false;
  closed = false;

  show(): void {
    this.shown = true;
  }

  close(): void {
    this.closed = true;
    this.listeners.get("close")?.();
  }

  once(event: "click" | "close", listener: () => void): void {
    this.listeners.set(event, listener);
  }

  on(_event: "failed", _listener: (event: unknown, error: string) => void): void {}
}

function makeWindowLayer(onReveal: Effect.Effect<void>) {
  const sent: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isLoadingMainFrame: () => false,
      once: () => undefined,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  } as unknown as Electron.BrowserWindow;

  return {
    sent,
    layer: Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        createMain: Effect.succeed(window),
        ensureMain: Effect.succeed(window),
        revealOrCreateMain: onReveal.pipe(Effect.as(window)),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        zoomMain: () => Effect.void,
        syncAppearance: Effect.void,
      }),
    ),
  };
}

const input = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  event: "approval" as const,
  projectTitle: "t3code",
  threadTitle: "Fix failing CI",
  showContext: true,
  silent: false,
};

describe("DesktopNotifications", () => {
  it.effect("passes shared copy to the native adapter and replaces a thread notification", () =>
    Effect.gen(function* () {
      const created: Array<{
        readonly options: DesktopNotifications.NativeNotificationOptions;
        readonly notification: FakeNativeNotification;
      }> = [];
      const platform: DesktopNotifications.DesktopNotificationPlatform = {
        isSupported: () => true,
        create: (options) => {
          const notification = new FakeNativeNotification();
          created.push({ options, notification });
          return notification;
        },
      };
      const window = makeWindowLayer(Effect.void);

      yield* Effect.gen(function* () {
        const notifications = yield* DesktopNotifications.DesktopNotifications;
        expect(yield* notifications.show(input)).toBe("shown");
        expect(yield* notifications.show({ ...input, event: "failure" })).toBe("shown");
      }).pipe(
        Effect.provide(DesktopNotifications.layerTest(platform).pipe(Layer.provide(window.layer))),
        Effect.scoped,
      );

      expect(created[0]?.options).toEqual({
        title: "Approval needed",
        body: "Fix failing CI · t3code",
        silent: false,
        timeoutType: "default",
      });
      expect(created[0]?.notification.closed).toBe(true);
      expect(created[1]?.notification.shown).toBe(true);
    }),
  );

  it.effect("reveals the app and forwards the target when a notification is clicked", () =>
    Effect.gen(function* () {
      const revealed = yield* Deferred.make<void>();
      let notification: FakeNativeNotification | null = null;
      const platform: DesktopNotifications.DesktopNotificationPlatform = {
        isSupported: () => true,
        create: () => {
          notification = new FakeNativeNotification();
          return notification;
        },
      };
      const window = makeWindowLayer(Deferred.succeed(revealed, undefined));

      yield* Effect.gen(function* () {
        const notifications = yield* DesktopNotifications.DesktopNotifications;
        yield* notifications.show(input);
        notification?.listeners.get("click")?.();
        yield* Deferred.await(revealed);
      }).pipe(
        Effect.provide(DesktopNotifications.layerTest(platform).pipe(Layer.provide(window.layer))),
        Effect.scoped,
      );

      expect(window.sent[0]?.payload).toEqual({
        environmentId: input.environmentId,
        threadId: input.threadId,
      });
    }),
  );
});
