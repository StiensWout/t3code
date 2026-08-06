import { ChevronDownIcon, ChevronUpIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  applyThemeColorPreview,
  THEME_COLOR_ROLES,
  THEME_FILE_VERSION,
  createVividThemeColors,
  getCustomThemes,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  isThemeColor,
  parseThemeFile,
  removeCustomTheme,
  themeIdFromName,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "../../themePalette";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getThemeRoleLabel, ThemeColorField } from "./ThemeColorPicker";

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
type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeEditorColors>;

// A draft with no source theme starts as the standard T3 Code look — the
// palette on screen when no theme is installed — so creating from the default
// theme changes nothing until the user edits a color.
function getThemeEditorDefaults(appearance: ThemeAppearance): ThemeEditorColors {
  return { ...getStandardThemeColors(appearance) };
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
  const defaults = getStandardThemeColors(appearance);
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
  onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      /** Set when a create merged its palette into an existing theme. */
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
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
  // Null parks the panel at its default corner; a value is a dragged spot,
  // kept clamped so the header can always be grabbed again.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => {
    if (position === null) return;
    const clamp = () =>
      setPosition((current) => (current ? clampPosition(current.x, current.y) : current));
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
    // oxlint-disable-next-line exhaustive-deps -- clampPosition reads live layout only.
  }, [position === null]);

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

  // A name an installed theme already uses combines instead of failing:
  // creating adds the new palette to that theme, and renaming an existing
  // theme onto it folds the edited palette in and retires the old entry —
  // light "My Theme" plus a dark "My Theme" become one theme with both modes.
  // Labels are matched as well as derived ids: a rename keeps a theme's
  // original id, so its label is the only name a user can see and retype.
  const nameTargetId = themeIdFromName(name);
  const normalizedName = name.trim().toLowerCase();
  const mergeTarget =
    normalizedName === ""
      ? null
      : (getCustomThemes().find(
          (theme) =>
            theme.id !== editingTheme?.id &&
            (theme.id === nameTargetId || theme.label.trim().toLowerCase() === normalizedName),
        ) ?? null);
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null;

  // The appearance a mode button would produce can be blocked two ways: the
  // merge target already has that palette, or the theme being edited never
  // had it (adding one is a create-with-same-name away).
  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return `“${editingTheme?.label}” has no ${appearance} palette. Create a theme with the same name to add one.`;
    }
    if (!isEditing && takenAppearances.includes(appearance)) {
      return `“${mergeTarget?.label}” already has a ${appearance} palette.`;
    }
    return null;
  };

  // Typing a name whose theme already owns the selected appearance flips the
  // draft to the free side, so the merge affordance works without a manual
  // toggle. Both sides taken leaves the selection alone; save is blocked with
  // an explanation instead.
  const mergeTargetId = mergeTarget?.id ?? null;
  const takenAppearancesKey = takenAppearances.join(",");
  useEffect(() => {
    if (isEditing || mergeTargetId === null) return;
    const taken = takenAppearancesKey.split(",").filter(Boolean) as ThemeAppearance[];
    if (taken.length !== 1) return;
    setActiveAppearance((current) => {
      if (!taken.includes(current)) return current;
      return taken[0] === "light" ? "dark" : "light";
    });
  }, [isEditing, mergeTargetId, takenAppearancesKey]);

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
        editingTheme && getThemeModes(editingTheme).length > 1
          ? ["light", "dark"]
          : [activeAppearance];
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
    [activeAppearance, editingTheme],
  );

  const handleSubmit = useCallback(() => {
    if (!name.trim()) {
      setError("Name your theme first.");
      return;
    }

    try {
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

      let savedTheme: ThemeDefinition;
      let mergedAppearance: ThemeAppearance | null = null;
      let retiredTheme: ThemeDefinition | null = null;
      if (editingTheme && mergeTarget) {
        // Renamed onto another installed theme: this theme's palettes fold
        // into it and the edited entry retires, so both cards become one.
        // Colliding palettes cannot merge — neither side should be silently
        // overwritten.
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));
        if (collision) {
          setError(`“${mergeTarget.label}” already has a ${collision} palette. Pick another name.`);
          return;
        }
        mergedAppearance = editedModes[0] ?? null;
        savedTheme = updateCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])),
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
        );
        retiredTheme = editingTheme;
        removeCustomTheme(editingTheme.id);
      } else if (editingTheme) {
        const baseAppearance = editingTheme.appearance;
        const variantAppearance = baseAppearance === "light" ? "dark" : "light";
        savedTheme = updateCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            id: editingTheme.id,
            name,
            appearance: baseAppearance,
            colors: colorsForSave[baseAppearance],
            ...(getThemeModes(editingTheme).length > 1
              ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } }
              : {}),
            ...(isAdvanced ? {} : { managed: true }),
          }),
        );
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(
            `“${mergeTarget.label}” already has light and dark palettes. Pick another name.`,
          );
          return;
        }
        // The new palette joins the existing theme as its other mode; its
        // stored palettes are untouched. The guided (managed) flag only
        // survives when every palette in the theme came from the guided
        // editor.
        mergedAppearance = activeAppearance;
        savedTheme = updateCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              [activeAppearance]: colorsForSave[activeAppearance],
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
        );
      } else {
        savedTheme = installCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            name,
            appearance: activeAppearance,
            colors: colorsForSave[activeAppearance],
            ...(isAdvanced ? {} : { managed: true }),
          }),
        );
      }
      if (
        !onSaved(savedTheme, {
          created: editingTheme === null && mergedAppearance === null,
          ...(mergedAppearance ? { mergedAppearance } : {}),
        })
      ) {
        if (!editingTheme && mergedAppearance === null) {
          // Roll the install back so a retry can run it again instead of
          // failing on the already-taken theme id.
          try {
            removeCustomTheme(savedTheme.id);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        } else if (mergeTarget && mergedAppearance !== null) {
          // Put the pre-merge definitions back for the same reason.
          try {
            updateCustomTheme(mergeTarget);
            if (retiredTheme) installCustomTheme(retiredTheme);
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
    mergeTarget,
    name,
    onOpenChange,
    onSaved,
    simpleColorsDirtyByAppearance,
    takenAppearances,
  ]);

  const renderNameField = () => (
    <label className="block space-y-2">
      <span className="text-sm font-medium">Theme name</span>
      <Input
        autoFocus
        onChange={(event) => {
          setName(event.currentTarget.value);
          // Most save failures are name collisions; retyping is the fix, so
          // the stale message goes with the old name.
          setError(null);
        }}
        placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
        value={name}
      />
    </label>
  );

  const renderAppearanceButton = (appearance: ThemeAppearance) => {
    const isActive = activeAppearance === appearance;
    const lockReason = appearanceLockReason(appearance);
    // A locked mode stays hoverable so the tooltip can say why it is off;
    // a real disabled attribute would swallow the pointer events.
    const button = (
      <Button
        aria-disabled={lockReason !== null}
        aria-pressed={isActive}
        className={lockReason !== null ? "opacity-50" : undefined}
        style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
        variant={isActive ? "secondary" : "outline"}
        onClick={() => {
          if (lockReason === null) setActiveAppearance(appearance);
        }}
      >
        {appearance === "light" ? "Light" : "Dark"}
      </Button>
    );
    if (lockReason === null) return button;
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup>{lockReason}</TooltipPopup>
      </Tooltip>
    );
  };

  const renderAppearanceButtons = () => (
    <div className="space-y-2">
      <span className="text-sm font-medium">Appearance</span>
      <div aria-label="Theme appearance" className="grid grid-cols-2 gap-2" role="group">
        {renderAppearanceButton("light")}
        {renderAppearanceButton("dark")}
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

  const clampPosition = (x: number, y: number) => {
    const panel = panelRef.current;
    const margin = 8;
    const width = panel?.offsetWidth ?? 0;
    return {
      x: Math.min(Math.max(x, margin), Math.max(margin, window.innerWidth - width - margin)),
      // Keep at least the header on screen even when dragged far down.
      y: Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - 48)),
    };
  };

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Buttons in the header keep their own behavior.
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    setPosition(clampPosition(event.clientX - offset.dx, event.clientY - offset.dy));
  };

  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  return (
    <div
      aria-label={isEditing ? "Edit theme" : "Create theme"}
      className={cn(
        "fixed z-40 flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl",
        position === null && "bottom-4 right-4",
        isMinimized && "max-h-none",
      )}
      ref={panelRef}
      role="dialog"
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-1 border-b border-border/70 px-3 py-2 active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={endDrag}
      >
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {isEditing ? "Edit theme" : "Create theme"}
          </h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">Previewing on the app</p>
          )}
        </div>
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
            {/* Inline and above the color list: the panel scrolls, and an
                error parked below every role would go unseen. */}
            {error ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {renderAppearanceButtons()}
            <div className="space-y-3">
              {renderColorsHeader()}
              {renderColorFields()}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                mergeTarget ? (
                  `Merge into “${mergeTarget.label}”`
                ) : (
                  "Save changes"
                )
              ) : mergeTarget ? (
                <>
                  <PlusIcon />
                  {`Add ${activeAppearance} palette`}
                </>
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
