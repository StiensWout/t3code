import { describe, expect, it } from "vite-plus/test";

import {
  getThemeColorsForMode,
  getThemeModes,
  isThemeFollowingSystem,
  parseThemeFile,
  resolveDesktopTheme,
  resolveThemeAppearance,
  serializeThemeFile,
  T3_CHAT_THEME,
  themePreferenceForMode,
  themePreferenceForSystem,
  THEME_FILE_VERSION,
} from "./themePalette";

describe("theme files", () => {
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
});
