/**
 * Shared field-change patch helpers for agent config cards.
 *
 * `resetModelPatch` captures the "provider changed → reset model to the new
 * provider's first model" behavior that opencode/pi/codex config builders were
 * duplicating.
 */

/**
 * Build a model-reset patch when the provider field changes: if the current
 * model is not offered by the new provider (and the new provider has models),
 * patch the model to the provider's first option.
 *
 * @param providerKey  The field key that changed, e.g. 'agents.codex.modelProvider'.
 * @param modelKey     The model field to reset, e.g. 'agents.codex.model'.
 * @param currentModel The currently-configured model value (may be undefined).
 * @param newModelOptions Models offered by the newly-selected provider.
 * @returns A `{ key, value }` patch, or null when no reset is needed.
 */
export function resetModelPatch(
  providerKey: string,
  modelKey: string,
  currentModel: string | undefined,
  newModelOptions: string[],
): { key: string; value: unknown } | null {
  const currentModelIsValid = newModelOptions.some((m) => m === currentModel);
  if (!currentModelIsValid && newModelOptions.length > 0) {
    return { key: modelKey, value: newModelOptions[0] };
  }
  return null;
}
