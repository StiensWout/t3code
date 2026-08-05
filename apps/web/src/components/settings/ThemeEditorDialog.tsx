import { MoonIcon, PlusIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createManagedThemeColors,
  getDefaultThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
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

export function ThemeEditorDialog({
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
      // Themes saved by the guided editor carry the managed flag; anything
      // else (imports, hand-edited files, older saves) opens in advanced mode
      // so guided regeneration cannot silently discard hand-tuned colors.
      setIsAdvanced(editingTheme !== null && editingTheme.managed !== true);
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
            {isEditing ? "Tweak the name or colors." : "Make T3 Code yours."}
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
                ? "Separate light and dark palettes."
                : "One palette for light and dark."}
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
