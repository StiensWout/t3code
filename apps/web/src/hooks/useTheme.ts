import type { DesktopBridge } from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  applyThemePalette,
  CUSTOM_THEMES_STORAGE_KEY,
  invalidateCustomThemes,
  isKnownThemePreference,
  isThemeFollowingSystem,
  resolveDesktopTheme,
  resolveThemeAppearance,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  ThemePreference,
} from "../themePalette";

type Theme = ThemePreference;
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
  followSystem: boolean;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  systemDark: false,
  followSystem: true,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedErrorClass<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedErrorClass<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let snapshotStale = true;
let lastDesktopTheme: "light" | "dark" | "system" | null = null;
let lastAppliedTheme: ThemeSnapshot | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

function readStoredFollowSystem(theme: Theme): boolean {
  if (typeof window === "undefined") return theme === "system" || isThemeFollowingSystem(theme);

  try {
    const raw = window.localStorage.getItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Fall back to the legacy theme value when the separate preference is unavailable.
  }

  return theme === "system" || isThemeFollowingSystem(theme);
}

function writeFollowSystemPreference(followSystem: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY, String(followSystem));
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_FOLLOW_SYSTEM_STORAGE_KEY,
      cause,
    });
  }
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw !== null && isKnownThemePreference(raw)) {
    return raw;
  }
  return DEFAULT_THEME_SNAPSHOT.theme;
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);
  const themeChromeColor = document.documentElement.dataset.themeId
    ? normalizeThemeColor(rootStyles.getPropertyValue("--app-chrome-background"))
    : null;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = themeChromeColor ?? surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  // Update every theme-color meta: the browser reads whichever media-scoped
  // element matches the OS, so mutating a single element is not enough.
  const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );
  if (themeColorMetas.length === 0) {
    ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
    return;
  }
  for (const element of themeColorMetas) {
    element.setAttribute("content", backgroundColor);
  }
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const followSystem = readStoredFollowSystem(theme);
  const systemDark = followSystem ? getSystemDark() : false;
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.followSystem === followSystem
  ) {
    syncDesktopTheme(theme, followSystem);
    return;
  }

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const resolvedAppearance = resolveThemeAppearance(theme, systemDark, followSystem);
  applyThemePalette(theme, resolvedAppearance);
  const isDark = resolvedAppearance === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  lastAppliedTheme = { theme, systemDark, followSystem };
  syncBrowserChromeTheme();
  syncDesktopTheme(theme, followSystem);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
  followSystem?: boolean,
): Promise<void> {
  try {
    await bridge.setTheme(resolveDesktopTheme(theme, followSystem));
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

export function syncDesktopTheme(theme: Theme, followSystem?: boolean) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const desktopTheme = resolveDesktopTheme(theme, followSystem);
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === desktopTheme) {
    return;
  }

  lastDesktopTheme = desktopTheme;
  void syncDesktopThemePreference(bridge, theme, followSystem).catch((cause: unknown) => {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause });
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    });
    if (lastDesktopTheme === desktopTheme) {
      lastDesktopTheme = null;
    }
  });
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  // Reading the preference hits localStorage, so only recompute after a
  // change was signalled; useTheme consumers call this on every render.
  if (!snapshotStale && lastSnapshot) return lastSnapshot;
  snapshotStale = false;
  const theme = getStored();
  const followSystem = readStoredFollowSystem(theme);
  const systemDark = followSystem ? getSystemDark() : false;

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.followSystem === followSystem
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark, followSystem };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleSystemAppearanceChange() {
  const storedTheme = getStored();
  if (readStoredFollowSystem(storedTheme)) applyTheme(storedTheme, true);
  emitChange();
}

function handleStorageChange(e: StorageEvent) {
  if (e.key === STORAGE_KEY) {
    themeStorageReadFailure = null;
    applyTheme(getStored(), true);
    emitChange();
  } else if (e.key === THEME_FOLLOW_SYSTEM_STORAGE_KEY) {
    applyTheme(getStored(), true);
    emitChange();
  } else if (e.key === CUSTOM_THEMES_STORAGE_KEY || e.key === null) {
    if (e.key === null) themeStorageReadFailure = null;
    invalidateCustomThemes();
    lastAppliedTheme = null;
    applyTheme(getStored(), true);
    emitChange();
  }
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // The system-preference and cross-tab listeners are shared by all
  // subscribers; each event applies the theme once and notifies everyone.
  if (!removeWindowListeners) {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
    mq?.addEventListener("change", handleSystemAppearanceChange);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      mq?.removeEventListener("change", handleSystemAppearanceChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;

  const resolvedTheme: "light" | "dark" = resolveThemeAppearance(
    theme,
    snapshot.systemDark,
    snapshot.followSystem,
  );

  const setTheme = useCallback((next: Theme): boolean => {
    if (typeof window === "undefined") return false;
    try {
      writeThemePreference(next);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: STORAGE_KEY,
            theme: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });
      return false;
    }
    applyTheme(next, true);
    emitChange();
    return true;
  }, []);

  const setFollowSystem = useCallback((nextFollowSystem: boolean): boolean => {
    if (typeof window === "undefined") return false;
    try {
      writeFollowSystemPreference(nextFollowSystem);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: THEME_FOLLOW_SYSTEM_STORAGE_KEY,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        ...safeErrorLogAttributes(error),
      });
      return false;
    }
    themeStorageReadFailure = null;
    applyTheme(getStored(), true);
    emitChange();
    return true;
  }, []);

  const refreshTheme = useCallback(() => {
    if (typeof window === "undefined") return;
    lastAppliedTheme = null;
    applyTheme(getStored(), true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [snapshot.followSystem, theme]);

  return {
    theme,
    setTheme,
    setFollowSystem,
    refreshTheme,
    followSystem: snapshot.followSystem,
    resolvedTheme,
  } as const;
}
