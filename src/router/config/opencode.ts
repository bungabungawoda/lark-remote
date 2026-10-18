/**
 * OpenCode config builder — builds fields and handles field changes for OpenCode agent.
 */

import { loadOpencodeConfig } from '../../config/opencode-config.js';
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import { DEFAULT_TURN_IDLE_TIMEOUT_MINUTES, type AppConfig } from '../../config/index.js';
import { resetModelPatch } from './common/model-patch.js';

const MODE_OPTIONS = [
  { text: 'build（默认，按 opencode 权限配置）', value: 'build' },
  { text: 'plan（规划模式）', value: 'plan' },
];

/** Keep the currently configured value selectable even when the CLI failed and
 *  we are showing the static fallback catalog. */
function withCurrent<T>(options: T[], current: T | undefined): T[] {
  if (current === undefined || options.includes(current)) return options;
  return [current, ...options];
}

export class OpencodeConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];

    // 从 opencode models 命令动态读取 provider 和 model
    const binary = displayConfig.agents?.opencode?.acp?.binary;
    const opencodeCfg = loadOpencodeConfig(binary);
    const currentProvider = displayConfig.agents?.opencode?.providerID;
    const currentModel = displayConfig.agents?.opencode?.modelID;
    const providerNames = withCurrent(opencodeCfg.providerNames, currentProvider);
    // 根据 displayConfig 中已选的 provider 过滤 model 选项
    const modelOptions = withCurrent(opencodeCfg.modelOptions(currentProvider), currentModel);

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

    // mode select（build/plan，默认 build）——opencode 无运行期审批档位，
    // mode 即审批粒度档位（build 逐项审批 / plan 规划模式）。
    const currentMode = displayConfig.agents?.opencode?.mode ?? 'build';
    fields.push({
      key: 'agents.opencode.mode',
      label: '会话模式',
      type: 'select',
      options: MODE_OPTIONS,
      currentValue: currentMode,
    });

    // Turn 空闲超时（纯 ACP 对齐 kimi：卡片暴露 turnIdleTimeoutMinutes，
    // binary/requestTimeoutMs/idleTtlMs 为 YAML-only 工程参数）
    const currentTurnIdleTimeoutMinutes =
      displayConfig.agents?.opencode?.acp?.turnIdleTimeoutMinutes ??
      DEFAULT_TURN_IDLE_TIMEOUT_MINUTES;
    fields.push({
      key: 'agents.opencode.acp.turnIdleTimeoutMinutes',
      label: 'Turn 空闲超时(分钟, 0关闭)',
      type: 'input',
      currentValue: String(currentTurnIdleTimeoutMinutes),
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
      const binary = config.agents?.opencode?.acp?.binary;
      const opencodeCfg = loadOpencodeConfig(binary);
      const currentModel = config.agents?.opencode?.modelID as string | undefined;
      const modelPatch = resetModelPatch(
        'agents.opencode.modelID',
        currentModel,
        opencodeCfg.modelOptions(value),
      );
      if (modelPatch) patches.push(modelPatch);
    }

    return patches;
  }
}
