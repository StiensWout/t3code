import { type ModelCapabilities, type ProviderOptionChoice } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

/**
 * Pi's full thinking ladder. Extra High (`xhigh`) and Max are opt-in per
 * model via `thinkingLevelMap`; advertising them globally makes
 * `set_thinking_level` fail on models that lack them.
 */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const INHERIT_CHOICE: ProviderOptionChoice = {
  id: "inherit",
  label: "Pi default",
  isDefault: true,
};

export const EMPTY_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export function thinkingCapabilitiesForPiModel(model: unknown): ModelCapabilities {
  const levels = supportedPiThinkingLevelsFromModel(model);
  if (levels.length === 0) return EMPTY_PI_MODEL_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: [
          INHERIT_CHOICE,
          ...levels.map((level) => ({
            id: level,
            label: PI_THINKING_LEVEL_LABELS[level],
          })),
        ],
      },
    ],
  });
}

/**
 * Mirror of `@earendil-works/pi-ai` `getSupportedThinkingLevels`.
 *
 * A reasoning model always exposes off through high unless a map entry is
 * `null`. Extra High and Max appear only when the map has a non-null entry.
 */
export function supportedPiThinkingLevelsFromModel(model: unknown): ReadonlyArray<PiThinkingLevel> {
  if (recordField(model, "reasoning") !== true) return [];
  const thinkingLevelMap = thinkingLevelMapFromModel(model);
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function thinkingLevelMapFromModel(model: unknown): Record<string, unknown> | undefined {
  const value = recordField(model, "thinkingLevelMap");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function recordField(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}
