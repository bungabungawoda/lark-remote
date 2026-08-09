/**
 * OpenCode config builder — builds fields and handles field changes for OpenCode agent.
 */

import { loadOpencodeConfig } from '../../config/opencode-config.js';
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import type { AppConfig } from '../../config/index.js';

export class OpencodeConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];

    // 从 opencode models 命令动态读取 provider 和 model
    const opencodeCfg = loadOpencodeConfig();
    const providerNames = opencodeCfg.providerNames;
    // 根据 displayConfig 中已选的 provider 过滤 model 选项
    const currentProvider = displayConfig.agents?.opencode?.providerID;
    const modelOptions = opencodeCfg.modelOptions(currentProvider);

    fields.push({
      key: 'agents.opencode.providerID',
      label: 'Provider',
      type: 'select',
      options: providerNames,
    });

    fields.push({
      key: 'agents.opencode.modelID',
      label: '使用模型',
      type: 'select',
      options: modelOptions,
    });

    return fields;
  }

  handleFieldChange(
    key: string,
    value: unknown,
    config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    const patches: Array<{ key: string; value: unknown }> = [];

    patches.push({ key, value });

    // provider 变更时，重置 model 为新 provider 的首个模型
    if (key === 'agents.opencode.providerID' && typeof value === 'string') {
      const opencodeCfg = loadOpencodeConfig();
      const newModelOptions = opencodeCfg.modelOptions(value);
      const currentModel = config.agents?.opencode?.modelID as string | undefined;
      const currentModelIsValid = newModelOptions.some((m) => m === currentModel);
      if (!currentModelIsValid && newModelOptions.length > 0) {
        patches.push({ key: 'agents.opencode.modelID', value: newModelOptions[0] });
      }
    }

    return patches;
  }
}
