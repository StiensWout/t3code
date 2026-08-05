import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";
import {
  getThemeColorsForMode,
  getThemeModes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";

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
export type ThemeCardDefinition = {
  id: string;
  label: string;
  previews: ReadonlyArray<ThemeCardPreview>;
};
export type ThemeMode = ThemeAppearance | "system";

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

export const STANDARD_THEME_CARDS: ReadonlyArray<ThemeCardDefinition> = [
  {
    id: "default",
    label: "Default",
    previews: (["light", "dark"] as const).map((mode) => ({
      mode,
      colors: STANDARD_THEME_PREVIEW_COLORS[mode],
    })),
  },
];

export function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
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

// Interpolating in oklab keeps the glow falloff perceptually even (no gray
// mid-tones or banding rings), and premultiplied alpha keeps the fade to
// transparent clean.
function getThemePreviewStyle(
  colors: ThemeCardPreview["colors"],
  mode: ThemeAppearance,
  shape: "full" | "split" = "full",
): CSSProperties {
  const isDark = mode === "dark";
  // The canvas carries the ball's light/dark identity, so it stays dominant:
  // a near-true base with a contained accent glow, instead of an accent wash
  // that makes both modes read alike.
  const modeBase = isDark
    ? `color-mix(in oklab, ${colors.canvas} 80%, #09090b)`
    : `color-mix(in oklab, ${colors.canvas} 80%, #ffffff)`;
  // The split ball shows dark in the top-left triangle and light in the
  // bottom-right, so each half aims its glow at its own visible corner
  // instead of at the seam.
  const accentPosition =
    shape === "split" ? (isDark ? "26% 26%" : "74% 74%") : isDark ? "28% 78%" : "72% 22%";
  const actionPosition = isDark ? "82% 18%" : "18% 82%";
  const accentFade = isDark ? 62 : 72;
  const layers = [
    `radial-gradient(circle at ${accentPosition} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${accentFade}%, transparent) 28%, transparent 58%)`,
  ];
  if (shape === "full") {
    // The action color is a soft tint from the opposite corner, not a second
    // light source — two bright hotspots read as headlights.
    layers.push(
      `radial-gradient(circle at ${actionPosition} in oklab, color-mix(in oklab, ${colors.messageAction} 45%, transparent) 0%, transparent 55%)`,
    );
  }
  return {
    backgroundColor: modeBase,
    backgroundImage: layers.join(", "),
  };
}

// The gradient halves of each ball can match the card surface, so every ball
// carries a faint mode-appropriate inner ring to keep its silhouette legible.
function themePreviewEdgeShadow(mode: ThemeAppearance): string {
  return mode === "dark"
    ? "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)"
    : "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)";
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
      className="block size-14 shrink-0 rounded-full border-2 border-background"
      style={{
        ...getThemePreviewStyle(colors, mode),
        boxShadow: themePreviewEdgeShadow(mode),
      }}
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
  // The halves stop short of the x + y = 100% diagonal so the card surface
  // shows through as the seam; a mode-neutral inner ring outlines the circle.
  return (
    <span
      aria-hidden
      className="relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background"
      style={{ boxShadow: "inset 0 0 0 1px rgb(127 127 127 / 0.22), 0 1px 2px rgb(0 0 0 / 0.10)" }}
    >
      <span
        className="absolute inset-0"
        style={{
          ...getThemePreviewStyle(dark, "dark", "split"),
          clipPath: "polygon(0 0, calc(100% - 2px) 0, 0 calc(100% - 2px))",
        }}
      />
      <span
        className="absolute inset-0"
        style={{
          ...getThemePreviewStyle(light, "light", "split"),
          clipPath: "polygon(100% 2px, 100% 100%, 2px 100%)",
        }}
      />
    </span>
  );
}

export function ThemePreviewCircles({
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
          "relative flex size-[68px] shrink-0 transform-gpu cursor-pointer items-center justify-center rounded-full p-1 outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
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
