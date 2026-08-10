import type {
  DesktopNotificationShowInput,
  DesktopNotificationShowResult,
  DesktopNotificationTarget,
} from "@t3tools/contracts";
import {
  formatAgentNotificationContent,
  formatAgentNotificationTestContent,
} from "@t3tools/shared/agentAwareness";

const DELIVERY_STORAGE_KEY = "t3code:browser-notification-deliveries:v1";
const DELIVERY_LOCK_NAME = "t3code:browser-notification-delivery";
const DELIVERY_RECORD_TTL_MS = 5 * 60_000;
const MAX_DELIVERY_RECORDS = 100;

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

interface BrowserNotificationInstance {
  addEventListener: (type: "click" | "close", listener: () => void) => void;
  close: () => void;
}

interface BrowserNotificationApi {
  readonly permission: NotificationPermission;
  readonly requestPermission: () => Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): BrowserNotificationInstance;
}

interface DeliveryClaimDependencies {
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly now: () => number;
  readonly withLock: <A>(effect: () => Promise<A>) => Promise<A>;
}

const activeNotifications = new Map<string, BrowserNotificationInstance>();

function resolveBrowserNotificationApi(): BrowserNotificationApi | null {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    typeof window.Notification === "undefined"
  ) {
    return null;
  }
  return window.Notification;
}

function deliveryClaimDependencies(): DeliveryClaimDependencies | null {
  if (typeof window === "undefined" || window.navigator.locks === undefined) {
    return null;
  }

  try {
    const storage = window.localStorage;
    const withLock: DeliveryClaimDependencies["withLock"] = (effect) =>
      window.navigator.locks.request(DELIVERY_LOCK_NAME, effect);
    return { storage, now: Date.now, withLock };
  } catch {
    return null;
  }
}

function readDeliveryRecords(storage: Pick<Storage, "getItem">): Record<string, number> {
  try {
    const raw = storage.getItem(DELIVERY_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

function trimDeliveryRecords(records: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(records)
      .filter(([, deliveredAt]) => now - deliveredAt <= DELIVERY_RECORD_TTL_MS)
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, MAX_DELIVERY_RECORDS),
  );
}

export function browserNotificationDeliveryKey(
  input: Pick<DesktopNotificationShowInput, "environmentId" | "threadId" | "event"> & {
    readonly updatedAt: string;
  },
): string {
  return JSON.stringify([input.environmentId, input.threadId, input.event, input.updatedAt]);
}

export async function claimBrowserNotificationDelivery(
  key: string,
  dependencies: DeliveryClaimDependencies | null = deliveryClaimDependencies(),
): Promise<boolean> {
  if (dependencies === null) {
    return false;
  }

  return dependencies.withLock(async () => {
    const now = dependencies.now();
    const records = trimDeliveryRecords(readDeliveryRecords(dependencies.storage), now);
    if (records[key] !== undefined) {
      return false;
    }
    records[key] = now;
    try {
      dependencies.storage.setItem(
        DELIVERY_STORAGE_KEY,
        JSON.stringify(trimDeliveryRecords(records, now)),
      );
      return true;
    } catch {
      return false;
    }
  });
}

export function getBrowserNotificationPermission(
  api?: BrowserNotificationApi | null,
): BrowserNotificationPermission {
  const resolvedApi = api === undefined ? resolveBrowserNotificationApi() : api;
  if (resolvedApi === null || (api === undefined && deliveryClaimDependencies() === null)) {
    return "unsupported";
  }
  return resolvedApi.permission;
}

export async function requestBrowserNotificationPermission(
  api?: BrowserNotificationApi | null,
): Promise<BrowserNotificationPermission> {
  const resolvedApi = api === undefined ? resolveBrowserNotificationApi() : api;
  if (resolvedApi === null || (api === undefined && deliveryClaimDependencies() === null)) {
    return "unsupported";
  }
  return resolvedApi.requestPermission();
}

function notificationTag(target: DesktopNotificationTarget): string {
  return JSON.stringify([target.environmentId, target.threadId]);
}

function showBrowserNotification(input: {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly silent: boolean;
  readonly api?: BrowserNotificationApi | null;
  readonly onActivated?: () => void;
}): DesktopNotificationShowResult {
  const api = input.api === undefined ? resolveBrowserNotificationApi() : input.api;
  if (api === null) return "unsupported";
  if (api.permission !== "granted") return "suppressed";

  try {
    activeNotifications.get(input.tag)?.close();
    const notification = new api(input.title, {
      body: input.body,
      tag: input.tag,
      silent: input.silent,
    });
    activeNotifications.set(input.tag, notification);
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      input.onActivated?.();
    });
    notification.addEventListener("close", () => {
      if (activeNotifications.get(input.tag) === notification) {
        activeNotifications.delete(input.tag);
      }
    });
    return "shown";
  } catch {
    return "failed";
  }
}

export function showBrowserAgentNotification(
  input: DesktopNotificationShowInput,
  options?: {
    readonly api?: BrowserNotificationApi | null;
    readonly onActivated?: (target: DesktopNotificationTarget) => void;
  },
): DesktopNotificationShowResult {
  const content = formatAgentNotificationContent(input);
  return showBrowserNotification({
    ...content,
    tag: notificationTag(input),
    silent: input.silent,
    ...(options?.api === undefined ? {} : { api: options.api }),
    onActivated: () => options?.onActivated?.(input),
  });
}

export function showBrowserNotificationTest(input: {
  readonly silent: boolean;
  readonly api?: BrowserNotificationApi | null;
}): DesktopNotificationShowResult {
  const content = formatAgentNotificationTestContent();
  return showBrowserNotification({
    ...content,
    tag: "t3code:test",
    silent: input.silent,
    ...(input.api === undefined ? {} : { api: input.api }),
  });
}

export function dismissBrowserNotification(target: DesktopNotificationTarget): void {
  const tag = notificationTag(target);
  activeNotifications.get(tag)?.close();
  activeNotifications.delete(tag);
}

export function dismissAllBrowserNotifications(): void {
  for (const notification of activeNotifications.values()) {
    notification.close();
  }
  activeNotifications.clear();
}
