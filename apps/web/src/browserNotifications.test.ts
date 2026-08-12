import { type DesktopNotificationShowInput, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  browserNotificationDeliveryKey,
  deliverBrowserNotificationOnce,
  getBrowserNotificationPermission,
  showBrowserAgentNotification,
} from "./browserNotifications.ts";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static created: FakeNotification[] = [];

  readonly title: string;
  readonly options: NotificationOptions | undefined;
  private readonly listeners = new Map<string, Set<() => void>>();
  close = vi.fn(() => {
    for (const listener of this.listeners.get("close") ?? []) listener();
  });

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.created.push(this);
  }

  addEventListener(type: "click" | "close", listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
}

const input: DesktopNotificationShowInput = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  event: "approval",
  projectTitle: "t3code",
  threadTitle: "Fix browser notifications",
  showContext: true,
  silent: true,
};

describe("browser notification delivery", () => {
  it("uses the shared native notification copy and target tag", () => {
    FakeNotification.created = [];

    expect(
      showBrowserAgentNotification(input, {
        api: FakeNotification,
      }),
    ).toBe("shown");

    expect(FakeNotification.created).toHaveLength(1);
    expect(FakeNotification.created[0]).toMatchObject({
      title: "Approval needed",
      options: {
        body: "Fix browser notifications · t3code",
        silent: true,
        tag: '["env-1","thread-1"]',
      },
    });
  });

  it("uses the final response preview for completion notifications", () => {
    FakeNotification.created = [];

    showBrowserAgentNotification(
      {
        ...input,
        event: "completion",
        completionPreview: "Implemented the fix and the focused tests pass.",
      },
      { api: FakeNotification },
    );

    expect(FakeNotification.created[0]).toMatchObject({
      title: "Fix browser notifications",
      options: {
        body: "Implemented the fix and the focused tests pass.",
      },
    });
  });

  it("uses unambiguous tags when target ids contain separators", () => {
    FakeNotification.created = [];

    showBrowserAgentNotification(
      {
        ...input,
        environmentId: EnvironmentId.make("a:b"),
        threadId: ThreadId.make("c"),
      },
      { api: FakeNotification },
    );
    showBrowserAgentNotification(
      {
        ...input,
        environmentId: EnvironmentId.make("a"),
        threadId: ThreadId.make("b:c"),
      },
      { api: FakeNotification },
    );

    expect(FakeNotification.created.map((notification) => notification.options?.tag)).toEqual([
      '["a:b","c"]',
      '["a","b:c"]',
    ]);
  });

  it("suppresses delivery until browser permission is granted", () => {
    class PermissionDefaultNotification extends FakeNotification {
      static override permission: NotificationPermission = "default";
    }

    expect(
      showBrowserAgentNotification(input, {
        api: PermissionDefaultNotification,
      }),
    ).toBe("suppressed");
    expect(getBrowserNotificationPermission(PermissionDefaultNotification)).toBe("default");
  });

  it("delivers once per browser profile", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    let lock = Promise.resolve();
    const withLock = async <A>(effect: () => Promise<A>) => {
      const previous = lock;
      let release: () => void = () => undefined;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await effect();
      } finally {
        release();
      }
    };
    const dependencies = { storage, now: () => 1_000, withLock };
    const key = browserNotificationDeliveryKey({ ...input, version: "turn:turn-1" });

    await expect(
      Promise.all([
        deliverBrowserNotificationOnce(key, () => "shown", dependencies),
        deliverBrowserNotificationOnce(key, () => "shown", dependencies),
      ]),
    ).resolves.toEqual(["shown", "suppressed"]);
  });

  it("fails closed when profile storage is unavailable", async () => {
    await expect(deliverBrowserNotificationOnce("event", () => "shown", null)).resolves.toBe(
      "unsupported",
    );
  });

  it("releases a delivery reservation when showing fails", async () => {
    const values = new Map<string, string>();
    const dependencies = {
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      now: () => 1_000,
      withLock: async <A>(effect: () => Promise<A>) => effect(),
    };

    await expect(
      deliverBrowserNotificationOnce("event", () => "failed", dependencies),
    ).resolves.toBe("failed");
    await expect(
      deliverBrowserNotificationOnce("event", () => "shown", dependencies),
    ).resolves.toBe("shown");
  });
});
