import { create } from "zustand";

import type { ThemeAppearance } from "../../themePalette";

/**
 * The theme editor lives above the router so a draft survives navigation: the
 * palette is painted on the live app, and judging it means browsing the app
 * while the editor stays open. Themes are referenced by id because the stored
 * definitions change underneath an open session (an edit, an import).
 */
export type ThemeEditorSessionInput = {
  /** Set when editing an installed theme; null creates a new one. */
  editingThemeId: string | null;
  /** Theme a new theme starts from: the active one, or a duplicate target. */
  seedThemeId: string | null;
  /** Prefilled name, used by duplicate. */
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  /**
   * Distinguishes two sessions that name the same themes, so asking for a
   * fresh draft while the panel is already open still reseeds it.
   */
  id: number;
};

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  closeThemeEditor: () => void;
};

let nextSessionId = 0;

export const useThemeEditorStore = create<ThemeEditorStore>((set) => ({
  session: null,
  openThemeEditor: (session) => set({ session: { ...session, id: ++nextSessionId } }),
  closeThemeEditor: () => set({ session: null }),
}));
