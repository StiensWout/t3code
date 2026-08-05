import { EyeIcon, PlusIcon } from "lucide-react";
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
import { Alert } from "../ui/alert";
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
import { Switch } from "../ui/switch";
import { ThemeColorField } from "./ThemeColorPicker";
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
  description: string;
  roles: ReadonlyArray<ThemeColorRole>;
}> = [
  {
    id: "main",
    title: "Main colors",
    description: "Surfaces, text, accents, and message actions.",
    roles: THEME_EDITOR_PRIMARY_ROLES,
  },
  {
    id: "status",
    title: "Status colors",
    description: "Errors, warnings, and update notices.",
    roles: THEME_EDITOR_STATUS_ROLES,
  },
  {
    id: "additional",
    title: "Additional colors",
    description: "Fine-tune the remaining interface, code, and terminal roles.",
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

export function ThemeEditorDialog({
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
  onSaved: (theme: ThemeDefinition) => boolean;
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
  const [isPeeking, setIsPeeking] = useState(false);
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

  // Holding the peek control fades the editor and its scrim out of the way.
  useEffect(() => {
    if (!isPeeking) return;
    document.documentElement.dataset.themeEditorPeek = "true";
    return () => {
      delete document.documentElement.dataset.themeEditorPeek;
    };
  }, [isPeeking]);

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
      if (!onSaved(savedTheme)) {
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
      <p className="text-xs leading-relaxed text-muted-foreground">
        {modeSelection === "both"
          ? "Separate light and dark palettes."
          : "One palette for light and dark."}
      </p>
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

  const renderGuidedColorFields = (appearance: ThemeAppearance = activeAppearance) => (
    <div className="grid gap-2 sm:grid-cols-2">
      {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
        <ThemeColorField
          key={role}
          onChange={updateColor}
          role={role}
          label={role === "canvas" ? "Background tint" : "Accent color"}
          value={colorsByAppearance[appearance][role]}
        />
      ))}
    </div>
  );

  const renderColorsHeader = () => (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium">{isAdvanced ? "Theme colors" : "Guided colors"}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {isAdvanced
            ? "Full control over every color role."
            : "Pick two colors — T3 Code builds the rest."}
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

  // The same miniature app wireframe as the Appearance settings screen, fed
  // with the live draft palette for the appearance being edited.
  const renderPreviewColumn = () => (
    <div className="space-y-2 sm:sticky sm:top-0 sm:self-start">
      <ThemeWireframe className="h-40" panes={[{ colors: colorsByAppearance[activeAppearance] }]} />
      {/* The app already wears the draft; this just moves the editor aside so
          the rest of it can be seen. Hold rather than toggle, so the editor
          can never be left hidden. */}
      <Button
        className="w-full"
        size="xs"
        variant="outline"
        onBlur={() => setIsPeeking(false)}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") setIsPeeking(true);
        }}
        onKeyUp={() => setIsPeeking(false)}
        onPointerCancel={() => setIsPeeking(false)}
        onPointerDown={() => setIsPeeking(true)}
        onPointerLeave={() => setIsPeeking(false)}
        onPointerUp={() => setIsPeeking(false)}
      >
        <EyeIcon />
        Hold to see the app
      </Button>
    </div>
  );

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
            {isEditing ? "Tweak the name or colors." : "Make T3 Code yours."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
            <div className="space-y-5">
              {renderNameField()}
              {renderModeButtons()}
              {renderAppearanceButtons()}
              <div className="space-y-3">
                {renderColorsHeader()}
                {isAdvanced ? null : renderGuidedColorFields()}
              </div>
            </div>
            {renderPreviewColumn()}
          </div>

          {isAdvanced ? (
            <div className="space-y-4 rounded-lg border p-4">
              {THEME_EDITOR_ROLE_GROUPS.map((group) => (
                <div className="space-y-2" key={group.id}>
                  <div>
                    <h4 className="text-sm font-medium">{group.title}</h4>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {group.description}
                    </p>
                  </div>
                  {renderRoleFields(group.roles, "grid gap-2 sm:grid-cols-2 md:grid-cols-3")}
                </div>
              ))}
            </div>
          ) : null}

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
