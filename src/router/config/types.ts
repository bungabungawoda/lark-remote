/**
 * Config card builder interface — per-agent contract for /config card fields.
 *
 * Each agent implements this to declare its own config fields and change handlers.
 * The router delegates to `getConfigBuilder(agent)` instead of a giant switch-case.
 */

import type { AppConfig } from '../../config/index.js';

/** A select option with separate display text and config value. */
export interface SelectOption {
  /** Display text shown in the dropdown (may include annotations). */
  text: string;
  /** Config value written to config.yaml (must match schema enum values). */
  value: string;
}

/** A single field descriptor in the /config card. */
export interface ConfigField {
  key: string;
  label: string;
  /**
   * 卡片上真实存在的控件形态，每种都在 `common/render.ts` 有对应 builder：
   * select=下拉、input=文本框、note=纯说明行（无回调）。
   *
   * 没有 boolean：卡片曾留着一套「开关」控件（`config.toggle`），但全仓没有
   * 任何字段声明它，2026-10-27 成套删除。原则是**卡片只放配得了的控件**，
   * 实现细节与未上卡的键走 YAML（见 `buildConfigCard` 的分 tab 注释）。
   */
  type: 'select' | 'input' | 'note';
  /** For select type: the list of options shown in the dropdown.
   *  Accepts plain strings (text=value) or {text, value} objects for
   *  display-value separation (e.g. 'manual（逐项审批）' → value 'manual'). */
  options?: readonly (string | SelectOption)[];
  /** Override the currentValue shown in the card (takes priority over getConfigValue). */
  currentValue?: string;
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
   * @param value - The new value (string for select/input)
   * @param config - The current pendingConfig (read-only reference for deriving dependent values)
   * @returns An array of {key, value} patches to apply to pendingConfig.
   *          The caller (router) applies these via setNestedValue.
   */
  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }>;

  /**
   * 可选的异步预取钩子：卡片渲染前拉取动态选项（如 DSH 的模型/预设目录）。
   * host 为该 agent 的当前连接地址；实现内部默认按 host 缓存，`force` 用于
   * 打开 /config 时强制刷新（外部新增 provider 后无需重启）。失败静默回退
   * 固定兜底，不阻断卡片渲染。非异步预取的 agent 可不实现。
   */
  prefetch?(
    host?: string,
    token?: string,
    credentialsFile?: string,
    options?: { force?: boolean },
  ): Promise<void>;
}
