/**
 * Pi config builder — builds fields and handles field changes for Pi agent.
 */

import { loadPiConfig, getPiModelOptions } from '../../config/pi-config.js';
import { PI_THINKING_LEVELS } from '../../config/index.js';
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import type { AppConfig } from '../../config/index.js';
import { resetModelPatch } from './common/model-patch.js';

export class PiConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];

    const piCfg = loadPiConfig();
    const providerOptions = piCfg.providerNames;
    // 根据 displayConfig 中已选的 provider 过滤 model 选项
    const currentProvider = displayConfig.agents?.pi?.provider;
    const modelOptions = piCfg.modelOptions(currentProvider);

    fields.push({
      key: 'agents.pi.provider',
      label: 'Pi Provider',
      type: 'select',
      options: providerOptions,
    });

    fields.push({
      key: 'agents.pi.model',
      label: '使用模型',
      type: 'select',
      options: modelOptions,
    });

    fields.push({
      key: 'agents.pi.thinking',
      label: '思考级别',
      type: 'select',
      // Use constant for thinking options (SSOT)
      options: PI_THINKING_LEVELS as readonly string[],
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
    if (key === 'agents.pi.provider' && typeof value === 'string') {
      const currentModel = config.agents?.pi?.model as string | undefined;
      const modelPatch = resetModelPatch(
        key,
        'agents.pi.model',
        currentModel,
        getPiModelOptions(value),
      );
      if (modelPatch) patches.push(modelPatch);
    }

    return patches;
  }
}
