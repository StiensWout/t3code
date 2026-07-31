/**
 * Font-family preferences from Settings → Appearance, applied as CSS custom
 * properties. The default stacks mirror the `--font-sans` / `--font-mono`
 * definitions in `index.css`; a custom family is always prepended to the
 * matching default stack so glyph coverage never regresses.
 */

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
}

/**
 * Apply the preferences to the root element. Unset preferences remove the
 * override so the stylesheet defaults (and theme changes) stay in charge.
 */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const assignments: ReadonlyArray<readonly [string, string | null, string]> = [
    ["--font-sans", cssFontFamilies(preferences.sans), DEFAULT_SANS_FONT_STACK],
    ["--font-mono", cssFontFamilies(preferences.code), DEFAULT_CODE_FONT_STACK],
    // The composer falls back to whatever the sans preference resolves to.
    ["--font-composer", cssFontFamilies(preferences.composer), "var(--font-sans)"],
  ];
  for (const [variable, families, defaultStack] of assignments) {
    if (families === null) {
      root.style.removeProperty(variable);
    } else {
      root.style.setProperty(variable, `${families}, ${defaultStack}`);
    }
  }
}

export interface FontOption {
  readonly label: string;
  readonly family: string;
}

/**
 * Curated choices for the Appearance dropdowns. The settings UI filters these
 * through `isFontFamilyAvailable`, so platforms only offer faces that will
 * actually render; "Custom" in the UI covers everything else.
 */
export const SANS_FONT_OPTIONS: readonly FontOption[] = [
  { label: "DM Sans", family: "DM Sans" },
  { label: "Inter", family: "Inter" },
  { label: "SF Pro", family: "SF Pro Text" },
  { label: "Segoe UI", family: "Segoe UI" },
  { label: "Roboto", family: "Roboto" },
  { label: "Helvetica Neue", family: "Helvetica Neue" },
  { label: "Arial", family: "Arial" },
  { label: "System UI", family: "system-ui" },
];

export const MONO_FONT_OPTIONS: readonly FontOption[] = [
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
];

export function isFontFamilyAvailable(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return false;
  // Generic keywords always resolve.
  if (/^(system-ui|sans-serif|serif|monospace|ui-monospace)$/i.test(families)) return true;
  try {
    return document.fonts.check(`12px ${families}`);
  } catch {
    return false;
  }
}

/** Webfonts the app bundles; offered even before document.fonts has loaded them. */
const BUNDLED_FAMILIES = new Set(["DM Sans", "JetBrains Mono"]);

export function availableFontOptions(options: readonly FontOption[]): readonly FontOption[] {
  return options.filter(
    (option) => BUNDLED_FAMILIES.has(option.family) || isFontFamilyAvailable(option.family),
  );
}
