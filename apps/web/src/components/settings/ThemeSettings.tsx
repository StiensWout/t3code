import { DownloadIcon, PenLineIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  getThemeDefinition,
  removeCustomTheme,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
  T3_CHAT_THEME,
  T3_EMBER_THEME,
  T3_GROVE_THEME,
  T3_IRIS_THEME,
  T3_OCEAN_THEME,
} from "../../themePalette";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThemeEditorDialog } from "./ThemeEditorDialog";
import { ThemeImportDialog } from "./ThemeImportDialog";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";

const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [
  T3_CHAT_THEME,
  T3_GROVE_THEME,
  T3_OCEAN_THEME,
  T3_EMBER_THEME,
  T3_IRIS_THEME,
];

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers; give the
  // browser time to open the stream first.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
  isCreateOpen,
  isImportOpen,
  onCreateOpenChange,
  onImportOpenChange,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  setAppearanceMode: (mode: ThemeMode) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
  refreshTheme: () => void;
  isCreateOpen: boolean;
  isImportOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onImportOpenChange: (open: boolean) => void;
}) {
  const [themeToEdit, setThemeToEdit] = useState<ThemeDefinition | null>(null);
  const [themeToRemove, setThemeToRemove] = useState<ThemeDefinition | null>(null);
  // Keep the last removal target so the dialog title stays populated while the
  // close animation plays after confirming.
  const lastThemeToRemoveRef = useRef<ThemeDefinition | null>(null);
  useEffect(() => {
    if (themeToRemove) lastThemeToRemoveRef.current = themeToRemove;
  }, [themeToRemove]);
  const removeDialogTheme = themeToRemove ?? lastThemeToRemoveRef.current;

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
    <div className="space-y-3">
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Choose how T3 Code looks. Use a built-in theme or make your own.
      </p>
      <div
        className="mx-auto grid w-full max-w-[56rem] gap-2 px-3 sm:px-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17rem), 1fr))" }}
      >
        {STANDARD_THEME_CARDS.map((standardTheme) => (
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
        {MAINTAINER_THEMES.map((maintainerTheme) => {
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
            onCreateOpenChange(false);
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
        onOpenChange={onImportOpenChange}
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
