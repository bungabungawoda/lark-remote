/**
 * Config card builder interface — per-agent contract for /config card fields.
 *
 * Each agent implements this to declare its own config fields and change handlers.
 * The router delegates to `getConfigBuilder(agent)` instead of a giant switch-case.
 */

import type { AppConfig } from '../../config/index.js';

/** A single field descriptor in the /config card. */
export interface ConfigField {
  key: string;
  label: string;
  type: 'boolean' | 'select' | 'input' | 'note';
  /** For select type: the list of options shown in the dropdown. */
  options?: readonly string[];
  /** Override the currentValue shown in the card (takes priority over getConfigValue). */
  currentValue?: string | boolean;
}

/**
 * Builder that provides config fields and handles field changes for a specific agent.
 *
 * Lifecycle:
 * 1. `buildFields()` is called when the card is rendered (on open, on save, on any field change).
 * 2. `handleFieldChange()` is called when a config.set or config.input modifies a field
 *    that belongs to this agent. It returns a list of {key, value} patches to apply
 *    to pendingConfig (side-effect-free: the caller applies the patches).
 */
export interface AgentConfigCardBuilder {
  /** Build config fields for this agent, given the current display config. */
  buildFields(displayConfig: AppConfig): ConfigField[];

  /**
   * Handle a field change for this agent.
   *
   * @param key   - The field key (e.g. 'agents.codex.modelProvider')
   * @param value - The new value (string for select/input, already toggled for boolean)
   * @param config - The current pendingConfig (read-only reference for deriving dependent values)
   * @returns An array of {key, value} patches to apply to pendingConfig.
   *          The caller (router) applies these via setNestedValue.
   */
  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }>;
}
