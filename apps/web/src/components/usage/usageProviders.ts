import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, CursorIcon, GrokIcon, type Icon, OpenAI } from "../Icons";

type UsageProviderPresentationKind = UsageProviderKind | "cursor" | "grok";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Series and table order. The chart layers both providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude"];

/**
 * Usage-series presentation, including planned Cursor and Grok support. Their
 * monochrome marks stay on-brand while distinct mode-aware series colors keep
 * a future four-provider chart readable.
 */
export const PROVIDER_PRESENTATION = {
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: OpenAI,
  },
  cursor: {
    label: "Cursor",
    color: "light-dark(var(--color-blue-700), var(--color-blue-300))",
    mark: CursorIcon,
  },
  grok: {
    label: "Grok",
    color: "light-dark(var(--color-violet-700), var(--color-violet-300))",
    mark: GrokIcon,
  },
} satisfies Record<UsageProviderPresentationKind, UsageProviderPresentation>;
