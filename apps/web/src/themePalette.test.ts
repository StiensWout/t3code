import { describe, expect, it, vi } from "vite-plus/test";

import {
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  getThemePreferenceMode,
  isKnownThemePreference,
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
  T3_EMBER_THEME,
  T3_GROVE_THEME,
  T3_IRIS_THEME,
  T3_OCEAN_THEME,
  themePreferenceForMode,
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
    expect(isThemeFollowingSystem("aurora:system")).toBe(true);
    expect(isThemeFollowingSystem("aurora:dark")).toBe(false);
    expect(getThemeModes(T3_CHAT_THEME)).toEqual(["light", "dark"]);
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, true, true)).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, true)).toBe("system");
    expect(resolveThemeAppearance(T3_CHAT_THEME.id, false, false, "dark")).toBe("dark");
    expect(resolveDesktopTheme(T3_CHAT_THEME.id, false, "dark")).toBe("dark");
    expect(resolveThemeAppearance("aurora:dark", false, true)).toBe("light");
    expect(resolveDesktopTheme("aurora:dark", true)).toBe("system");
    expect(JSON.parse(serializeThemeFile(theme)).variants.dark).toMatchObject({
      canvas: "#101827",
      text: "#eef5ff",
    });
  });

  it("keeps the T3 Chat palette readable", () => {
    const colors = T3_CHAT_THEME.colors;
    expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.accentForeground, colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.messageForeground, colors.messageSurface)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(colors.secondaryForeground, colors.secondary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
  });

  it("includes the dual-mode maintainer themes", () => {
    for (const theme of [
      T3_CHAT_THEME,
      T3_GROVE_THEME,
      T3_OCEAN_THEME,
      T3_EMBER_THEME,
      T3_IRIS_THEME,
    ]) {
      expect(getThemeDefinition(theme.id)).toBe(theme);
      expect(getThemeModes(theme)).toEqual(["light", "dark"]);
      expect(theme.colors.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.variants?.dark?.accent).toMatch(/^#[0-9a-f]{6}$/i);

      for (const mode of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();
        expect(contrastRatio(colors!.text, colors!.canvas)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colors!.accentForeground, colors!.accent)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.toolbarControlForeground, colors!.toolbarControl),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors!.messageForeground, colors!.messageSurface),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
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

describe("stored theme preferences", () => {
  it("resolves the legacy t3-chat-dark preference to dark T3 Chat", () => {
    expect(getThemeDefinition("t3-chat-dark")).toBe(T3_CHAT_THEME);
    expect(getThemePreferenceMode("t3-chat-dark")).toBe("dark");
    expect(resolveThemeAppearance("t3-chat-dark", true, false)).toBe("dark");
    expect(resolveDesktopTheme("t3-chat-dark", false)).toBe("dark");
    expect(isKnownThemePreference("t3-chat-dark")).toBe(true);
  });

  it("recognizes only preferences the runtime can render", () => {
    for (const preference of [
      "light",
      "dark",
      "system",
      T3_CHAT_THEME.id,
      `${T3_GROVE_THEME.id}:dark`,
    ]) {
      expect(isKnownThemePreference(preference)).toBe(true);
    }
    expect(isKnownThemePreference("aurora:blah")).toBe(false);
    expect(isKnownThemePreference("missing-theme")).toBe(false);
    expect(isKnownThemePreference(`${T3_CHAT_THEME.id}:dark`)).toBe(true);
  });

  it("keeps stored themes with unknown roles and drops invalid entries", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY
            ? JSON.stringify([
                {
                  id: "aurora",
                  label: "Aurora",
                  appearance: "light",
                  colors: { canvas: "#f8fbff", futureRole: "#123456", accent: "not-a-color" },
                  variants: { light: { canvas: "#101827" } },
                },
                { id: "light", label: "Reserved", appearance: "light", colors: {} },
                { id: "aurora", label: "Duplicate", appearance: "dark", colors: {} },
              ])
            : null,
      },
    });
    invalidateCustomThemes();

    const themes = getCustomThemes();
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      id: "aurora",
      colors: { canvas: "#f8fbff", accent: getDefaultThemeColors("light").accent },
    });
    // The variant shadowing the base appearance is dropped so the theme
    // round-trips through parseThemeFile on export.
    expect(getThemeModes(themes[0]!)).toEqual(["light"]);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});
