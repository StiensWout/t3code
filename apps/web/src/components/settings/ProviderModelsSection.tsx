"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged — only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
};

/**
 * Display order for the models list: favorites first (in user order), then
 * visible models, then hidden ones. Hidden models sink so the list reads
 * top-down as "what the picker shows"; moves only swap rows within the same
 * group, and the resulting display order is what gets persisted as
 * `modelOrder`.
 */
export function groupModelsForDisplay<
  T extends { readonly slug: string; readonly isCustom: boolean },
>(
  models: ReadonlyArray<T>,
  options: {
    readonly favoriteModels: ReadonlySet<string>;
    readonly hiddenModels: ReadonlySet<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): T[] {
  const ordered = sortModelsForProviderInstance(models, {
    favoriteModels: options.favoriteModels,
    groupFavorites: true,
    modelOrder: options.modelOrder,
  });
  const isHidden = (model: T) => !model.isCustom && options.hiddenModels.has(model.slug);
  return [
    ...ordered.filter((model) => options.favoriteModels.has(model.slug)),
    ...ordered.filter((model) => !options.favoriteModels.has(model.slug) && !isHidden(model)),
    ...ordered.filter((model) => !options.favoriteModels.has(model.slug) && isHidden(model)),
  ];
}

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model slug list for this instance. Drives dedup,
   * and is the array we hand back verbatim (with the new slug appended /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<string>;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model slugs favorited for this provider instance. */
  readonly favoriteModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const displayModels = useMemo(
    () =>
      groupModelsForDisplay(models, {
        favoriteModels: favoriteModelSet,
        hiddenModels: hiddenModelSet,
        modelOrder,
      }),
    [favoriteModelSet, hiddenModelSet, modelOrder, models],
  );
  const favoriteCount = displayModels.filter((model) => favoriteModelSet.has(model.slug)).length;
  const hiddenCount = displayModels.filter(
    (model) => !model.isCustom && hiddenModelSet.has(model.slug),
  ).length;

  const handleAdd = () => {
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    onChange([...customModels, normalized]);
    setInput("");
    setError(null);
  };

  const handleRemove = (slug: string) => {
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleToggleHidden = (slug: string) => {
    if (hiddenModelSet.has(slug)) {
      onHiddenModelsChange(hiddenModels.filter((model) => model !== slug));
      return;
    }
    onHiddenModelsChange([...hiddenModels, slug]);
  };

  const handleToggleFavorite = (slug: string) => {
    if (favoriteModelSet.has(slug)) {
      onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
      return;
    }
    onFavoriteModelsChange([...favoriteModels, slug]);
  };

  // Rows only trade places with a neighbour in the same group (favorites,
  // visible, hidden), and the display order is persisted as the new order.
  const groupOf = (model: (typeof displayModels)[number]) =>
    favoriteModelSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && hiddenModelSet.has(model.slug)
        ? "hidden"
        : "visible";
  const handleMove = (slug: string, direction: -1 | 1) => {
    const index = displayModels.findIndex((model) => model.slug === slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= displayModels.length) return;
    if (groupOf(displayModels[index]!) !== groupOf(displayModels[nextIndex]!)) return;
    const next = displayModels.map((model) => model.slug);
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  const renderRow = (model: (typeof displayModels)[number], index: number) => {
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const capLabels: string[] = [];
    if (descriptors.some((descriptor) => descriptor.id === "fastMode")) capLabels.push("Fast mode");
    if (descriptors.some((descriptor) => descriptor.id === "thinking")) capLabels.push("Thinking");
    if (
      descriptors.some(
        (descriptor) =>
          descriptor.type === "select" &&
          (descriptor.id === "reasoningEffort" ||
            descriptor.id === "effort" ||
            descriptor.id === "reasoning" ||
            descriptor.id === "variant"),
      )
    ) {
      capLabels.push("Reasoning");
    }
    const group = groupOf(model);
    const isHidden = group === "hidden";
    const isFavorite = group === "favorite";
    const previousModel = displayModels[index - 1];
    const nextModel = displayModels[index + 1];
    const canMoveUp = previousModel !== undefined && groupOf(previousModel) === group;
    const canMoveDown = nextModel !== undefined && groupOf(nextModel) === group;

    return (
      <div
        key={`${instanceId}:${model.slug}`}
        className={cn(
          "group flex min-h-8 items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/30",
          isHidden && "opacity-50",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost"
                className={cn(
                  isFavorite
                    ? "text-yellow-500 hover:text-yellow-600"
                    : "text-muted-foreground/40 hover:text-muted-foreground",
                )}
                onClick={() => handleToggleFavorite(model.slug)}
                aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
                  isFavorite ? "from" : "to"
                } favorites`}
              />
            }
          >
            <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span
            className={cn("text-xs", isHidden ? "text-muted-foreground" : "text-foreground/90")}
          >
            {model.name}
          </span>
          {model.name !== model.slug ? (
            <code className="truncate font-mono text-[11px] text-muted-foreground/70">
              {model.slug}
            </code>
          ) : null}
          {model.isCustom ? (
            <span className="text-[11px] text-muted-foreground/70">custom</span>
          ) : null}
          {capLabels.length > 0 ? (
            <span className="text-[11px] text-muted-foreground/70">{capLabels.join(" · ")}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {!isHidden ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      disabled={!canMoveUp}
                      onClick={() => handleMove(model.slug, -1)}
                      aria-label={`Move ${model.name} up`}
                    />
                  }
                >
                  <ArrowUpIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Move up</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      disabled={!canMoveDown}
                      onClick={() => handleMove(model.slug, 1)}
                      aria-label={`Move ${model.name} down`}
                    />
                  }
                >
                  <ArrowDownIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Move down</TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          {!model.isCustom ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    onClick={() => handleToggleHidden(model.slug)}
                    aria-label={`${isHidden ? "Show" : "Hide"} ${model.name}`}
                  />
                }
              >
                {isHidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {isHidden ? "Show in picker" : "Hide from picker"}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Remove ${model.slug}`}
                    onClick={() => handleRemove(model.slug)}
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Remove custom model</TooltipPopup>
            </Tooltip>
          )}
        </span>
      </div>
    );
  };

  const groupLabel = (label: string) => (
    <div className="px-2 pt-3 pb-1 text-[11px] text-muted-foreground first:pt-0">{label}</div>
  );

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="text-xs text-muted-foreground">
        {models.length} model{models.length === 1 ? "" : "s"} available
        {favoriteCount > 0 ? ` · ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}` : ""}
        {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
      </div>
      <div className="mt-2 -mx-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {displayModels.map((model, index) => {
          const group = groupOf(model);
          const previous = displayModels[index - 1];
          const startsGroup = previous === undefined || groupOf(previous) !== group;
          return (
            <div key={`${instanceId}:${model.slug}:group`}>
              {startsGroup && favoriteCount > 0 && group === "favorite"
                ? groupLabel("Favorites")
                : null}
              {startsGroup && favoriteCount > 0 && group === "visible" ? groupLabel("All") : null}
              {startsGroup && group === "hidden" ? groupLabel("Hidden from picker") : null}
              {renderRow(model, index)}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          id={`provider-instance-${instanceId}-custom-model`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
          spellCheck={false}
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
