import { describe, expect, it } from "vite-plus/test";

import {
  clampCodeFontSize,
  clampInterfaceFontSize,
  clampPromptFontSize,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  MONO_FONT_OPTIONS,
  SANS_FONT_OPTIONS,
  appearanceFontStack,
  cssFontFamilies,
  fontOptionCategories,
} from "./appearanceFonts";

describe("cssFontFamilies", () => {
  it("returns null for effectively empty input", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies(" , , ")).toBeNull();
  });

  it("quotes names with spaces and keeps single idents bare", () => {
    expect(cssFontFamilies("Fira Code")).toBe('"Fira Code"');
    expect(cssFontFamilies("monospace")).toBe("monospace");
    expect(cssFontFamilies('"Comic Mono"')).toBe('"Comic Mono"');
  });

  it("normalizes comma-separated lists and strips embedded quotes", () => {
    expect(cssFontFamilies(" Fira Code , Menlo ")).toBe('"Fira Code", Menlo');
    expect(cssFontFamilies('Bad"Name')).toBe('"BadName"');
  });

  it("quotes names that are not single CSS idents", () => {
    expect(cssFontFamilies("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(cssFontFamilies("M+ 1m")).toBe('"M+ 1m"');
  });
});

describe("fontOptionCategories", () => {
  it("splits a mixed list into labeled sections preserving catalog order", () => {
    const mixed = [...SANS_FONT_OPTIONS.slice(0, 2), ...MONO_FONT_OPTIONS.slice(0, 2)];
    const sections = fontOptionCategories(mixed);
    expect(sections.map(([category]) => category)).toEqual(["Sans serif", "Monospace"]);
    expect(sections[0]?.[1]).toEqual(SANS_FONT_OPTIONS.slice(0, 2));
    expect(sections[1]?.[1]).toEqual(MONO_FONT_OPTIONS.slice(0, 2));
  });

  it("keeps a single-category list in one unlabeled-ready section", () => {
    const sections = fontOptionCategories(MONO_FONT_OPTIONS);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.[0]).toBe("Monospace");
  });
});

describe("appearanceFontStack", () => {
  it("prepends the custom family to the default stack", () => {
    expect(appearanceFontStack("Fira Code", DEFAULT_CODE_FONT_STACK)).toBe(
      `"Fira Code", ${DEFAULT_CODE_FONT_STACK}`,
    );
  });

  it("falls back to the default stack when unset", () => {
    expect(appearanceFontStack("", DEFAULT_SANS_FONT_STACK)).toBe(DEFAULT_SANS_FONT_STACK);
  });
});

describe("font size clamping", () => {
  it("keeps sizes inside the ranges the UI can absorb", () => {
    expect(clampInterfaceFontSize(16)).toBe(16);
    expect(clampInterfaceFontSize(2)).toBe(12);
    expect(clampInterfaceFontSize(96)).toBe(20);
    expect(clampPromptFontSize(40)).toBe(20);
    expect(clampCodeFontSize(1)).toBe(10);
  });

  it("rounds fractional values and falls back for unusable input", () => {
    expect(clampCodeFontSize(13.4)).toBe(13);
    expect(clampInterfaceFontSize(Number.NaN)).toBe(16);
    expect(clampPromptFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });
});
