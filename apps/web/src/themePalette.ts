import * as Schema from "effect/Schema";

export const T3_CHAT_THEME_ID = "t3-chat" as const;
export const T3_CHAT_THEME_LABEL = "T3 Chat";
export const T3_CHAT_DARK_THEME_ID = "t3-chat-dark" as const;
export const T3_CHAT_DARK_THEME_LABEL = "T3 Chat Dark";
export const THEME_FILE_VERSION = 1 as const;
export const CUSTOM_THEMES_STORAGE_KEY = "t3code:themes:v1";
export const THEME_FOLLOW_SYSTEM_STORAGE_KEY = "t3code:theme-follow-system";

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
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
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
  T3_CHAT_DARK_THEME_ID,
]);

const customThemeListeners = new Set<() => void>();
let customThemesSnapshot: ReadonlyArray<ThemeDefinition> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

function isThemeColor(value: unknown): value is string {
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

function isThemeColors(value: unknown): value is ThemeColors {
  if (!isRecord(value)) return false;
  return THEME_COLOR_ROLES.every((role) => isThemeColor(value[role]));
}

function parseStoredThemeVariants(value: unknown): ThemeVariants | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance) || !isThemeColors(colors)) return null;
    variants[appearance] = colors;
  }
  return Object.keys(variants).length > 0 ? variants : undefined;
}

function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  if (!isThemeColors(value.colors)) return null;
  const variants = parseStoredThemeVariants(value.variants);
  if (value.variants !== undefined && variants === null) return null;

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors: value.colors,
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
    if (event.key === CUSTOM_THEMES_STORAGE_KEY) invalidateCustomThemes();
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
  return themeId === T3_CHAT_DARK_THEME_ID ? T3_CHAT_THEME_ID : themeId;
}

function themeIdFromPreference(theme: ThemePreference): string {
  return normalizeThemeId(splitThemePreference(theme).id);
}

function explicitThemeMode(theme: ThemePreference): ThemeAppearance | null {
  const parts = splitThemePreference(theme);
  if (parts.id === T3_CHAT_DARK_THEME_ID) return "dark";
  return parts.mode === "light" || parts.mode === "dark" ? parts.mode : null;
}

/**
 * Maintainer palettes use product color roles rather than Tailwind or component
 * names so the same definitions can feed other clients and native surfaces.
 */
const T3_CHAT_LIGHT_COLORS: ThemeColors = {
  canvas: "#fffaff",
  chrome: "#f6e8f7",
  surface: "#fffaff",
  surfaceRaised: "#fff5fd",
  surfaceOverlay: "#fffaff",
  text: "#5c205f",
  textMuted: "#98669a",
  border: "#efc7eb",
  input: "#e8b9e3",
  focus: "#c52d7b",
  accent: "#c52d7b",
  accentForeground: "#fff8ff",
  secondary: "#f9e8f8",
  secondaryForeground: "#7e3a7f",
  muted: "#f7eaf7",
  mutedForeground: "#956a97",
  placeholder: "#855386",
  secondaryLabel: "#7e4f80",
  iconMuted: "#855386",
  accentSurface: "#f5dff3",
  accentSurfaceForeground: "#713071",
  messageSurface: "#f0d1ed",
  messageForeground: "#5c205f",
  messageAction: "#b12268",
  messageActionForeground: "#fff8ff",
  messageActionHover: "#c52d7b",
  sidebar: "#f2e2f4",
  sidebarForeground: "#682a6b",
  sidebarMutedForeground: "#a36ea1",
  sidebarControlSurface: "#ebd2eb",
  sidebarRowHover: "#f8eaf8",
  sidebarRowActive: "#efd4ed",
  sidebarRowSelected: "#f1d9ef",
  sidebarBorder: "#edc0e8",
  terminalBackground: "#fffaff",
  terminalForeground: "#5c205f",
  terminalCursor: "#c52d7b",
  terminalSelection: "#f0c3eb",
  terminalScrollbar: "#dfb0da",
  terminalScrollbarHover: "#cd91c9",
};

const T3_CHAT_DARK_COLORS: ThemeColors = {
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
  accentSurface: "#492244",
  accentSurfaceForeground: "#ffd8f4",
  messageSurface: "#522447",
  messageForeground: "#ffe9fa",
  messageAction: "#df4c96",
  messageActionForeground: "#2a1022",
  messageActionHover: "#f06cab",
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

export const T3_CHAT_THEME: ThemeDefinition = {
  id: T3_CHAT_THEME_ID,
  label: T3_CHAT_THEME_LABEL,
  appearance: "light",
  colors: T3_CHAT_LIGHT_COLORS,
  variants: { dark: T3_CHAT_DARK_COLORS },
};

/**
 * Legacy export retained for callers that use the dark palette as an editor
 * starting point. The selectable theme is now the single T3 Chat definition.
 */
export const T3_CHAT_DARK_THEME: ThemeDefinition = {
  id: T3_CHAT_DARK_THEME_ID,
  label: T3_CHAT_DARK_THEME_LABEL,
  appearance: "dark",
  colors: T3_CHAT_DARK_COLORS,
};

const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = [T3_CHAT_THEME];

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

export function themePreferenceForSystem(
  theme: ThemePreference | ThemeDefinition,
): ThemePreference {
  const definition = typeof theme === "string" ? getThemeDefinition(theme) : theme;
  if (!definition) return "system";
  return `${definition.id}${THEME_PREFERENCE_SEPARATOR}system`;
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

export function removeCustomTheme(themeId: string): void {
  const nextThemes = getCustomThemes().filter((theme) => theme.id !== themeId);
  if (nextThemes.length === getCustomThemes().length) return;
  saveCustomThemes(nextThemes);
}

function parseThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!(THEME_COLOR_ROLES as ReadonlyArray<string>).includes(role)) {
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

  const fallback = appearance === "dark" ? T3_CHAT_DARK_THEME.colors : T3_CHAT_THEME.colors;
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      const variantFallback =
        variantAppearance === "dark" ? T3_CHAT_DARK_THEME.colors : T3_CHAT_THEME.colors;
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
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
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
    // A bare theme id follows the global appearance preference. Only an
    // explicit `theme:light`/`theme:dark` preference should override it.
    const mode = explicitThemeMode(theme) ?? appearance ?? palette.appearance;
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
  if (theme === "dark" || theme === "light") return theme;
  const definition = getThemeDefinition(theme);
  const mode = getThemePreferenceMode(theme);
  if (definition && mode) return mode;
  if (definition) return definition.appearance;
  return "light";
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
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  const definition = getThemeDefinition(theme);
  const mode = getThemePreferenceMode(theme);
  if (definition && mode) return mode;
  if (definition) return definition.appearance;
  return "system";
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
