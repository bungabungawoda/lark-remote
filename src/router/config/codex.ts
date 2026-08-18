/**
 * Codex config builder — builds fields and handles field changes for Codex agent.
 */

import {
  loadCodexConfig,
  getReasoningEffortOptions,
  getDefaultReasoningEffort,
} from '../../config/codex-config.js';
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import { DEFAULT_TURN_IDLE_TIMEOUT_MINUTES, type AppConfig } from '../../config/index.js';
import { resetModelPatch } from './common/model-patch.js';

export class CodexConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];

    // 从 codex config.toml 动态读取 provider 和 model
    const codexCfg = loadCodexConfig();
    const codexProviderNames = codexCfg.providerNames;

    const currentModelProvider =
      displayConfig.agents?.codex?.modelProvider ?? codexCfg.currentProvider;
    const currentCodexModel = displayConfig.agents?.codex?.model ?? codexCfg.currentModel;
    const currentReasoningEffort =
      displayConfig.agents?.codex?.reasoningEffort ?? getDefaultReasoningEffort(currentCodexModel);

    // 传入当前 provider 过滤模型列表
    const codexModelOptions = codexCfg.modelOptions(currentModelProvider);

    fields.push({
      key: 'agents.codex.modelProvider',
      label: 'Codex Provider',
      type: 'select',
      options: codexProviderNames,
      currentValue: currentModelProvider,
    });

    fields.push({
      key: 'agents.codex.model',
      label: '使用模型',
      type: 'select',
      options: codexModelOptions,
      currentValue: currentCodexModel,
    });

    const isCustomModel = currentCodexModel && !codexModelOptions.includes(currentCodexModel);

    // 自定义模型名输入框（与 Claude 一致的行为）
    fields.push({
      key: 'agents.codex.model',
      label: '自定义模型名',
      type: 'input',
      currentValue: isCustomModel ? currentCodexModel : '',
    });

    fields.push({
      key: 'agents.codex.reasoningEffort',
      label: '推理强度',
      type: 'select',
      // 档位按目录实际声明透传（P2-5）：codex 支持 none/Custom，不再按标准枚举过滤
      options: getReasoningEffortOptions(currentCodexModel),
      currentValue: currentReasoningEffort,
    });

    // 审批策略与沙箱模式由 CodexAppServerRunner 读取（Codex 官方枚举标准值）。
    // Approval policy (Codex 官方 AskForApproval 标准值；on-request 为 codex 默认)
    const currentApprovalPolicy = displayConfig.agents?.codex?.approvalPolicy ?? 'on-request';
    fields.push({
      key: 'agents.codex.approvalPolicy',
      label: '审批策略',
      type: 'select',
      options: ['untrusted', 'on-request', 'never'],
      currentValue: currentApprovalPolicy,
    });

    // Sandbox mode (Codex 官方 SandboxMode 标准值；默认 workspace-write)
    const currentSandbox = displayConfig.agents?.codex?.sandbox ?? 'workspace-write';
    fields.push({
      key: 'agents.codex.sandbox',
      label: '沙箱模式',
      type: 'select',
      options: ['read-only', 'workspace-write', 'danger-full-access'],
      currentValue: currentSandbox,
    });

    const currentTurnIdleTimeoutMinutes =
      displayConfig.agents?.codex?.appServer?.turnIdleTimeoutMinutes ??
      DEFAULT_TURN_IDLE_TIMEOUT_MINUTES;
    fields.push({
      key: 'agents.codex.appServer.turnIdleTimeoutMinutes',
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
    if (key === 'agents.codex.modelProvider' && typeof value === 'string') {
      const codexCfg = loadCodexConfig();
      const currentModel = config.agents?.codex?.model as string | undefined;
      const modelPatch = resetModelPatch(
        key,
        'agents.codex.model',
        currentModel,
        codexCfg.modelOptions(value),
      );
      if (modelPatch) {
        patches.push(modelPatch);
        const replacedModel = modelPatch.value as string;
        // provider 切换自动替换模型后，必须对替换后的模型执行
        // 同样的档位校验——否则旧模型支持的档位会原样留在卡片/透传给不支持它的模型
        // （codex 只在会话中 with_model 时钳制，session 创建路径不钳制）。
        const effortPatch = this.effortPatchForModel(config, replacedModel);
        if (effortPatch) patches.push(effortPatch);
      }
    }

    // model 变更时，若当前档位不被新模型支持，按 codex with_model 语义重置
    if (key === 'agents.codex.model' && typeof value === 'string') {
      const effortPatch = this.effortPatchForModel(config, value);
      if (effortPatch) patches.push(effortPatch);
    }

    return patches;
  }

  /**
   * 按 codex with_model 语义（core/src/session/turn_context.rs:255-269）计算切到
   * newModel 后的档位补丁：
   * - 当前档位仍被新模型支持 → 不产出补丁；
   * - 否则优先 supported_reasoning_levels 中位 (len-1)/2；
   * - 列表为空才用声明 default_reasoning_level；
   * - 两者皆无 → value=undefined（清空档位 = 不传 effort；router setNestedValue
   *   对 undefined 做键删除，P1）。
   */
  private effortPatchForModel(
    config: AppConfig,
    newModel: string,
  ): { key: string; value: string | undefined } | null {
    const currentReasoningEffort = config.agents?.codex?.reasoningEffort as string | undefined;
    const newModelSupportedEfforts = getReasoningEffortOptions(newModel);
    const isCurrentEffortValid =
      currentReasoningEffort && newModelSupportedEfforts.includes(currentReasoningEffort);
    if (isCurrentEffortValid) return null;
    const middle = newModelSupportedEfforts[Math.floor((newModelSupportedEfforts.length - 1) / 2)];
    const newEffort = middle ?? getDefaultReasoningEffort(newModel);
    return { key: 'agents.codex.reasoningEffort', value: newEffort };
  }
}
