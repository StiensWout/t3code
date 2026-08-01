import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  MONO_FONT_OPTIONS,
  SANS_FONT_OPTIONS,
  clampSizeAdjust,
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

describe("clampSizeAdjust", () => {
  it("matches the target when the face is close to it", () => {
    // Arial 0.54 against a 0.51 target: a 5.6% correction is within range.
    expect(clampSizeAdjust(0.51, 0.54)).toBe(0.51);
  });

  it("caps the correction for faces with an unusual x-height", () => {
    // Courier New (~0.42) would scale 21% up to reach 0.51; cap it at 6%.
    const adjust = clampSizeAdjust(0.51, 0.42);
    expect(adjust).toBe(0.445);
    expect(adjust / 0.42).toBeLessThanOrEqual(1.061);
  });

  it("caps oversized faces symmetrically", () => {
    const adjust = clampSizeAdjust(0.42, 0.55);
    expect(adjust).toBe(0.517);
    expect(adjust / 0.55).toBeGreaterThanOrEqual(0.939);
  });

  it("leaves a face that already matches untouched", () => {
    expect(clampSizeAdjust(0.51, 0.51)).toBe(0.51);
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
