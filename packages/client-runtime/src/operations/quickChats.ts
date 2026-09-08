import type { ModelSelection, ServerConfig } from "@t3tools/contracts";

/** Select an available environment default for a chat without project defaults. */
export function quickChatModelSelection(config: ServerConfig): ModelSelection | null {
  const providers = config.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated",
  );
  const preferred = config.settings.defaultModelSelection;
  if (preferred && providers.some((provider) => provider.instanceId === preferred.instanceId)) {
    return preferred;
  }
  for (const provider of providers) {
    const model =
      provider.models.find((model) => model.isDefault && !model.isLegacy) ??
      provider.models.find((model) => !model.isLegacy);
    if (model) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}
