import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyThemeColorPreview,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createVividThemeColors,
  getDefaultThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "../../themePalette";
import { cn } from "../../lib/utils";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";
import { ThemeWireframe } from "./ThemeWireframe";

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

const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  roles: ReadonlyArray<ThemeColorRole>;
}> = [
  {
    id: "main",
    title: "Main",
    roles: THEME_EDITOR_PRIMARY_ROLES,
  },
  {
    id: "status",
    title: "Status",
    roles: THEME_EDITOR_STATUS_ROLES,
  },
  {
    id: "additional",
    title: "Other",
    roles: THEME_EDITOR_ADVANCED_ROLES,
  },
];

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
  // The editor keeps the user's exact picks and derives the rest through the
  // perceptual vivid engine, so a two-color theme carries its own identity.
  return createVividThemeColors(
    appearance,
    isThemeEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeEditorColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

export function ThemeEditorPanel({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
  restoreTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (theme: ThemeDefinition, context: { created: boolean }) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  /** The theme a new theme starts from, so tuning what you already use is a
   *  matter of editing rather than rebuilding. Null starts from the defaults. */
  seedTheme?: ThemeDefinition | null;
  /** Prefilled name for an explicit duplicate; a plain create stays unnamed. */
  seedName?: string | undefined;
  /** Reapplies the stored theme once the draft stops being previewed. */
  restoreTheme: () => void;
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
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [side, setSide] = useState<"left" | "right">("right");
  // The draft only reaches the live app once this open has been seeded;
  // previewing in the seeding commit would paint the previous session's
  // colors for a frame.
  const [isDraftSeeded, setIsDraftSeeded] = useState(false);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      // Editing works on the theme itself; creating starts from the theme
      // that is currently in use, so tuning what you already run is an edit
      // away instead of a rebuild from the defaults.
      const sourceTheme = editingTheme ?? seedTheme ?? null;
      const nextColors = getThemeEditorColorsByAppearance();
      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;
      if (sourceTheme) {
        nextColors[sourceTheme.appearance] = { ...sourceTheme.colors };
        for (const appearance of ["light", "dark"] as const) {
          const variantColors = sourceTheme.variants?.[appearance];
          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? seedName ?? "");
      setModeSelection(sourceTheme && getThemeModes(sourceTheme).length > 1 ? "both" : "single");
      setActiveAppearance(nextAppearance);
      // Themes saved by the guided editor carry the managed flag; anything
      // else (imports, hand-edited files, older saves) opens in advanced mode
      // so guided regeneration cannot silently discard hand-tuned colors. A
      // seeded new theme follows the same rule: its palette is only safe to
      // regenerate when the guided editor produced it.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setColorsByAppearance(nextColors);
      setError(null);
      setIsDraftSeeded(true);
    }
    if (!open && isDraftSeeded) setIsDraftSeeded(false);
    previousOpenRef.current = open;
  }, [editingTheme, initialAppearance, isDraftSeeded, open, seedName, seedTheme]);

  // The whole app wears the draft while the editor is open, so a role change
  // is judged on the real interface rather than a miniature. The stored theme
  // comes back when the editor closes, including on cancel.
  useEffect(() => {
    if (!open || !isDraftSeeded) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance, isDraftSeeded, open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

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
      setError("Name your theme first.");
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
        ...(isAdvanced ? {} : { managed: true }),
      };
      const savedTheme = editingTheme
        ? updateCustomTheme(parseThemeFile(themeFile))
        : installCustomTheme(parseThemeFile(themeFile));
      if (!onSaved(savedTheme, { created: editingTheme === null })) {
        if (!editingTheme) {
          // Roll the install back so a retry can run it again instead of
          // failing on the already-taken theme id.
          try {
            removeCustomTheme(savedTheme.id);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        }
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

  const renderNameField = () => (
    <label className="block space-y-2">
      <span className="text-sm font-medium">Theme name</span>
      <Input
        autoFocus
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
        value={name}
      />
    </label>
  );

  const renderModeButtons = () => (
    <div className="space-y-2">
      <span className="text-sm font-medium">Modes</span>
      <div aria-label="Modes" className="grid grid-cols-2 gap-2" role="group">
        <Button
          aria-pressed={modeSelection === "single"}
          style={
            modeSelection === "single" ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined
          }
          variant={modeSelection === "single" ? "secondary" : "outline"}
          onClick={() => setModeSelection("single")}
        >
          One mode
        </Button>
        <Button
          aria-pressed={modeSelection === "both"}
          style={
            modeSelection === "both" ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined
          }
          variant={modeSelection === "both" ? "secondary" : "outline"}
          onClick={() => setModeSelection("both")}
        >
          Dual mode
        </Button>
      </div>
    </div>
  );

  const renderAppearanceButtons = () => (
    <div className="space-y-2">
      <span className="text-sm font-medium">Appearance</span>
      <div aria-label="Theme appearance" className="grid grid-cols-2 gap-2" role="group">
        <Button
          aria-pressed={activeAppearance === "light"}
          style={
            activeAppearance === "light" ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined
          }
          variant={activeAppearance === "light" ? "secondary" : "outline"}
          onClick={() => setActiveAppearance("light")}
        >
          Light
        </Button>
        <Button
          aria-pressed={activeAppearance === "dark"}
          style={
            activeAppearance === "dark" ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined
          }
          variant={activeAppearance === "dark" ? "secondary" : "outline"}
          onClick={() => setActiveAppearance("dark")}
        >
          Dark
        </Button>
      </div>
    </div>
  );

  const renderColorsHeader = () => (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium">Colors</h3>
        <p className="text-xs text-muted-foreground">
          {isAdvanced ? "Every role" : "Two colors, rest derived"}
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
  );

  const renderRoleFields = (
    roles: ReadonlyArray<ThemeColorRole>,
    gridClassName = "grid gap-2 sm:grid-cols-2",
  ) => (
    <div className={gridClassName}>
      {roles.map((role) => (
        <ThemeColorField
          key={role}
          onChange={updateColor}
          role={role}
          value={colorsByAppearance[activeAppearance][role]}
        />
      ))}
    </div>
  );

  const renderColorFields = () => {
    const query = roleQuery.trim().toLowerCase();
    const groups = THEME_EDITOR_ROLE_GROUPS.map((group) => ({
      ...group,
      roles: group.roles.filter(
        (role) => !query || getThemeRoleLabel(role).toLowerCase().includes(query),
      ),
    })).filter((group) => group.roles.length > 0);
    return isAdvanced ? (
      <div className="space-y-2">
        <Input
          aria-label="Filter colors"
          onChange={(event) => setRoleQuery(event.currentTarget.value)}
          placeholder="Filter"
          size="sm"
          value={roleQuery}
        />
        <div className="space-y-3 rounded-lg border p-3">
          {groups.map((group) => (
            <div className="space-y-1" key={group.id}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </span>
              {renderRoleFields(group.roles, "grid gap-1")}
            </div>
          ))}
          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matches.</p>
          ) : null}
        </div>
      </div>
    ) : (
      <div className="grid gap-1">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
          <ThemeColorField
            key={role}
            onChange={updateColor}
            role={role}
            label={role === "canvas" ? "Background" : "Accent"}
            value={colorsByAppearance[activeAppearance][role]}
          />
        ))}
      </div>
    );
  };

  return (
    <div
      aria-label={isEditing ? "Edit theme" : "Create theme"}
      className={cn(
        "fixed bottom-4 z-40 flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl",
        // The panel parks opposite the sidebar and can swap sides when it
        // covers what is being judged.
        side === "right" ? "right-4" : "left-4",
        isMinimized && "max-h-none",
      )}
      role="dialog"
    >
      <div className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {isEditing ? "Edit theme" : "Create theme"}
          </h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">Previewing on the app</p>
          )}
        </div>
        <Button
          aria-label={side === "right" ? "Move panel to the left" : "Move panel to the right"}
          size="icon-xs"
          variant="ghost"
          onClick={() => setSide(side === "right" ? "left" : "right")}
        >
          {side === "right" ? <ArrowLeftIcon /> : <ArrowRightIcon />}
        </Button>
        <Button
          aria-label={isMinimized ? "Expand the theme editor" : "Minimize the theme editor"}
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMinimized(!isMinimized)}
        >
          {isMinimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          aria-label="Close the theme editor"
          size="icon-xs"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </div>

      {isMinimized ? null : (
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
            {renderNameField()}
            <ThemeWireframe
              className="h-28"
              panes={[{ colors: colorsByAppearance[activeAppearance] }]}
            />
            {renderModeButtons()}
            {renderAppearanceButtons()}
            <div className="space-y-3">
              {renderColorsHeader()}
              {renderColorFields()}
            </div>

            {error ? (
              <Alert aria-live="polite" variant="error">
                {error}
              </Alert>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                "Save changes"
              ) : (
                <>
                  <PlusIcon />
                  Create theme
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
