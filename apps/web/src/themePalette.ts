import * as Schema from "effect/Schema";

export const T3_CHAT_THEME_ID = "t3-chat" as const;
export const T3_CHAT_THEME_LABEL = "T3 Chat";
export const T3_GROVE_THEME_ID = "t3-grove" as const;
export const T3_GROVE_THEME_LABEL = "T3 Grove";
export const THEME_FILE_VERSION = 1 as const;
export const CUSTOM_THEMES_STORAGE_KEY = "t3code:themes:v1";
export const THEME_FOLLOW_SYSTEM_STORAGE_KEY = "t3code:theme-follow-system";

const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";

export const ThemePreference = Schema.String;
export type ThemePreference = typeof ThemePreference.Type;

export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
export type ThemeAppearance = "light" | "dark";

export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>;
export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
export type ThemeVariantOverrides = Readonly<Partial<Record<ThemeAppearance, ThemeColorOverrides>>>;
export type ThemePreferenceMode = ThemeAppearance | "system";
export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
}>;
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: ThemeColorOverrides;
  variants?: ThemeVariantOverrides;
}>;

const RESERVED_THEME_IDS = new Set([
  "system",
  "light",
  "dark",
  T3_CHAT_THEME_ID,
  T3_GROVE_THEME_ID,
  LEGACY_T3_CHAT_DARK_THEME_ID,
]);

const customThemeListeners = new Set<() => void>();
let customThemesSnapshot: ReadonlyArray<ThemeDefinition> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

export function isThemeColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
  );
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function parseStoredThemeColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;

  const colors: Partial<Record<ThemeColorRole, string>> = {
    ...getDefaultThemeColors(appearance),
  };
  // Tolerate unknown roles and malformed values so themes saved by other
  // builds (for example one that adds a new role) keep their remaining colors.
  for (const [role, color] of Object.entries(value)) {
    if (THEME_COLOR_ROLE_SET.has(role) && isThemeColor(color)) {
      colors[role as ThemeColorRole] = color;
    }
  }
  return colors as ThemeColors;
}

function parseStoredThemeVariants(
  value: unknown,
  baseAppearance: ThemeAppearance,
): ThemeVariants | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance)) return null;
    // A variant matching the base appearance would be shadowed by the base
    // colors; drop it so the theme round-trips through parseThemeFile.
    if (appearance === baseAppearance) continue;
    const parsedColors = parseStoredThemeColors(colors, appearance);
    if (!parsedColors) return null;
    variants[appearance] = parsedColors;
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = parseStoredThemeColors(value.colors, value.appearance);
  if (!colors) return null;
  const variants = parseStoredThemeVariants(value.variants, value.appearance);
  if (value.variants !== undefined && variants === null) return null;

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
  };
}

function readCustomThemesFromStorage(): ReadonlyArray<ThemeDefinition> {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const themes: ThemeDefinition[] = [];
    for (const value of parsed) {
      const theme = parseStoredTheme(value);
      if (theme && !themes.some((existing) => existing.id === theme.id)) {
        themes.push(theme);
      }
    }
    return themes;
  } catch {
    return [];
  }
}

function notifyCustomThemeListeners() {
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes() {
  customThemesSnapshot = null;
  notifyCustomThemeListeners();
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  if (customThemesSnapshot === null) {
    customThemesSnapshot = readCustomThemesFromStorage();
  }
  return customThemesSnapshot;
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);
  if (typeof window === "undefined") {
    return () => customThemeListeners.delete(listener);
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEMES_STORAGE_KEY || event.key === null) {
      invalidateCustomThemes();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    customThemeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

const THEME_PREFERENCE_SEPARATOR = ":";

type ThemePreferenceParts = {
  id: string;
  mode: ThemePreferenceMode | null;
  invalidMode: boolean;
};

function isThemePreferenceMode(value: unknown): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

function splitThemePreference(theme: ThemePreference): ThemePreferenceParts {
  const separatorIndex = theme.lastIndexOf(THEME_PREFERENCE_SEPARATOR);
  if (separatorIndex <= 0) return { id: theme, mode: null, invalidMode: false };

  const rawMode = theme.slice(separatorIndex + 1);
  return {
    id: theme.slice(0, separatorIndex),
    mode: isThemePreferenceMode(rawMode) ? rawMode : null,
    invalidMode: !isThemePreferenceMode(rawMode),
  };
}

function normalizeThemeId(themeId: string): string {
  return themeId === LEGACY_T3_CHAT_DARK_THEME_ID ? T3_CHAT_THEME_ID : themeId;
}

function themeIdFromPreference(theme: ThemePreference): string {
  return normalizeThemeId(splitThemePreference(theme).id);
}

function explicitThemeMode(theme: ThemePreference): ThemeAppearance | null {
  const parts = splitThemePreference(theme);
  // Older builds stored the dark T3 Chat palette as a separate theme. Keep
  // those preferences readable, but resolve them to the remaining light-only
  // T3 Chat theme instead of reviving a removed option.
  if (parts.id === LEGACY_T3_CHAT_DARK_THEME_ID) return null;
  return parts.mode === "light" || parts.mode === "dark" ? parts.mode : null;
}

/**
 * Maintainer palettes use product color roles rather than Tailwind or component
 * names so the same definitions can feed other clients and native surfaces.
 */
// Anchored to the t3.chat light palette: #a84370 primary, #db2777 ring,
// #501854 foreground, and its pink-tinted surface family.
const T3_CHAT_LIGHT_COLORS: ThemeColors = {
  canvas: "#faf5fa",
  chrome: "#f3e4f6",
  surface: "#faf5fa",
  surfaceRaised: "#fdfafd",
  surfaceOverlay: "#ffffff",
  text: "#501854",
  textMuted: "#834588",
  border: "#efbdeb",
  input: "#e7c1dc",
  focus: "#db2777",
  accent: "#a84370",
  accentForeground: "#ffffff",
  secondary: "#f1c4e6",
  secondaryForeground: "#77347c",
  muted: "#f6e5f3",
  mutedForeground: "#834588",
  placeholder: "#955a99",
  secondaryLabel: "#7c4181",
  iconMuted: "#8d4f92",
  error: "#ab4347",
  errorForeground: "#7f2f33",
  errorSurface: "#f9e2e3",
  warning: "#a65f19",
  warningForeground: "#7d4510",
  warningSurface: "#fff0d7",
  update: "#a84370",
  updateForeground: "#7c2f5c",
  updateSurface: "#f6d9ec",
  accentSurface: "#f1c4e6",
  accentSurfaceForeground: "#77347c",
  messageSurface: "#f1c4e6",
  messageForeground: "#501854",
  messageAction: "#a84370",
  messageActionForeground: "#ffffff",
  messageActionHover: "#933a63",
  codeBackground: "#f5ecf5",
  codeForeground: "#501854",
  sidebar: "#f3e4f6",
  sidebarForeground: "#8f2a70",
  sidebarMutedForeground: "#a5619e",
  sidebarControlSurface: "#edd7ee",
  sidebarRowHover: "#f7e8f7",
  sidebarRowActive: "#eed3ee",
  sidebarRowSelected: "#f0d7f0",
  sidebarBorder: "#efbdeb",
  terminalBackground: "#faf5fa",
  terminalForeground: "#501854",
  terminalCursor: "#db2777",
  terminalSelection: "#f1c4e6",
  terminalScrollbar: "#ddaed8",
  terminalScrollbarHover: "#c98cc2",
};

const DEFAULT_DARK_THEME_COLORS: ThemeColors = {
  canvas: "#180f1b",
  chrome: "#241329",
  surface: "#221323",
  surfaceRaised: "#2a182b",
  surfaceOverlay: "#2c192d",
  text: "#faeaf9",
  textMuted: "#c99cc4",
  border: "#5c345b",
  input: "#6e3a6a",
  focus: "#f06cab",
  accent: "#df4c96",
  accentForeground: "#2a1022",
  secondary: "#3a2040",
  secondaryForeground: "#f1c9ed",
  muted: "#321b35",
  mutedForeground: "#c99cc4",
  placeholder: "#b88cb5",
  secondaryLabel: "#c49bc0",
  iconMuted: "#c99cc4",
  error: "#f0719d",
  errorForeground: "#ffdbe8",
  errorSurface: "#4a1d31",
  warning: "#efb56b",
  warningForeground: "#ffe3b5",
  warningSurface: "#493018",
  update: "#f06cab",
  updateForeground: "#ffd8f4",
  updateSurface: "#4c2042",
  accentSurface: "#492244",
  accentSurfaceForeground: "#ffd8f4",
  messageSurface: "#522447",
  messageForeground: "#ffe9fa",
  messageAction: "#df4c96",
  messageActionForeground: "#2a1022",
  messageActionHover: "#f06cab",
  codeBackground: "#120d14",
  codeForeground: "#faeaf9",
  sidebar: "#241329",
  sidebarForeground: "#f4d8f0",
  sidebarMutedForeground: "#c49bc0",
  sidebarControlSurface: "#342039",
  sidebarRowHover: "#35203a",
  sidebarRowActive: "#42243f",
  sidebarRowSelected: "#3e203b",
  sidebarBorder: "#5c345b",
  terminalBackground: "#180f1b",
  terminalForeground: "#faeaf9",
  terminalCursor: "#f06cab",
  terminalSelection: "#6b2f5d",
  terminalScrollbar: "#6b3b6d",
  terminalScrollbarHover: "#875083",
};

type ThemeRgbColor = {
  r: number;
  g: number;
  b: number;
};

type ThemeHslColor = {
  h: number;
  s: number;
  l: number;
};

const THEME_LIGHT_FOREGROUND: ThemeRgbColor = { r: 255, g: 250, b: 255 };
const THEME_DARK_FOREGROUND: ThemeRgbColor = { r: 36, g: 21, b: 35 };
const THEME_WHITE_FOREGROUND: ThemeRgbColor = { r: 255, g: 255, b: 255 };
const THEME_BLACK_FOREGROUND: ThemeRgbColor = { r: 0, g: 0, b: 0 };

function parseThemeRgbColor(value: string, fallback: ThemeRgbColor): ThemeRgbColor {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!match) return fallback;

  const raw = match[1];
  if (!raw) return fallback;
  const hex =
    raw.length <= 4
      ? raw
          .slice(0, 3)
          .split("")
          .map((part) => part.repeat(2))
          .join("")
      : raw.slice(0, 6);
  if (hex.length !== 6) return fallback;

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function themeRgbToHexColor(color: ThemeRgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function themeRgbToHsl(color: ThemeRgbColor): ThemeHslColor {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l: lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;

  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness };
}

function themeHslToRgb(color: ThemeHslColor): ThemeRgbColor {
  const hue = ((color.h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const hueSector = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const match = color.l - chroma / 2;
  const [red, green, blue] =
    hueSector < 1
      ? [chroma, secondary, 0]
      : hueSector < 2
        ? [secondary, chroma, 0]
        : hueSector < 3
          ? [0, chroma, secondary]
          : hueSector < 4
            ? [0, secondary, chroma]
            : hueSector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];

  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

function mixThemeRgbColors(
  base: ThemeRgbColor,
  overlay: ThemeRgbColor,
  amount: number,
): ThemeRgbColor {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  };
}

function themeRelativeLuminance(color: ThemeRgbColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function themeContrastRatio(first: ThemeRgbColor, second: ThemeRgbColor): number {
  const firstLuminance = themeRelativeLuminance(first);
  const secondLuminance = themeRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableThemeForeground(background: ThemeRgbColor): ThemeRgbColor {
  const lightContrast = themeContrastRatio(background, THEME_LIGHT_FOREGROUND);
  const darkContrast = themeContrastRatio(background, THEME_DARK_FOREGROUND);
  if (Math.max(lightContrast, darkContrast) >= 4.5) {
    return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND;
  }

  return themeContrastRatio(background, THEME_WHITE_FOREGROUND) >=
    themeContrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND;
}

function readableThemeText(
  background: ThemeRgbColor,
  foreground: ThemeRgbColor,
  amount: number,
  minimumRatio: number,
): ThemeRgbColor {
  const softened = mixThemeRgbColors(foreground, background, amount);
  return themeContrastRatio(softened, background) >= minimumRatio ? softened : foreground;
}

function managedThemeBackground(value: string, appearance: ThemeAppearance): ThemeRgbColor {
  const selected = parseThemeRgbColor(
    value,
    appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 },
  );
  const hsl = themeRgbToHsl(selected);
  return themeHslToRgb({
    h: hsl.h,
    // A background tint should support the selected mode, not turn the whole
    // app into a high-saturation surface.
    s: Math.min(hsl.s, appearance === "dark" ? 0.3 : 0.2),
    l:
      appearance === "dark"
        ? Math.min(0.18, Math.max(0.07, hsl.l))
        : Math.min(0.985, Math.max(0.94, hsl.l)),
  });
}

function managedThemeAccent(
  value: string,
  appearance: ThemeAppearance,
  background: ThemeRgbColor,
): ThemeRgbColor {
  const selected = parseThemeRgbColor(value, { r: 168, g: 67, b: 112 });
  const hsl = themeRgbToHsl(selected);
  const preferredLightness =
    appearance === "dark"
      ? Math.min(0.72, Math.max(0.42, hsl.l))
      : Math.min(0.58, Math.max(0.35, hsl.l));
  const lightnessRange: readonly [number, number] =
    appearance === "dark" ? [0.42, 0.82] : [0.22, 0.58];
  const saturation = Math.min(hsl.s, 0.82);
  const candidates = Array.from({ length: 61 }, (_, index) => {
    const lightness =
      lightnessRange[0] + ((lightnessRange[1] - lightnessRange[0]) * index) / (61 - 1);
    const color = themeHslToRgb({ h: hsl.h, s: saturation, l: lightness });
    return { color, lightness, contrast: themeContrastRatio(color, background) };
  });
  // Leave a little room for rounding when the generated RGB values become a
  // six-digit hex token.
  const readableCandidates = candidates.filter((candidate) => candidate.contrast >= 4.7);
  const pool = readableCandidates.length > 0 ? readableCandidates : candidates;

  return pool.reduce((best, candidate) => {
    const distance = Math.abs(candidate.lightness - preferredLightness);
    const bestDistance = Math.abs(best.lightness - preferredLightness);
    return distance < bestDistance ||
      (distance === bestDistance && candidate.contrast > best.contrast)
      ? candidate
      : best;
  }).color;
}

/**
 * Creates the guided palette used by the basic theme editor. The two user
 * colors control the mood, while dependent roles are generated together so
 * text, surfaces, message actions, code, and terminal UI stay coherent.
 */
export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvas = managedThemeBackground(backgroundValue, appearance);
  const accent = managedThemeAccent(accentValue, appearance, canvas);
  const text = readableThemeForeground(canvas);
  const chrome = mixThemeRgbColors(canvas, accent, 0.04);
  const sidebar = mixThemeRgbColors(canvas, accent, 0.08);
  const surfaceRaised = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.12 : 0.035);
  const surfaceOverlay = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.18 : 0.06);
  const secondary = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.2 : 0.08);
  const muted = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.13 : 0.06);
  const accentSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.3 : 0.14);
  const messageSurface = mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.36 : 0.18);
  const accentForeground = readableThemeForeground(accent);
  const codeBackground = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.18 : 0.025);
  const terminalBackground = mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.2 : 0.035);
  const messageActionHover = mixThemeRgbColors(
    accent,
    accentForeground === THEME_LIGHT_FOREGROUND || accentForeground === THEME_WHITE_FOREGROUND
      ? THEME_BLACK_FOREGROUND
      : THEME_WHITE_FOREGROUND,
    0.12,
  );

  return {
    ...defaults,
    canvas: themeRgbToHexColor(canvas),
    chrome: themeRgbToHexColor(chrome),
    surface: themeRgbToHexColor(canvas),
    surfaceRaised: themeRgbToHexColor(surfaceRaised),
    surfaceOverlay: themeRgbToHexColor(surfaceOverlay),
    text: themeRgbToHexColor(text),
    textMuted: themeRgbToHexColor(readableThemeText(canvas, text, 0.25, 4.5)),
    border: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.36 : 0.12),
    ),
    input: themeRgbToHexColor(mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.5 : 0.18)),
    focus: themeRgbToHexColor(accent),
    accent: themeRgbToHexColor(accent),
    accentForeground: themeRgbToHexColor(accentForeground),
    secondary: themeRgbToHexColor(secondary),
    secondaryForeground: themeRgbToHexColor(readableThemeForeground(secondary)),
    muted: themeRgbToHexColor(muted),
    mutedForeground: themeRgbToHexColor(readableThemeText(canvas, text, 0.2, 4.5)),
    placeholder: themeRgbToHexColor(readableThemeText(canvas, text, 0.12, 4.5)),
    secondaryLabel: themeRgbToHexColor(readableThemeText(canvas, text, 0.18, 4.5)),
    iconMuted: themeRgbToHexColor(readableThemeText(canvas, text, 0.18, 3)),
    accentSurface: themeRgbToHexColor(accentSurface),
    accentSurfaceForeground: themeRgbToHexColor(readableThemeForeground(accentSurface)),
    messageSurface: themeRgbToHexColor(messageSurface),
    messageForeground: themeRgbToHexColor(readableThemeForeground(messageSurface)),
    messageAction: themeRgbToHexColor(accent),
    messageActionForeground: themeRgbToHexColor(accentForeground),
    messageActionHover: themeRgbToHexColor(messageActionHover),
    codeBackground: themeRgbToHexColor(codeBackground),
    codeForeground: themeRgbToHexColor(readableThemeForeground(codeBackground)),
    sidebar: themeRgbToHexColor(sidebar),
    sidebarForeground: themeRgbToHexColor(readableThemeForeground(sidebar)),
    sidebarMutedForeground: themeRgbToHexColor(readableThemeText(sidebar, text, 0.2, 4.5)),
    sidebarControlSurface: themeRgbToHexColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.16 : 0.08),
    ),
    sidebarRowHover: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.12)),
    sidebarRowActive: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.2)),
    sidebarRowSelected: themeRgbToHexColor(mixThemeRgbColors(sidebar, accent, 0.24)),
    sidebarBorder: themeRgbToHexColor(
      mixThemeRgbColors(sidebar, text, appearance === "dark" ? 0.35 : 0.12),
    ),
    terminalBackground: themeRgbToHexColor(terminalBackground),
    terminalForeground: themeRgbToHexColor(readableThemeForeground(terminalBackground)),
    terminalCursor: themeRgbToHexColor(accent),
    terminalSelection: themeRgbToHexColor(
      mixThemeRgbColors(canvas, accent, appearance === "dark" ? 0.35 : 0.18),
    ),
    terminalScrollbar: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.42 : 0.22),
    ),
    terminalScrollbarHover: themeRgbToHexColor(
      mixThemeRgbColors(canvas, text, appearance === "dark" ? 0.55 : 0.32),
    ),
  };
}

export const T3_CHAT_THEME: ThemeDefinition = {
  id: T3_CHAT_THEME_ID,
  label: T3_CHAT_THEME_LABEL,
  appearance: "light",
  colors: T3_CHAT_LIGHT_COLORS,
};

/** Dark defaults are only used when creating a custom dark theme. */
export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? DEFAULT_DARK_THEME_COLORS : T3_CHAT_THEME.colors;
}

export const T3_GROVE_THEME: ThemeDefinition = {
  id: T3_GROVE_THEME_ID,
  label: T3_GROVE_THEME_LABEL,
  appearance: "light",
  colors: createManagedThemeColors("light", "#f4f8f5", "#1e7d52"),
  variants: {
    dark: createManagedThemeColors("dark", "#111f19", "#5dd58e"),
  },
};

const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = [T3_CHAT_THEME, T3_GROVE_THEME];

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  const themeId = themeIdFromPreference(theme);
  return (
    BUILT_IN_THEME_DEFINITIONS.find((definition) => definition.id === themeId) ??
    getCustomThemes().find((definition) => definition.id === themeId) ??
    null
  );
}

export function getThemeColorsForMode(
  theme: ThemeDefinition,
  mode: ThemeAppearance,
): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors;
  return theme.variants?.[mode] ?? null;
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null);
}

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  const explicitMode = explicitThemeMode(theme);
  if (explicitMode) return explicitMode;
  return getThemeDefinition(theme)?.appearance ?? null;
}

export function themePreferenceForMode(
  theme: ThemePreference | ThemeDefinition,
  mode: ThemeAppearance,
): ThemePreference {
  const definition = typeof theme === "string" ? getThemeDefinition(theme) : theme;
  const themeId = typeof theme === "string" ? theme : theme.id;
  if (!definition || getThemeColorsForMode(definition, mode) === null) return themeId;
  return mode === definition.appearance
    ? definition.id
    : `${definition.id}${THEME_PREFERENCE_SEPARATOR}${mode}`;
}

export function isThemeFollowingSystem(theme: ThemePreference): boolean {
  if (theme === "system") return true;
  return splitThemePreference(theme).mode === "system";
}

export function getThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return [...BUILT_IN_THEME_DEFINITIONS, ...getCustomThemes()];
}

export function isCustomTheme(theme: ThemePreference): boolean {
  const themeId = themeIdFromPreference(theme);
  return getCustomThemes().some((definition) => definition.id === themeId);
}

export function isT3ChatTheme(theme: ThemePreference): boolean {
  return themeIdFromPreference(theme) === T3_CHAT_THEME_ID;
}

function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

function saveCustomThemes(themes: ReadonlyArray<ThemeDefinition>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(themes));
    customThemesSnapshot = themes;
  } catch (cause) {
    throw new Error(
      `Could not save the theme library. ${cause instanceof Error ? cause.message : "Storage is unavailable."}`,
      { cause },
    );
  }
  notifyCustomThemeListeners();
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }
  if (getThemeDefinitions().some((existing) => existing.id === theme.id)) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  saveCustomThemes([...getCustomThemes(), theme]);
  return theme;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }

  const themes = getCustomThemes();
  const themeIndex = themes.findIndex((existing) => existing.id === theme.id);
  if (themeIndex === -1) {
    throw new Error(`The theme "${theme.label}" is not installed.`);
  }

  const nextThemes = [...themes];
  nextThemes[themeIndex] = theme;
  saveCustomThemes(nextThemes);
  return theme;
}

export function removeCustomTheme(themeId: string): void {
  const nextThemes = getCustomThemes().filter((theme) => theme.id !== themeId);
  if (nextThemes.length === getCustomThemes().length) return;
  saveCustomThemes(nextThemes);
}

function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    if (!isThemeColor(color)) {
      throw new Error(`The color for "${role}" must be a hex color such as #8b5cf6.`);
    }
    overrides[role as ThemeColorRole] = color;
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) {
    throw new Error("Theme files must contain a JSON object.");
  }
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  const rawColors = value.colors;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  const overrides = parseThemeColorOverrides(rawColors);

  const fallback = getDefaultThemeColors(appearance);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      const variantFallback = getDefaultThemeColors(variantAppearance);
      variants[variantAppearance] = {
        ...variantFallback,
        ...parseThemeColorOverrides(variantColors),
      };
    }
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...fallback, ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover",
};

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  if (!root?.style) return;

  const palette = getThemeDefinition(theme);

  if (palette) {
    root.dataset.themeId = palette.id;
    // The resolved appearance is authoritative. This lets a two-mode theme
    // follow the system even when its stored preference includes a mode suffix.
    const mode = appearance ?? explicitThemeMode(theme) ?? palette.appearance;
    const colors = getThemeColorsForMode(palette, mode) ?? palette.colors;
    for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
      root.style.setProperty(APP_THEME_VARIABLES[role], value);
    }
    return;
  }

  delete root.dataset.themeId;
  for (const variable of Object.values(APP_THEME_VARIABLES)) {
    root.style.removeProperty(variable);
  }
}

export function resolveThemeAppearance(
  theme: ThemePreference,
  systemDark: boolean,
  followSystem?: boolean,
): "light" | "dark" {
  const systemAppearance = systemDark ? "dark" : "light";
  if (followSystem ?? isThemeFollowingSystem(theme)) {
    const definition = getThemeDefinition(theme);
    return definition && getThemeColorsForMode(definition, systemAppearance) === null
      ? definition.appearance
      : systemAppearance;
  }
  return getThemePreferenceMode(theme) ?? "light";
}

export function resolveDesktopTheme(
  theme: ThemePreference,
  followSystem?: boolean,
): "light" | "dark" | "system" {
  if (followSystem ?? isThemeFollowingSystem(theme)) {
    const definition = getThemeDefinition(theme);
    const hasLightMode = definition && getThemeColorsForMode(definition, "light") !== null;
    const hasDarkMode = definition && getThemeColorsForMode(definition, "dark") !== null;
    return definition && (!hasLightMode || !hasDarkMode) ? definition.appearance : "system";
  }
  return getThemePreferenceMode(theme) ?? "system";
}

export function isKnownThemePreference(theme: string): boolean {
  if (theme === "light" || theme === "dark" || theme === "system") return true;
  const parts = splitThemePreference(theme);
  if (parts.invalidMode) return false;
  const definition = getThemeDefinition(theme);
  if (!definition) return false;
  const mode = getThemePreferenceMode(theme);
  return mode === null || getThemeColorsForMode(definition, mode) !== null;
}
