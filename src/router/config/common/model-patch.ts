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
 * @param modelKey     The model field to reset, e.g. 'agents.codex.model'.
 * @param currentModel The currently-configured model value (may be undefined).
 * @param newModelOptions Models offered by the newly-selected provider.
 * @returns A `{ key, value }` patch, or null when no reset is needed.
 */
export function resetModelPatch(
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

/**
 * 取档位列表的中位值（切换模型后当前档位不受支持时的兜底）。
 *
 * 偶数长度的中位口径由调用方显式选择，避免各 builder 各写一套公式后漂移：
 * - `lower`：`(len-1)/2`，kimi/codex 既有口径；
 * - `upper`：`len/2`，DSH 需要偏高的一档（off/low → low）。
 */
export function pickMiddleValue<T>(
  values: readonly T[],
  bias: 'lower' | 'upper' = 'lower',
): T | undefined {
  if (values.length === 0) return undefined;
  const index =
    bias === 'upper' ? Math.floor(values.length / 2) : Math.floor((values.length - 1) / 2);
  return values[index];
}
