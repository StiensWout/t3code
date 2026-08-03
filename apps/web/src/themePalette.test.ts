import { describe, expect, it, vi } from "vite-plus/test";

import {
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  getCustomThemes,
  invalidateCustomThemes,
  installCustomTheme,
  isThemeFollowingSystem,
  parseThemeFile,
  resolveDesktopTheme,
  resolveThemeAppearance,
  serializeThemeFile,
  subscribeToCustomThemes,
  T3_CHAT_THEME,
  T3_GROVE_THEME,
  themePreferenceForMode,
  themePreferenceForSystem,
  updateCustomTheme,
  CUSTOM_THEMES_STORAGE_KEY,
  createManagedThemeColors,
  getDefaultThemeColors,
  THEME_FILE_VERSION,
} from "./themePalette";

function contrastRatio(first: string, second: string): number {
  const toRgb = (value: string) => {
    const hex = value.slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toRgb(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme files", () => {
  it("derives a readable palette from extreme simple-editor colors", () => {
    const light = createManagedThemeColors("light", "#111827", "#ffff00");
    const dark = createManagedThemeColors("dark", "#ffffff", "#ffff00");
    const lightDefaults = getDefaultThemeColors("light");
    const darkDefaults = getDefaultThemeColors("dark");

    expect(light.canvas).not.toBe("#111827");
    expect(dark.canvas).not.toBe("#ffffff");
    expect(contrastRatio(light.accent, light.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accent, dark.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.textMuted, light.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.textMuted, dark.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.accentForeground, light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accentForeground, dark.accent)).toBeGreaterThanOrEqual(4.5);
    expect(light.error).toBe(lightDefaults.error);
    expect(dark.warning).toBe(darkDefaults.warning);
  });

  it("merges a small user file onto the matching contrast-safe base palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Ocean dusk",
      appearance: "dark",
      colors: {
        canvas: "#07152f",
        accent: "#67c2ff",
      },
    });

    expect(theme).toMatchObject({
      id: "ocean-dusk",
      label: "Ocean dusk",
      appearance: "dark",
      colors: {
        canvas: "#07152f",
        accent: "#67c2ff",
        placeholder: "#b88cb5",
      },
    });
  });

  it("rejects unknown roles and invalid color values", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { background: "#ffffff" },
      }),
    ).toThrow('"background" is not a supported theme color role.');

    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Broken",
        appearance: "light",
        colors: { accent: "var(--danger)" },
      }),
    ).toThrow('The color for "accent" must be a hex color');
  });

  it("serializes a theme back into the importable file shape", () => {
    const serialized = serializeThemeFile(T3_CHAT_THEME);
    expect(JSON.parse(serialized)).toMatchObject({
      version: THEME_FILE_VERSION,
      id: T3_CHAT_THEME.id,
      name: T3_CHAT_THEME.label,
      appearance: "light",
    });
  });

  it("keeps optional light and dark palettes under one theme id", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance: "light",
      colors: { canvas: "#f8fbff", text: "#10243d" },
      variants: {
        dark: { canvas: "#101827", text: "#eef5ff" },
      },
    });

    expect(getThemeModes(theme)).toEqual(["light", "dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({
      canvas: "#101827",
      text: "#eef5ff",
    });
    expect(themePreferenceForMode(theme, "dark")).toBe("aurora:dark");
    expect(themePreferenceForSystem(theme)).toBe("aurora:system");
    expect(isThemeFollowingSystem("aurora:system")).toBe(true);
    expect(isThemeFollowingSystem("aurora:dark")).toBe(false);
    expect(getThemeModes(T3_CHAT_THEME)).toEqual(["light"]);
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, true, true)).toBe("light");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, true)).toBe("light");
    expect(resolveThemeAppearance("aurora:dark", false, true)).toBe("light");
    expect(resolveDesktopTheme("aurora:dark", true)).toBe("system");
    expect(JSON.parse(serializeThemeFile(theme)).variants.dark).toMatchObject({
      canvas: "#101827",
      text: "#eef5ff",
    });
  });

  it("includes the T3 Grove maintainer theme with both modes", () => {
    expect(getThemeDefinition(T3_GROVE_THEME.id)).toBe(T3_GROVE_THEME);
    expect(getThemeModes(T3_GROVE_THEME)).toEqual(["light", "dark"]);
    expect(T3_GROVE_THEME.colors.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(T3_GROVE_THEME.variants?.dark?.accent).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("rejects a variant that repeats the base appearance", () => {
    expect(() =>
      parseThemeFile({
        version: THEME_FILE_VERSION,
        name: "Duplicate light",
        appearance: "light",
        colors: { canvas: "#f8fbff" },
        variants: { light: { canvas: "#101827" } },
      }),
    ).toThrow('Theme variants must not repeat the base appearance "light".');
  });

  it("keeps a single-mode theme on its only palette", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      id: "midnight-slate",
      name: "Midnight Slate",
      appearance: "dark",
      colors: { canvas: "#111827", messageAction: "#2563eb" },
    });

    expect(getThemeModes(theme)).toEqual(["dark"]);
    expect(getThemeColorsForMode(theme, "dark")).toMatchObject({ canvas: "#111827" });
    expect(getThemeColorsForMode(theme, "light")).toBeNull();
  });

  it("invalidates cached themes when another tab clears localStorage", () => {
    let storedThemes: string | null = JSON.stringify([
      {
        id: "ocean-dusk",
        label: "Ocean dusk",
        appearance: "dark",
        colors: { canvas: "#07152f" },
      },
    ]);
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      removeEventListener: vi.fn(),
      localStorage: {
        getItem: (key: string) => (key === CUSTOM_THEMES_STORAGE_KEY ? storedThemes : null),
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toHaveLength(1);
    const listener = vi.fn();
    const unsubscribe = subscribeToCustomThemes(listener);

    storedThemes = null;
    storageHandler?.({ key: null } as StorageEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCustomThemes()).toEqual([]);
    unsubscribe();
    invalidateCustomThemes();
    vi.unstubAllGlobals();
  });

  it("updates a personal theme without changing its id", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });

    invalidateCustomThemes();
    const createdTheme = installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff", accent: "#5b6cff" },
      }),
    );
    const updatedTheme = updateCustomTheme({
      ...createdTheme,
      label: "Aurora Night",
      colors: { ...createdTheme.colors, accent: "#7c3aed" },
    });

    expect(updatedTheme).toMatchObject({ id: "aurora", label: "Aurora Night" });
    expect(getCustomThemes()).toEqual([updatedTheme]);
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")[0]).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
    });

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});
