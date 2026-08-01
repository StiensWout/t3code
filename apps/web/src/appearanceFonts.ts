/**
 * Font preferences from Settings → Appearance, applied as CSS custom
 * properties. The default stacks mirror the `--font-sans` / `--font-mono`
 * definitions in `index.css`; a custom family is always prepended to the
 * matching default stack so glyph coverage never regresses.
 */

import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_PROMPT_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
} from "@t3tools/contracts";

export const DEFAULT_SANS_FONT_STACK =
  '"DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ' +
  "sans-serif";

export const DEFAULT_CODE_FONT_STACK =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace';

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

/**
 * Normalize a user-entered family (single name or comma-separated list) into a
 * safe CSS font-family list, or null when the input is effectively empty.
 */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

/** The full stack a preference resolves to: custom families before the default. */
export function appearanceFontStack(custom: string, defaultStack: string): string {
  const families = cssFontFamilies(custom);
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

export interface AppearanceFontPreferences {
  readonly sans: string;
  readonly code: string;
  readonly composer: string;
  readonly sizeInterface: number;
  readonly sizePrompt: number;
  readonly sizeCode: number;
}

/**
 * Apply the preferences to the root element. Unset families remove the
 * override so the stylesheet defaults (and theme changes) stay in charge.
 *
 * Sizes are always written: the interface size drives the root font size (and
 * with it every rem-based dimension), while the prompt and code sizes stay in
 * absolute pixels so they do not scale twice.
 */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const families: ReadonlyArray<readonly [variable: string, custom: string, fallback: string]> = [
    ["--font-sans", preferences.sans, DEFAULT_SANS_FONT_STACK],
    ["--font-mono", preferences.code, DEFAULT_CODE_FONT_STACK],
    // The composer falls back to whatever the sans preference resolves to.
    ["--font-composer", preferences.composer, "var(--font-sans)"],
  ];
  for (const [variable, custom, fallback] of families) {
    const list = cssFontFamilies(custom);
    if (list === null) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(variable, `${list}, ${fallback}`);
    }
  }

  root.style.fontSize = `${clampInterfaceFontSize(preferences.sizeInterface)}px`;
  root.style.setProperty("--font-size-prompt", `${clampPromptFontSize(preferences.sizePrompt)}px`);
  const code = clampCodeFontSize(preferences.sizeCode);
  root.style.setProperty("--font-size-code", `${code}px`);
  // The @pierre/diffs surfaces read their own hook for code text.
  root.style.setProperty("--diffs-font-size", `${code}px`);
}

function clampFontSize(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function clampInterfaceFontSize(value: number): number {
  return clampFontSize(
    value,
    MIN_INTERFACE_FONT_SIZE,
    MAX_INTERFACE_FONT_SIZE,
    DEFAULT_INTERFACE_FONT_SIZE,
  );
}

export function clampPromptFontSize(value: number): number {
  return clampFontSize(value, MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE, DEFAULT_PROMPT_FONT_SIZE);
}

export function clampCodeFontSize(value: number): number {
  return clampFontSize(value, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);
}

export type FontCategory = "Sans serif" | "Monospace";

export interface FontOption {
  readonly label: string;
  readonly family: string;
  readonly category: FontCategory;
}

function fontCatalog(
  category: FontCategory,
  entries: ReadonlyArray<Omit<FontOption, "category">>,
): readonly FontOption[] {
  return entries.map((entry) => ({ ...entry, category }));
}

/**
 * Curated choices for the Appearance dropdowns. The settings UI filters these
 * through `isFontFamilyAvailable`, so platforms only offer faces that will
 * actually render; "Custom" in the UI covers everything else. The category
 * groups mixed dropdowns (composer) into labeled sections.
 */
export const SANS_FONT_OPTIONS: readonly FontOption[] = fontCatalog("Sans serif", [
  // The bundled webfont registers as "DM Sans Variable", not "DM Sans"; the
  // option must reference the registered name to resolve on every machine.
  { label: "DM Sans", family: "DM Sans Variable" },
  { label: "Inter", family: "Inter" },
  { label: "SF Pro", family: "SF Pro Text" },
  { label: "Segoe UI", family: "Segoe UI" },
  { label: "Roboto", family: "Roboto" },
  { label: "Helvetica Neue", family: "Helvetica Neue" },
  { label: "Arial", family: "Arial" },
  { label: "System UI", family: "system-ui" },
]);

export const MONO_FONT_OPTIONS: readonly FontOption[] = fontCatalog("Monospace", [
  { label: "SF Mono", family: "SF Mono" },
  { label: "JetBrains Mono", family: "JetBrains Mono" },
  { label: "Fira Code", family: "Fira Code" },
  { label: "Cascadia Code", family: "Cascadia Code" },
  { label: "Menlo", family: "Menlo" },
  { label: "Monaco", family: "Monaco" },
  { label: "Consolas", family: "Consolas" },
  { label: "Source Code Pro", family: "Source Code Pro" },
  { label: "IBM Plex Mono", family: "IBM Plex Mono" },
  { label: "Ubuntu Mono", family: "Ubuntu Mono" },
  { label: "Courier New", family: "Courier New" },
]);

/** The options split into their labeled category sections, in catalog order. */
export function fontOptionCategories(
  options: readonly FontOption[],
): ReadonlyArray<readonly [FontCategory, readonly FontOption[]]> {
  const sections = new Map<FontCategory, FontOption[]>();
  for (const option of options) {
    const section = sections.get(option.category);
    if (section === undefined) {
      sections.set(option.category, [option]);
    } else {
      section.push(option);
    }
  }
  return [...sections.entries()];
}

const FONT_PROBE_TEXT = "mmmmmmmmMMWli1O0@# fjord";
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `16px ${fontList}`;
  return fontProbeContext.measureText(FONT_PROBE_TEXT).width;
}

/**
 * Canvas metric probing instead of document.fonts.check(): check() reports
 * true for families that are not installed at all (nothing needs loading), so
 * it cannot filter the dropdown. A family exists when falling back to at
 * least one generic changes the measured advance.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true;
  try {
    for (const generic of ["monospace", "serif", "sans-serif"]) {
      const baseline = probeWidth(generic);
      const candidate = probeWidth(`${families}, ${generic}`);
      if (baseline === null || candidate === null) return false;
      if (candidate !== baseline) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether a family renders every character on the same advance. Cell-grid
 * surfaces (the terminal) require this: a proportional face draws its text
 * narrower than the lattice the cursor and selection are placed on, which
 * reads as ragged gaps and a cursor stranded to the right of the text.
 *
 * Unmeasurable environments answer true, so a missing canvas never blocks a
 * legitimate font.
 */
export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    // Fall back to a generic mono so an absent face measures as monospace and
    // is left for the normal fallback chain to resolve.
    fontProbeContext.font = `32px ${families}, monospace`;
    const narrow = fontProbeContext.measureText("i").width;
    const wide = fontProbeContext.measureText("M").width;
    if (!Number.isFinite(narrow) || !Number.isFinite(wide) || wide === 0) return true;
    return Math.abs(wide - narrow) < 0.5;
  } catch {
    return true;
  }
}

/** Webfonts the app bundles; offered even before document.fonts has loaded them. */
const BUNDLED_FAMILIES = new Set(["DM Sans Variable", "JetBrains Mono"]);

export function availableFontOptions(options: readonly FontOption[]): readonly FontOption[] {
  return options.filter(
    (option) => BUNDLED_FAMILIES.has(option.family) || isFontFamilyAvailable(option.family),
  );
}
