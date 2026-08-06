import {
  createVividThemeColors,
  parseThemeFile,
  THEME_FILE_VERSION,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "./themePalette";

/**
 * Best-effort import of a VS Code color theme (`*-color-theme.json`).
 *
 * VS Code themes describe editor chrome, not an app palette: they carry a few
 * hundred workbench keys, leave most of them unset, and freely use 8-digit
 * hex with alpha for overlays. So the conversion derives a complete, contrast
 * -solved palette from the theme's editor background and accent, then layers
 * the workbench colors it did specify on top. Anything the file omits keeps
 * the derived value instead of falling back to an unrelated palette.
 */

type VsCodeRgba = { r: number; g: number; b: number; a: number };
type VsCodeRgb = { r: number; g: number; b: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** sRGB transfer function, and its inverse, shared by the wide-gamut path. */
function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * `color(display-p3 r g b / a)` shows up in themes authored for wide-gamut
 * displays. Out-of-gamut colors clip to the sRGB edge, which is what a browser
 * on an sRGB screen shows anyway.
 */
function parseColorFunction(value: string): VsCodeRgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const [space, body] = [match[1]!.toLowerCase(), match[2]!];
  const [channelPart, alphaPart] = body.split("/");
  const channels = channelPart!
    .trim()
    .split(/\s+/)
    .map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part)));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const alphaRaw = alphaPart?.trim();
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith("%")
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
  if (!Number.isFinite(alpha)) return null;

  const [red, green, blue] = channels as [number, number, number];
  if (space === "srgb") {
    return { r: red * 255, g: green * 255, b: blue * 255, a: Math.max(0, Math.min(1, alpha)) };
  }
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map(decodeGamma) as [
    number,
    number,
    number,
  ];
  // Display P3 linear -> sRGB linear.
  const srgb = [
    1.2249401762805 * linearRed - 0.2249401762805 * linearGreen,
    -0.042056961239 * linearRed + 1.042056961239 * linearGreen,
    -0.0196375547643 * linearRed - 0.0786360655012 * linearGreen + 1.0982736202656 * linearBlue,
  ].map((channel) => encodeGamma(channel) * 255) as [number, number, number];
  return { r: srgb[0], g: srgb[1], b: srgb[2], a: Math.max(0, Math.min(1, alpha)) };
}

/** VS Code accepts #RGB, #RGBA, #RRGGBB, and #RRGGBBAA; some themes also use
 *  CSS color() notation for wide-gamut palettes. */
function parseVsCodeColor(value: unknown): VsCodeRgba | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("color(")) return parseColorFunction(trimmed);
  const hex = trimmed.replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) =>
    part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex(color: VsCodeRgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Overlays are semi-transparent in VS Code; our roles are opaque, so they are
 *  composited onto whatever surface they sit on. */
function flattenOver(color: VsCodeRgba, base: VsCodeRgb): string {
  if (color.a >= 1) return toHex(color);
  return toHex({
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  });
}

function relativeLuminance(color: VsCodeRgb): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first: VsCodeRgb, second: VsCodeRgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexToRgb(value: string): VsCodeRgb {
  return parseVsCodeColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * A VS Code theme is recognised by its workbench colors: the keys are dotted
 * paths (`editor.background`), which our own files never use.
 */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.version === THEME_FILE_VERSION) return false;
  const hasWorkbenchColors =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

function resolveAppearance(value: Record<string, unknown>, canvas: VsCodeRgb): ThemeAppearance {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "light" || type === "hc-light") return "light";
  if (type === "dark" || type === "hc-black") return "dark";
  // Unlabelled themes (and the odd custom `type`) follow the editor surface.
  return relativeLuminance(canvas) < 0.179 ? "dark" : "light";
}

function resolveName(value: Record<string, unknown>): string {
  const candidate = [value.displayName, value.name].find(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  // The prefix marks the theme as imported in the library; labels cap at 48.
  return `VS Code · ${(candidate ?? "theme").trim()}`.slice(0, 48);
}

export function parseVsCodeThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  const colors = isRecord(value.colors) ? value.colors : {};

  /** First key that carries a usable color, in priority order. */
  const pick = (...keys: ReadonlyArray<string>): VsCodeRgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const solidOver = (base: VsCodeRgb, ...keys: ReadonlyArray<string>): string | null => {
    const parsed = pick(...keys);
    return parsed ? flattenOver(parsed, base) : null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error(
      'That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.',
    );
  }
  const canvas = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b };
  const appearance = resolveAppearance(value, canvas);

  const accentColor = pick(
    "focusBorder",
    "button.background",
    "textLink.foreground",
    "activityBarBadge.background",
    "progressBar.background",
    "badge.background",
  );
  const canvasHex = toHex(canvas);
  const accentHex = accentColor ? flattenOver(accentColor, canvas) : null;

  // The derived palette is the floor: every role starts contrast-solved, then
  // the theme's own workbench colors replace what it actually specified.
  const derived = createVividThemeColors(appearance, canvasHex, accentHex ?? canvasHex);
  const sidebarHex =
    solidOver(canvas, "sideBar.background", "activityBar.background") ?? derived.sidebar;
  const sidebar = hexToRgb(sidebarHex);
  const terminalHex =
    solidOver(canvas, "terminal.background", "panel.background") ?? derived.terminalBackground;
  const terminal = hexToRgb(terminalHex);

  /** Foregrounds only win when they stay readable on the surface they land on;
   *  a theme tuned for its own chrome can be unreadable on ours. */
  const readableOn = (
    surface: string,
    fallback: string,
    ...keys: ReadonlyArray<string>
  ): string => {
    const surfaceRgb = hexToRgb(surface);
    const isReadable = (candidate: string) => contrastRatio(hexToRgb(candidate), surfaceRgb) >= 4.5;
    const specified = solidOver(surfaceRgb, ...keys);
    if (specified && isReadable(specified)) return specified;
    // The derived fallback was solved against the derived surface. When the
    // file replaced that surface (a light sideBar in a dark theme, say), the
    // fallback has to clear the bar there too, or the text falls back to the
    // readable end of the greyscale for the surface actually in play.
    if (isReadable(fallback)) return fallback;
    return relativeLuminance(surfaceRgb) < 0.179 ? "#ffffff" : "#000000";
  };

  const overrides: Partial<Record<ThemeColorRole, string>> = {
    canvas: canvasHex,
    text: readableOn(canvasHex, derived.text, "editor.foreground", "foreground"),
    textMuted: readableOn(
      canvasHex,
      derived.textMuted,
      "descriptionForeground",
      "disabledForeground",
    ),
    surface: solidOver(canvas, "editorWidget.background") ?? derived.surface,
    surfaceRaised:
      solidOver(canvas, "editorWidget.background", "dropdown.background") ?? derived.surfaceRaised,
    surfaceOverlay:
      solidOver(canvas, "menu.background", "quickInput.background", "dropdown.background") ??
      derived.surfaceOverlay,
    border:
      solidOver(canvas, "panel.border", "editorGroup.border", "contrastBorder") ?? derived.border,
    input: solidOver(canvas, "input.border", "dropdown.border") ?? derived.input,
    placeholder: readableOn(canvasHex, derived.placeholder, "input.placeholderForeground"),
    error: readableOn(canvasHex, derived.error, "editorError.foreground", "errorForeground"),
    warning: readableOn(canvasHex, derived.warning, "editorWarning.foreground"),
    accentSurface:
      solidOver(canvas, "list.activeSelectionBackground", "list.hoverBackground") ??
      derived.accentSurface,
    codeBackground: solidOver(canvas, "textCodeBlock.background") ?? derived.codeBackground,
    sidebar: sidebarHex,
    sidebarForeground: readableOn(sidebarHex, derived.sidebarForeground, "sideBar.foreground"),
    sidebarBorder: solidOver(sidebar, "sideBar.border") ?? derived.sidebarBorder,
    sidebarRowHover: solidOver(sidebar, "list.hoverBackground") ?? derived.sidebarRowHover,
    sidebarRowActive:
      solidOver(sidebar, "list.inactiveSelectionBackground", "list.hoverBackground") ??
      derived.sidebarRowActive,
    sidebarRowSelected:
      solidOver(sidebar, "list.activeSelectionBackground") ?? derived.sidebarRowSelected,
    terminalBackground: terminalHex,
    terminalForeground: readableOn(terminalHex, derived.terminalForeground, "terminal.foreground"),
    terminalCursor:
      solidOver(terminal, "terminalCursor.foreground", "editorCursor.foreground") ??
      derived.terminalCursor,
    terminalSelection:
      solidOver(terminal, "terminal.selectionBackground", "editor.selectionBackground") ??
      derived.terminalSelection,
    terminalScrollbar:
      solidOver(terminal, "scrollbarSlider.background") ?? derived.terminalScrollbar,
  };
  if (accentHex) {
    overrides.accent = accentHex;
    overrides.focus = accentHex;
    // The button pair is the closest thing VS Code has to our action color.
    const actionHex = solidOver(canvas, "button.background") ?? accentHex;
    overrides.messageAction = actionHex;
    overrides.messageActionForeground = readableOn(
      actionHex,
      derived.messageActionForeground,
      "button.foreground",
    );
    overrides.accentForeground = readableOn(
      accentHex,
      derived.accentForeground,
      "button.foreground",
    );
  }

  // Reuse the theme-file parser so ids, names, and color values go through the
  // same validation as a hand-written file.
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    name: resolveName(value),
    appearance,
    colors: { ...derived, ...overrides },
  });
}
