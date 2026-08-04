import {
  DownloadIcon,
  MoonIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  UIEvent,
} from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createManagedThemeColors,
  getDefaultThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  serializeThemeFile,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
  T3_CHAT_THEME,
  T3_EMBER_THEME,
  T3_GROVE_THEME,
  T3_IRIS_THEME,
  T3_OCEAN_THEME,
} from "../../themePalette";
import { Alert } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

const THEME_PREVIEW_ROLES = [
  "sidebar",
  "canvas",
  "surface",
  "accentSurface",
  "accent",
  "messageSurface",
  "messageAction",
] as const;
type ThemePreviewRole = (typeof THEME_PREVIEW_ROLES)[number];
type ThemeCardPreview = {
  mode: ThemeAppearance;
  colors: Readonly<Record<ThemePreviewRole, string>>;
};
type ThemeCardDefinition = {
  id: string;
  label: string;
  previews: ReadonlyArray<ThemeCardPreview>;
};
type ThemeMode = ThemeAppearance | "system";

const STANDARD_THEME_PREVIEW_COLORS: Record<
  ThemeAppearance,
  Readonly<Record<ThemePreviewRole, string>>
> = {
  light: {
    sidebar: "#fafafa",
    canvas: "#fcfcfc",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    accent: "#f4f4f5",
    messageSurface: "#e4e4e7",
    messageAction: "#4f46e5",
  },
  dark: {
    sidebar: "#0f0f10",
    canvas: "#0a0a0a",
    surface: "#121212",
    accentSurface: "#27272a",
    accent: "#1c1c1f",
    messageSurface: "#27272a",
    messageAction: "#8b9cff",
  },
};

function getStandardThemeCards(): ReadonlyArray<ThemeCardDefinition> {
  return [
    {
      id: "default",
      label: "Default",
      previews: (["light", "dark"] as const).map((mode) => ({
        mode,
        colors: STANDARD_THEME_PREVIEW_COLORS[mode],
      })),
    },
  ];
}

function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
  return {
    id: theme.id,
    label: theme.label,
    previews: getThemeModes(theme).map((mode) => {
      const colors = getThemeColorsForMode(theme, mode) ?? theme.colors;
      return {
        mode,
        colors: {
          sidebar: colors.sidebar,
          canvas: colors.canvas,
          surface: colors.surface,
          accentSurface: colors.accentSurface,
          accent: colors.accent,
          messageSurface: colors.messageSurface,
          messageAction: colors.messageAction,
        },
      };
    }),
  };
}

const THEME_EDITOR_PRIMARY_ROLES: ReadonlyArray<ThemeColorRole> = [
  "canvas",
  "chrome",
  "sidebar",
  "surface",
  "text",
  "textMuted",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "accent",
  "messageSurface",
  "messageAction",
];

const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

const THEME_EDITOR_STATUS_ROLES: ReadonlyArray<ThemeColorRole> = [
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
];

const THEME_EDITOR_ADVANCED_ROLES = THEME_COLOR_ROLES.filter(
  (role) => !THEME_EDITOR_PRIMARY_ROLES.includes(role) && !THEME_EDITOR_STATUS_ROLES.includes(role),
);

type ThemeEditorColors = Record<ThemeColorRole, string>;
type ThemeEditorModeSelection = "single" | "both";
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getDefaultThemeColors(appearance) };
}

function getThemeEditorColorsByAppearance(): ThemeEditorColorsByAppearance {
  return {
    light: getThemeEditorDefaults("light"),
    dark: getThemeEditorDefaults("dark"),
  };
}

function isThemeEditorColor(value: string): boolean {
  return isThemeColor(value.trim());
}

function getManagedEditorColors(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): ThemeEditorColors {
  const defaults = getDefaultThemeColors(appearance);
  return createManagedThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

/**
 * Whether a palette matches what the guided editor would generate from its
 * canvas and accent, allowing one step of hex rounding drift per channel.
 * Hand-tuned palettes must open in advanced mode so guided regeneration does
 * not silently discard them.
 */
function areThemeEditorColorsManaged(
  appearance: ThemeAppearance,
  colors: ThemeEditorColors,
): boolean {
  const managed = getManagedEditorColors(appearance, colors);
  return THEME_COLOR_ROLES.every((role) => {
    const actual = themeHexToRgb(colors[role]);
    const expected = themeHexToRgb(managed[role]);
    return actual.every((channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= 2);
  });
}

function getThemeRoleLabel(role: ThemeColorRole): string {
  const labels: Partial<Record<ThemeColorRole, string>> = {
    canvas: "Background",
    toolbar: "Toolbar background",
    toolbarForeground: "Toolbar text",
    toolbarBorder: "Toolbar border",
    toolbarControl: "Toolbar control",
    toolbarControlForeground: "Toolbar control text",
    toolbarControlHover: "Toolbar control hover",
    accent: "Accent color",
    errorForeground: "Error text",
    errorSurface: "Error background",
    warningForeground: "Warning text",
    warningSurface: "Warning background",
    updateForeground: "Update text",
    updateSurface: "Update background",
  };
  const label = labels[role];
  if (label) return label;
  return role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

type ThemeColorHsv = {
  h: number;
  s: number;
  v: number;
};

function clampThemeColor(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeThemePickerColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed
      .slice(1)
      .split("")
      .map((character) => `${character}${character}`)
      .join("")}`;
  }
  if (/^#[0-9a-f]{4}$/i.test(trimmed)) {
    return `#${trimmed
      .slice(1, 4)
      .split("")
      .map((character) => `${character}${character}`)
      .join("")}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) return trimmed.slice(0, 7);
  return "#000000";
}

function themeHexToHsv(hex: string): ThemeColorHsv {
  const normalized = normalizeThemePickerColor(hex);
  const numeric = Number.parseInt(normalized.slice(1), 16);
  const red = ((numeric >> 16) & 255) / 255;
  const green = ((numeric >> 8) & 255) / 255;
  const blue = (numeric & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function themeHsvToHex(hue: number, saturation: number, value: number) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = value - chroma;
  const [red, green, blue] =
    normalizedHue < 60
      ? [chroma, x, 0]
      : normalizedHue < 120
        ? [x, chroma, 0]
        : normalizedHue < 180
          ? [0, chroma, x]
          : normalizedHue < 240
            ? [0, x, chroma]
            : normalizedHue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function themeHexToRgb(hex: string) {
  const numeric = Number.parseInt(normalizeThemePickerColor(hex).slice(1), 16);
  return [numeric >> 16, (numeric >> 8) & 255, numeric & 255] as const;
}

function themeRgbToHex(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^rgb\(\s*/i, "")
    .replace(/\s*\)$/, "");
  const channels = normalized
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    return null;
  }

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function themeRgbValue(hex: string) {
  return themeHexToRgb(hex).join(", ");
}

function ThemeColorPickerPanel({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const normalizedValue = normalizeThemePickerColor(value);
  const [hsv, setHsv] = useState(() => themeHexToHsv(normalizedValue));
  const [hexDraft, setHexDraft] = useState(normalizedValue);
  const [rgbDraft, setRgbDraft] = useState(() => themeRgbValue(normalizedValue));
  const currentColor = themeHsvToHex(hsv.h, hsv.s, hsv.v);
  const currentRgb = themeRgbValue(currentColor);

  useEffect(() => {
    setHexDraft(normalizedValue);
    setRgbDraft(themeRgbValue(normalizedValue));
    // Keep the current hue/saturation when the incoming value is just our own
    // change echoed back; hex → HSV is lossy for greys, white, and black.
    setHsv((current) =>
      themeHsvToHex(current.h, current.s, current.v) === normalizedValue
        ? current
        : themeHexToHsv(normalizedValue),
    );
  }, [normalizedValue]);

  const commitHsv = useCallback(
    (nextHsv: ThemeColorHsv) => {
      setHsv(nextHsv);
      const nextColor = themeHsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
      setHexDraft(nextColor);
      setRgbDraft(themeRgbValue(nextColor));
      onChange(nextColor);
    },
    [onChange],
  );

  const updateFromPlane = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const saturation = clampThemeColor((event.clientX - bounds.left) / bounds.width);
      const value = 1 - clampThemeColor((event.clientY - bounds.top) / bounds.height);
      commitHsv({ ...hsv, s: saturation, v: value });
    },
    [commitHsv, hsv],
  );

  const updateFromHue = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const hue = clampThemeColor((event.clientX - bounds.left) / bounds.width) * 360;
      commitHsv({ ...hsv, h: hue });
    },
    [commitHsv, hsv],
  );

  const handleHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    commitHsv({ ...hsv, h: (hsv.h + direction * step + 360) % 360 });
  };

  const handlePointerDown = (handler: (event: PointerEvent<HTMLDivElement>) => void) => {
    return (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      handler(event);
    };
  };

  const handleHexChange = (nextValue: string) => {
    setHexDraft(nextValue);
    if (!/^#[0-9a-f]{6}$/i.test(nextValue)) return;
    const nextHsv = themeHexToHsv(nextValue);
    setHsv(nextHsv);
    setRgbDraft(themeRgbValue(nextValue));
    onChange(nextValue.toLowerCase());
  };

  const handleRgbChange = (nextValue: string) => {
    setRgbDraft(nextValue);
    const nextColor = themeRgbToHex(nextValue);
    if (!nextColor) return;
    setHsv(themeHexToHsv(nextColor));
    setHexDraft(nextColor);
    onChange(nextColor);
  };

  return (
    <div className="w-64 bg-popover">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{label}</p>
          <p className="text-[11px] text-muted-foreground">Choose a color</p>
        </div>
        <span
          className="size-7 shrink-0 rounded-full border border-border shadow-sm"
          style={{ backgroundColor: currentColor }}
        />
      </div>
      <div className="grid gap-3 px-3 pb-3 pt-3">
        <div
          className="relative h-32 cursor-crosshair touch-none overflow-hidden rounded-lg"
          style={{
            backgroundColor: `hsl(${hsv.h} 100% 50%)`,
            backgroundImage:
              "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
          }}
          onPointerDown={handlePointerDown(updateFromPlane)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPlane(event);
          }}
        >
          <span
            className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>
        <div
          aria-label={`${label} hue`}
          aria-valuemax={360}
          aria-valuemin={0}
          aria-valuenow={Math.round(hsv.h)}
          className="relative h-2.5 cursor-pointer touch-none rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0_/_12%)]"
          role="slider"
          style={{
            background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
          }}
          tabIndex={0}
          onKeyDown={handleHueKeyDown}
          onPointerDown={handlePointerDown(updateFromHue)}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromHue(event);
          }}
        >
          <span
            className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"
            style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: currentColor }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              HEX
            </span>
            <span className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <span
                className="size-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: currentColor }}
              />
              <input
                aria-label={`${label} picker hex value`}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleHexChange(event.currentTarget.value)}
                spellCheck={false}
                value={hexDraft}
              />
            </span>
          </label>
          <label className="grid min-w-0 gap-1">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              RGB
            </span>
            <span className="flex min-w-0 items-center rounded-lg border border-input bg-background px-2 focus-within:border-ring">
              <input
                aria-label={`${label} picker RGB value`}
                className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none"
                onBlur={() => {
                  setHexDraft(currentColor);
                  setRgbDraft(currentRgb);
                }}
                onChange={(event) => handleRgbChange(event.currentTarget.value)}
                spellCheck={false}
                value={rgbDraft}
              />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

function ThemeColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label={`Choose ${label} color`}
            className="relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            title={`Choose ${label} color`}
            type="button"
          >
            <span
              className="absolute inset-0.5 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255_/_28%),0_1px_2px_rgb(0_0_0_/_14%)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255_/_18%),0_1px_2px_rgb(0_0_0_/_30%)]"
              style={{ backgroundColor: value }}
            />
          </button>
        }
      />
      <PopoverPopup
        align="start"
        className="overflow-hidden rounded-2xl border border-border/70 p-0 shadow-2xl [--viewport-inline-padding:0px] [&_[data-slot=popover-viewport]]:p-0"
        side="bottom"
        sideOffset={10}
      >
        <ThemeColorPickerPanel label={label} onChange={onChange} value={value} />
      </PopoverPopup>
    </Popover>
  );
}

const ThemeColorField = memo(function ThemeColorField({
  role,
  value,
  onChange,
  label: customLabel,
}: {
  role: ThemeColorRole;
  value: string;
  onChange: (role: ThemeColorRole, value: string) => void;
  label?: string;
}) {
  const label = customLabel ?? getThemeRoleLabel(role);
  const isColorValue = isThemeColor(value);
  const swatchValue = isColorValue ? value : "#000000";

  return (
    <div className="group flex min-h-11 min-w-0 items-center gap-2 border-b border-border/70 px-1.5 py-1.5 transition-colors hover:bg-accent/40">
      <ThemeColorPicker
        label={label}
        onChange={(nextValue) => onChange(role, nextValue)}
        value={swatchValue}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{label}</span>
      <Input
        aria-invalid={!isColorValue}
        aria-label={`${label} hex value`}
        className="w-28 shrink-0 rounded-none border-0 border-b border-input bg-transparent font-mono text-xs text-foreground shadow-none focus-within:border-ring focus-within:ring-0"
        id={`${role}-hex`}
        nativeInput
        onChange={(event) => onChange(role, event.currentTarget.value)}
        size="sm"
        unstyled
        value={value}
      />
    </div>
  );
});

function ThemeEditorDialog({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (theme: ThemeDefinition) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
}) {
  const isEditing = editingTheme !== null;
  const [name, setName] = useState("");
  const [modeSelection, setModeSelection] = useState<ThemeEditorModeSelection>("single");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );
  const [simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance] = useState<
    Record<ThemeAppearance, boolean>
  >({ light: false, dark: false });
  const [error, setError] = useState<string | null>(null);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      const nextColors = getThemeEditorColorsByAppearance();
      const nextAppearance = editingTheme
        ? getThemeColorsForMode(editingTheme, initialAppearance)
          ? initialAppearance
          : editingTheme.appearance
        : initialAppearance;
      if (editingTheme) {
        nextColors[editingTheme.appearance] = { ...editingTheme.colors };
        for (const appearance of ["light", "dark"] as const) {
          const variantColors = editingTheme.variants?.[appearance];
          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? "");
      setModeSelection(editingTheme && getThemeModes(editingTheme).length > 1 ? "both" : "single");
      setActiveAppearance(nextAppearance);
      setIsAdvanced(
        editingTheme !== null &&
          getThemeModes(editingTheme).some(
            (mode) => !areThemeEditorColorsManaged(mode, nextColors[mode]),
          ),
      );
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setColorsByAppearance(nextColors);
      setError(null);
    }
    previousOpenRef.current = open;
  }, [editingTheme, initialAppearance, open]);

  const updateColor = useCallback(
    (role: ThemeColorRole, value: string) => {
      setColorsByAppearance((current) => {
        const nextColors = { ...current[activeAppearance], [role]: value };
        const shouldManageColors =
          !isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value);

        return {
          ...current,
          [activeAppearance]: shouldManageColors
            ? getManagedEditorColors(activeAppearance, nextColors)
            : nextColors,
        };
      });
      if (!isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value)) {
        setSimpleColorsDirtyByAppearance((current) => ({
          ...current,
          [activeAppearance]: true,
        }));
      }
    },
    [activeAppearance, isAdvanced],
  );

  const handleAdvancedChange = useCallback(
    (checked: boolean) => {
      setIsAdvanced(checked);
      if (checked) return;

      // Regenerate every appearance the theme will save, not just the visible
      // one, so the palettes shown after toggling match what gets saved.
      const managedAppearances: ReadonlyArray<ThemeAppearance> =
        modeSelection === "both" ? ["light", "dark"] : [activeAppearance];
      setSimpleColorsDirtyByAppearance((current) => {
        const next = { ...current };
        for (const appearance of managedAppearances) next[appearance] = true;
        return next;
      });
      setColorsByAppearance((current) => {
        const next = { ...current };
        for (const appearance of managedAppearances) {
          next[appearance] = getManagedEditorColors(appearance, current[appearance]);
        }
        return next;
      });
    },
    [activeAppearance, modeSelection],
  );

  const handleSubmit = useCallback(() => {
    if (!name.trim()) {
      setError("Give your theme a name before saving it.");
      return;
    }

    try {
      const baseAppearance =
        editingTheme && modeSelection === "both" ? editingTheme.appearance : activeAppearance;
      const variantAppearance = baseAppearance === "light" ? "dark" : "light";
      // Only regenerate palettes the user actually touched in guided mode, so
      // untouched appearances save exactly what the editor displayed.
      const colorsForSave = !isAdvanced
        ? {
            light: simpleColorsDirtyByAppearance.light
              ? getManagedEditorColors("light", colorsByAppearance.light)
              : colorsByAppearance.light,
            dark: simpleColorsDirtyByAppearance.dark
              ? getManagedEditorColors("dark", colorsByAppearance.dark)
              : colorsByAppearance.dark,
          }
        : colorsByAppearance;
      const variants =
        modeSelection === "both"
          ? { [variantAppearance]: colorsForSave[variantAppearance] }
          : undefined;
      const themeFile = {
        version: THEME_FILE_VERSION,
        ...(editingTheme ? { id: editingTheme.id } : {}),
        name,
        appearance: baseAppearance,
        colors: colorsForSave[baseAppearance],
        ...(variants ? { variants } : {}),
      };
      const savedTheme = editingTheme
        ? updateCustomTheme(parseThemeFile(themeFile))
        : installCustomTheme(parseThemeFile(themeFile));
      if (!onSaved(savedTheme)) {
        setError("Theme saved, but it could not be made active. Try again.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEditing
            ? "Could not save the theme."
            : "Could not create the theme.",
      );
    }
  }, [
    activeAppearance,
    colorsByAppearance,
    editingTheme,
    isAdvanced,
    isEditing,
    modeSelection,
    name,
    onOpenChange,
    onSaved,
    simpleColorsDirtyByAppearance,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit theme" : "Create theme"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the name and colors for this personal theme."
              : "Pick a palette for T3 Code. Add a dark version if you need one."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Theme name</span>
            <Input
              autoFocus
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
              value={name}
            />
          </label>

          <div className="space-y-2">
            <span className="text-sm font-medium">Modes</span>
            <div aria-label="Modes" className="grid grid-cols-2 gap-2" role="group">
              <Button
                aria-pressed={modeSelection === "single"}
                variant={modeSelection === "single" ? "secondary" : "outline"}
                onClick={() => setModeSelection("single")}
              >
                One mode
              </Button>
              <Button
                aria-pressed={modeSelection === "both"}
                variant={modeSelection === "both" ? "secondary" : "outline"}
                onClick={() => setModeSelection("both")}
              >
                Dual mode
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {modeSelection === "both"
                ? "Use a separate palette for light and dark mode."
                : "Use the same palette in both modes."}
            </p>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">
              {modeSelection === "both" ? "Colors" : "Appearance"}
            </span>
            <div aria-label="Theme appearance" className="grid grid-cols-2 gap-2" role="group">
              <Button
                aria-pressed={activeAppearance === "light"}
                variant={activeAppearance === "light" ? "secondary" : "outline"}
                onClick={() => setActiveAppearance("light")}
              >
                <SunIcon />
                Light
              </Button>
              <Button
                aria-pressed={activeAppearance === "dark"}
                variant={activeAppearance === "dark" ? "secondary" : "outline"}
                onClick={() => setActiveAppearance("dark")}
              >
                <MoonIcon />
                Dark
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">
                  {isAdvanced ? "Theme colors" : "Guided colors"}
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {isAdvanced
                    ? "Customize every color role used by T3 Code."
                    : "Choose the mood. T3 Code keeps the palette balanced and readable."}
                </p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 pt-0.5 text-sm font-medium">
                <span>Advanced</span>
                <Switch
                  aria-label="Use advanced theme colors"
                  checked={isAdvanced}
                  onCheckedChange={(checked) => handleAdvancedChange(Boolean(checked))}
                />
              </label>
            </div>

            {isAdvanced ? (
              <>
                <div className="space-y-2">
                  <div>
                    <h4 className="text-sm font-medium">Main colors</h4>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Surfaces, text, accents, and message actions.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {THEME_EDITOR_PRIMARY_ROLES.map((role) => (
                      <ThemeColorField
                        key={role}
                        onChange={updateColor}
                        role={role}
                        value={colorsByAppearance[activeAppearance][role]}
                      />
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <h4 className="text-sm font-medium">Status colors</h4>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Errors, warnings, and update notices.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {THEME_EDITOR_STATUS_ROLES.map((role) => (
                      <ThemeColorField
                        key={role}
                        onChange={updateColor}
                        role={role}
                        value={colorsByAppearance[activeAppearance][role]}
                      />
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <h4 className="text-sm font-medium">Additional colors</h4>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Fine-tune the remaining interface, code, and terminal roles.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {THEME_EDITOR_ADVANCED_ROLES.map((role) => (
                      <ThemeColorField
                        key={role}
                        onChange={updateColor}
                        role={role}
                        value={colorsByAppearance[activeAppearance][role]}
                      />
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
                    <ThemeColorField
                      key={role}
                      onChange={updateColor}
                      role={role}
                      label={role === "canvas" ? "Background tint" : "Accent color"}
                      value={colorsByAppearance[activeAppearance][role]}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} onClick={handleSubmit}>
            {isEditing ? (
              "Save changes"
            ) : (
              <>
                <PlusIcon />
                Create theme
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function escapeJsonHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function highlightJson(value: string): string {
  const tokenPattern =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let highlighted = "";
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    highlighted += escapeJsonHtml(value.slice(cursor, index));

    let tokenClass = "theme-json-number";
    if (token.startsWith('"')) {
      tokenClass = /^\s*:/.test(value.slice(index + token.length))
        ? "theme-json-key"
        : "theme-json-string";
    } else if (token === "true" || token === "false" || token === "null") {
      tokenClass = "theme-json-constant";
    }
    highlighted += `<span class="${tokenClass}">${escapeJsonHtml(token)}</span>`;
    cursor = index + token.length;
  }

  return highlighted + escapeJsonHtml(value.slice(cursor));
}

function ThemeJsonEditor({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const highlightedJson = useMemo(() => highlightJson(value), [value]);

  const syncScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    const highlightElement = highlightRef.current;
    if (!highlightElement) return;
    highlightElement.scrollTop = event.currentTarget.scrollTop;
    highlightElement.scrollLeft = event.currentTarget.scrollLeft;
  }, []);

  return (
    <div className="relative overflow-hidden rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
      <pre
        ref={highlightRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-foreground"
      >
        <code dangerouslySetInnerHTML={{ __html: highlightedJson }} />
      </pre>
      <textarea
        aria-label="Theme JSON"
        className="relative z-10 block min-h-72 w-full resize-y overflow-auto bg-transparent p-3 font-mono text-[12px] leading-5 text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-accent/30 selection:text-transparent"
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={syncScroll}
        placeholder={
          '{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'
        }
        spellCheck={false}
        value={value}
      />
    </div>
  );
}

function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (theme: ThemeDefinition) => boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const importRequestRef = useRef(0);

  useEffect(() => {
    importRequestRef.current += 1;
    if (!open) return;
    setJson("");
    setFileName(null);
    setError(null);
    setIsReading(false);
  }, [open]);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    const requestId = ++importRequestRef.current;
    setIsReading(true);
    try {
      const fileText = await file.text();
      if (requestId !== importRequestRef.current) return;
      setJson(fileText);
      setFileName(file.name);
      setError(null);
    } catch {
      if (requestId !== importRequestRef.current) return;
      setError("Could not read that file. Paste the JSON below instead.");
    } finally {
      if (requestId === importRequestRef.current) setIsReading(false);
    }
  }, []);

  const handleSubmit = useCallback(() => {
    try {
      const installedTheme = installCustomTheme(parseThemeFile(JSON.parse(json)));
      if (!onImported(installedTheme)) {
        setError("Theme added, but it could not be selected. Try again.");
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file is invalid.");
    }
  }, [json, onImported, onOpenChange]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setError(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add a theme</DialogTitle>
          <DialogDescription>
            Choose a JSON file or paste one below. Both options use the same theme format.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Theme file</p>
              <p className="truncate text-xs text-muted-foreground">
                {fileName ?? "Upload a .json file, or paste the contents below."}
              </p>
            </div>
            <Button
              disabled={isReading}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
              {isReading ? "Reading…" : "Choose JSON file"}
            </Button>
            <input
              ref={fileInputRef}
              accept=".json,application/json"
              className="sr-only"
              onChange={handleFileChange}
              type="file"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="theme-json-editor">
                Paste theme JSON
              </label>
              <span className="text-xs text-muted-foreground">JSON</span>
            </div>
            <ThemeJsonEditor id="theme-json-editor" onChange={setJson} value={json} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Export a theme from T3 Code to get a complete file, then edit the colors you want.
            </p>
          </div>

          {error ? (
            <Alert aria-live="polite" variant="error">
              {error}
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!json.trim() || isReading} onClick={handleSubmit}>
            <PlusIcon />
            Add theme
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function getThemePreviewStyle(
  colors: ThemeCardPreview["colors"],
  mode: ThemeAppearance,
): CSSProperties {
  const isDark = mode === "dark";
  const accentX = isDark ? 24 : 76;
  const accentY = isDark ? 76 : 24;
  const actionX = isDark ? 76 : 24;
  const modeBase = isDark
    ? `color-mix(in srgb, ${colors.canvas} 25%, #09090b)`
    : `color-mix(in srgb, ${colors.canvas} 25%, #ffffff)`;
  const accentFade = isDark ? 62 : 72;
  const actionFade = isDark ? 54 : 64;
  const gradient = [
    `radial-gradient(circle at ${accentX}% ${accentY}%, ${colors.accent} 0%, color-mix(in srgb, ${colors.accent} ${accentFade}%, transparent) 30%, transparent 60%)`,
    `radial-gradient(circle at ${actionX}% ${accentY}%, ${colors.messageAction} 0%, color-mix(in srgb, ${colors.messageAction} ${actionFade}%, transparent) 20%, transparent 48%)`,
    `linear-gradient(145deg, ${modeBase} 0%, ${modeBase} 100%)`,
  ].join(", ");
  return {
    backgroundColor: modeBase,
    backgroundImage: gradient,
  };
}

function ThemePreviewCircle({
  colors,
  mode,
}: {
  colors: ThemeCardPreview["colors"];
  mode: ThemeAppearance;
}) {
  return (
    <span
      aria-hidden
      className="block size-14 shrink-0 rounded-full border-2 border-background shadow-sm"
      style={getThemePreviewStyle(colors, mode)}
    />
  );
}

function ThemePreviewAutoCircle({
  light,
  dark,
}: {
  light: ThemeCardPreview["colors"];
  dark: ThemeCardPreview["colors"];
}) {
  return (
    <span
      aria-hidden
      className="relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background shadow-sm"
    >
      <span
        className="absolute inset-0"
        style={{
          ...getThemePreviewStyle(dark, "dark"),
          clipPath: "polygon(0 0, 100% 0, 0 100%)",
        }}
      />
      <span
        className="absolute inset-0"
        style={{
          ...getThemePreviewStyle(light, "light"),
          clipPath: "polygon(100% 0, 100% 100%, 0 100%)",
        }}
      />
      <span
        className="pointer-events-none absolute left-1/2 top-[-8%] h-[116%] w-px bg-background"
        style={{ transform: "rotate(45deg)" }}
      />
    </span>
  );
}

function ThemePreviewCircles({
  label,
  activeMode,
  onSelectMode,
  previews,
}: {
  label: string;
  activeMode: ThemeMode | null;
  onSelectMode: (mode: ThemeMode) => void;
  previews: ThemeCardDefinition["previews"];
}) {
  const lightPreview = previews.find((preview) => preview.mode === "light");
  const darkPreview = previews.find((preview) => preview.mode === "dark");
  const hasDualMode = lightPreview !== undefined && darkPreview !== undefined;

  const renderModeButton = (mode: ThemeMode, content: ReactNode) => {
    const isActive = activeMode === mode;
    return (
      <button
        aria-label={`Use ${label} ${mode === "system" ? "automatic" : mode} mode`}
        aria-pressed={isActive}
        className={cn(
          "relative flex size-[68px] shrink-0 cursor-pointer items-center justify-center rounded-full p-1 outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          isActive && "hover:scale-100",
        )}
        key={mode}
        onClick={(event) => {
          event.stopPropagation();
          onSelectMode(mode);
        }}
        title={mode === "system" ? "Automatic" : mode === "light" ? "Light" : "Dark"}
        type="button"
      >
        {content}
        {isActive ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{ boxShadow: "inset 0 0 0 2px var(--ring)" }}
          />
        ) : null}
      </button>
    );
  };

  return (
    <div className="flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
      {previews.map((preview) =>
        renderModeButton(
          preview.mode,
          <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />,
        ),
      )}
      {hasDualMode
        ? renderModeButton(
            "system",
            <ThemePreviewAutoCircle light={lightPreview.colors} dark={darkPreview.colors} />,
          )
        : null}
    </div>
  );
}

function ThemeLibraryCard({
  theme,
  isActive,
  isPersonal,
  onUse,
  onUseMode,
  activeMode,
  onEdit,
  onDownload,
  onRemove,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  isPersonal: boolean;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeMode?: ThemeMode | null;
  onEdit?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
}) {
  return (
    // The card surface stays a plain div (buttons cannot nest inside a button
    // role); the title button and mode circles carry the accessible actions,
    // while the card click is a pointer-only convenience.
    <div
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
        isActive && "bg-accent/30",
      )}
      data-theme-library-card={theme.id}
      onClick={onUse}
      style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
    >
      <ThemePreviewCircles
        label={theme.label}
        activeMode={isActive ? (activeMode ?? theme.previews[0]?.mode ?? null) : null}
        onSelectMode={onUseMode}
        previews={theme.previews}
      />
      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              aria-label={`Use ${theme.label} theme${isActive ? ", currently active" : ""}`}
              aria-pressed={isActive}
              className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onUse();
              }}
            >
              {theme.label}
            </button>
            {isPersonal ? (
              <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
                Personal
              </span>
            ) : null}
          </div>
        </div>
        {onEdit || onDownload || onRemove ? (
          <div className="flex shrink-0 items-center gap-1">
            {onEdit ? (
              <Button
                aria-label={`Edit ${theme.label}`}
                size="icon-xs"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit();
                }}
              >
                <PenLineIcon />
              </Button>
            ) : null}
            {onDownload ? (
              <Button
                aria-label={`Export ${theme.label}`}
                size="icon-xs"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  onDownload();
                }}
              >
                <DownloadIcon />
              </Button>
            ) : null}
            {onRemove ? (
              <Button
                aria-label={`Remove ${theme.label}`}
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ThemeLibrary({
  theme,
  setTheme,
  appearanceMode,
  setAppearanceMode,
  customThemes,
  initialAppearance,
  refreshTheme,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  setAppearanceMode: (mode: ThemeMode) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
  refreshTheme: () => void;
}) {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [themeToEdit, setThemeToEdit] = useState<ThemeDefinition | null>(null);
  const [themeToRemove, setThemeToRemove] = useState<ThemeDefinition | null>(null);
  // Keep the last removal target so the dialog title stays populated while the
  // close animation plays after confirming.
  const lastThemeToRemoveRef = useRef<ThemeDefinition | null>(null);
  if (themeToRemove) lastThemeToRemoveRef.current = themeToRemove;
  const removeDialogTheme = themeToRemove ?? lastThemeToRemoveRef.current;
  const standardThemes = getStandardThemeCards();
  const maintainerThemes = [
    T3_CHAT_THEME,
    T3_GROVE_THEME,
    T3_OCEAN_THEME,
    T3_EMBER_THEME,
    T3_IRIS_THEME,
  ];

  const notifyThemeSaveFailure = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t save theme selection",
        description: "Try again.",
      }),
    );
  }, []);

  const notifyThemeRemovalFailure = useCallback(() => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t remove theme",
        description: "Try again.",
      }),
    );
  }, []);

  const persistTheme = useCallback(
    (nextTheme: string) => {
      const didSave = setTheme(nextTheme);
      if (!didSave) notifyThemeSaveFailure();
      return didSave;
    },
    [notifyThemeSaveFailure, setTheme],
  );

  const persistThemeMode = useCallback(
    (nextTheme: string, nextMode: ThemeMode) => {
      const previousMode = appearanceMode;
      if (nextMode !== previousMode && !setAppearanceMode(nextMode)) {
        notifyThemeSaveFailure();
        return false;
      }
      if (setTheme(nextTheme)) return true;
      if (nextMode !== previousMode) setAppearanceMode(previousMode);
      notifyThemeSaveFailure();
      return false;
    },
    [appearanceMode, notifyThemeSaveFailure, setAppearanceMode, setTheme],
  );

  const getActiveCardMode = useCallback(
    (card: ThemeCardDefinition): ThemeMode | null => {
      const modes = new Set(card.previews.map((preview) => preview.mode));
      if (appearanceMode === "system" && modes.has("light") && modes.has("dark")) {
        return "system";
      }
      if (appearanceMode !== "system" && modes.has(appearanceMode)) return appearanceMode;
      return card.previews[0]?.mode ?? null;
    },
    [appearanceMode],
  );

  const handleRemoveTheme = useCallback((customTheme: ThemeDefinition) => {
    setThemeToRemove(customTheme);
  }, []);

  const handleConfirmRemoveTheme = useCallback(() => {
    if (!themeToRemove) return;
    // Keep the theme installed if we cannot move the selection off it; the
    // dialog stays open so the user can retry or cancel.
    if (
      getThemeDefinition(theme)?.id === themeToRemove.id &&
      !persistTheme(appearanceMode === "system" ? "system" : appearanceMode)
    ) {
      return;
    }
    try {
      removeCustomTheme(themeToRemove.id);
    } catch {
      notifyThemeRemovalFailure();
      return;
    }
    setThemeToRemove(null);
  }, [appearanceMode, notifyThemeRemovalFailure, persistTheme, theme, themeToRemove]);

  const handleCreatedTheme = useCallback(
    (createdTheme: ThemeDefinition) => {
      if (!persistTheme(createdTheme.id)) return false;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${createdTheme.label} created`,
          description: "It’s now active.",
        }),
      );
      return true;
    },
    [persistTheme],
  );

  const handleEditedTheme = useCallback(
    (updatedTheme: ThemeDefinition) => {
      const wasActive = getThemeDefinition(theme)?.id === updatedTheme.id;
      if (wasActive) {
        if (!persistTheme(updatedTheme.id)) return false;
        refreshTheme();
      }
      setThemeToEdit(null);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${updatedTheme.label} saved`,
          description: wasActive ? "Your changes are now active." : "Your changes are saved.",
        }),
      );
      return true;
    },
    [persistTheme, refreshTheme, theme],
  );

  return (
    <div className="space-y-3 pt-2">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 sm:px-4">
        <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">Themes</h3>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button
            className="h-7 rounded-md border border-border/70 bg-muted/30 px-2 text-xs font-medium text-foreground shadow-none hover:bg-accent/40"
            size="xs"
            variant="ghost"
            onClick={() => setIsCreateOpen(true)}
          >
            <PlusIcon />
            Create theme
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setIsImportOpen(true)}>
            <UploadIcon />
            Import JSON
          </Button>
        </div>
      </div>
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Choose how T3 Code looks. Use a built-in theme or make your own.
      </p>
      <div
        className="mx-auto grid w-full max-w-[56rem] gap-2 px-3 sm:px-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))" }}
      >
        {standardThemes.map((standardTheme) => (
          <ThemeLibraryCard
            activeMode={
              theme === "system" || theme === "light" || theme === "dark"
                ? appearanceMode === "system"
                  ? "system"
                  : appearanceMode
                : null
            }
            isActive={theme === "system" || theme === "light" || theme === "dark"}
            isPersonal={false}
            key={standardTheme.id}
            onUse={() => persistTheme(appearanceMode === "system" ? "system" : appearanceMode)}
            onUseMode={(mode) => persistThemeMode(mode === "system" ? "system" : mode, mode)}
            theme={standardTheme}
          />
        ))}
        {maintainerThemes.map((maintainerTheme) => {
          const isActive = getThemeDefinition(theme)?.id === maintainerTheme.id;
          const card = getThemeCardDefinition(maintainerTheme);
          return (
            <ThemeLibraryCard
              activeMode={isActive ? getActiveCardMode(card) : null}
              isActive={isActive}
              isPersonal={false}
              key={maintainerTheme.id}
              onUse={() => persistTheme(maintainerTheme.id)}
              onUseMode={(mode) => persistThemeMode(maintainerTheme.id, mode)}
              theme={card}
            />
          );
        })}
        {customThemes.map((customTheme) => {
          const isActive = getThemeDefinition(theme)?.id === customTheme.id;
          const card = getThemeCardDefinition(customTheme);
          return (
            <ThemeLibraryCard
              activeMode={isActive ? getActiveCardMode(card) : null}
              isActive={isActive}
              isPersonal
              key={customTheme.id}
              onEdit={() => setThemeToEdit(customTheme)}
              onDownload={() =>
                downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))
              }
              onRemove={() => handleRemoveTheme(customTheme)}
              onUse={() => persistTheme(customTheme.id)}
              onUseMode={(mode) => persistThemeMode(customTheme.id, mode)}
              theme={card}
            />
          );
        })}
      </div>
      {customThemes.length === 0 ? (
        <div className="mx-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:mx-4">
          Your themes will show up here.
        </div>
      ) : null}
      <ThemeEditorDialog
        editingTheme={themeToEdit}
        initialAppearance={initialAppearance}
        onSaved={themeToEdit ? handleEditedTheme : handleCreatedTheme}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateOpen(false);
            setThemeToEdit(null);
          }
        }}
        open={isCreateOpen || themeToEdit !== null}
      />
      <ThemeImportDialog
        onImported={(importedTheme) => {
          if (!persistTheme(importedTheme.id)) return false;
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${importedTheme.label} added`,
              description: "It’s now active.",
            }),
          );
          return true;
        }}
        onOpenChange={setIsImportOpen}
        open={isImportOpen}
      />
      <AlertDialog
        open={themeToRemove !== null}
        onOpenChange={(open) => {
          if (!open) setThemeToRemove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removeDialogTheme?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the theme from your saved themes. You can add it again by importing its
              JSON file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={handleConfirmRemoveTheme}>
              Remove theme
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
