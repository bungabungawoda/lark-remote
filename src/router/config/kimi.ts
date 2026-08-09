/**
 * Kimi config builder — builds fields and handles field changes for Kimi agent.
 */

import {
  loadKimiConfig,
  KIMI_THINKING_EFFORTS,
  FALLBACK_EFFORTS,
  type KimiThinkingEffort,
} from '../../config/kimi-config.js';
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import type { AppConfig } from '../../config/index.js';

export class KimiConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];

    // Kimi 配置字段 - 动态从 `kimi provider list --json` 获取模型列表
    const kimiCfg = loadKimiConfig();
    const currentModel = displayConfig.agents?.kimi?.model ?? kimiCfg.currentModel;
    const currentThinking = displayConfig.agents?.kimi?.thinkingEffort ?? 'max';

    fields.push({
      key: 'agents.kimi.model',
      label: '使用模型',
      type: 'select',
      options: kimiCfg.modelOptions,
      currentValue: currentModel,
    });

    fields.push({
      key: 'agents.kimi.thinkingEffort',
      label: '推理强度',
      type: 'select',
      // Layer 3: Double-defense filter - ensure only valid options show in UI
      // (Layer 2 already filters, but this is the last line of defense)
      options: (kimiCfg.modelEfforts[currentModel] ?? [...FALLBACK_EFFORTS]).filter(
        (e): e is KimiThinkingEffort => (KIMI_THINKING_EFFORTS as readonly string[]).includes(e),
      ),
      currentValue: currentThinking,
    });

    return fields;
  }

  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    const patches: Array<{ key: string; value: unknown }> = [{ key, value }];
    // model 变更时，若当前档位不被新模型支持，重置到新模型支持的合法档位
    if (key === 'agents.kimi.model' && typeof value === 'string') {
      const effortPatch = this.thinkingEffortPatchForModel(config, value);
      if (effortPatch) patches.push(effortPatch);
    }
    return patches;
  }

  /**
   * 切到 newModel 后的档位补丁（参照 codex effortPatchForModel 语义）：
   * - 当前档位仍被新模型支持 → 不产出补丁；
   * - 否则优先 modelEfforts[newModel] 中位 (len-1)/2；
   * - 列表为空才用 modelDefaultEfforts[newModel]；
   * - 两者皆无 → FALLBACK_EFFORTS 中位；仍无则 undefined（router setNestedValue
   *   对 undefined 做键删除）。
   */
  private thinkingEffortPatchForModel(
    config: AppConfig,
    newModel: string,
  ): { key: string; value: string | undefined } | null {
    const kimiCfg = loadKimiConfig();
    const currentEffort = config.agents?.kimi?.thinkingEffort as string | undefined;
    const supported = kimiCfg.modelEfforts[newModel] ?? [...FALLBACK_EFFORTS];
    if (currentEffort && supported.includes(currentEffort)) return null;
    const middle = supported[Math.floor((supported.length - 1) / 2)];
    let newEffort = middle;
    if (!newEffort) newEffort = kimiCfg.modelDefaultEfforts?.[newModel];
    if (!newEffort) newEffort = FALLBACK_EFFORTS[Math.floor((FALLBACK_EFFORTS.length - 1) / 2)];
    return { key: 'agents.kimi.thinkingEffort', value: newEffort as string | undefined };
  }
}
