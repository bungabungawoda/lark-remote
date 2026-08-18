/**
 * Claude config builder — builds fields and handles field changes for Claude agent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MODEL_ID_TO_ALIAS,
  MODEL_ALIAS_TO_ID,
  getModelOptionsFromSettings,
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
} from '../../config/index.js';
import type { AgentConfigCardBuilder, ConfigField } from './types.js';
import type { AppConfig } from '../../config/index.js';

/** Claude 官方 --permission-mode 中文注释（value 走 CLAUDE_PERMISSION_MODES SSOT）。 */
const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: '默认（敏感操作逐项询问）',
  acceptEdits: '自动接受文件编辑',
  auto: '自动放行低风险操作',
  bypassPermissions: '跳过所有权限检查',
  manual: '手动审批（default 的别名）',
  dontAsk: '仅预先批准的工具',
  plan: '计划模式（只读探索）',
};

const PERMISSION_MODE_OPTIONS = CLAUDE_PERMISSION_MODES.map((m) => ({
  text: `${m}（${PERMISSION_MODE_LABELS[m] ?? ''}）`,
  value: m,
}));

export class ClaudeConfigBuilder implements AgentConfigCardBuilder {
  /** Find Claude settings.json path (for dynamic model reading). */
  private findSettingsPath(): string | undefined {
    const envPath = process.env.CLAUDE_SETTINGS_PATH;
    if (envPath && fs.existsSync(envPath)) {
      return envPath;
    }
    const defaultPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
    return undefined;
  }

  buildFields(displayConfig: AppConfig): ConfigField[] {
    const fields: ConfigField[] = [];

    // 模型选项使用 alias，动态从 settings.json 读取
    const modelAliasOptions = ['fable', 'opus', 'sonnet', 'haiku'];
    const currentModel = displayConfig.claude?.model;
    const currentEffort = displayConfig.claude?.effort ?? 'medium';

    // 动态从 Claude settings.json 读取可选模型列表
    const settingsPath = this.findSettingsPath();
    const dynamicModelOptions = settingsPath ? getModelOptionsFromSettings(settingsPath) : [];
    // 如果从 settings 读取到模型，使用它们；否则使用默认的 alias 列表
    const modelOptions = dynamicModelOptions.length > 0 ? dynamicModelOptions : modelAliasOptions;

    // 当前值处理：从 settings 读取时是 model ID，需要显示 alias
    let currentModelValue = currentModel;
    if (currentModel) {
      currentModelValue = MODEL_ID_TO_ALIAS[currentModel] ?? currentModel;
    }

    const isCustomModel =
      currentModel &&
      !modelOptions.includes(currentModel) &&
      !modelOptions.includes(MODEL_ID_TO_ALIAS[currentModel] ?? '') &&
      !Object.values(MODEL_ID_TO_ALIAS).includes(currentModel) &&
      !(currentModel in MODEL_ID_TO_ALIAS) &&
      !Object.values(MODEL_ALIAS_TO_ID).includes(currentModel);

    fields.push({
      key: 'claude.model',
      label: '使用模型',
      type: 'select',
      options: modelOptions,
      currentValue: isCustomModel ? undefined : currentModelValue,
    });

    fields.push({
      key: 'claude.model',
      label: '自定义模型名',
      type: 'input',
      currentValue: isCustomModel ? currentModel : '',
    });

    fields.push({
      key: 'claude.effort',
      label: '推理强度',
      type: 'select',
      // Use constant for effort options (SSOT)
      options: CLAUDE_EFFORTS as readonly string[],
      currentValue: currentEffort,
    });

    // 权限模式（Claude 官方 --permission-mode 枚举；bypassPermissions 为 schema 默认，
    // 保持旧行为无审批卡，配置为其他值后激活交互式审批）
    const currentPermissionMode = displayConfig.claude?.permissionMode ?? 'bypassPermissions';
    fields.push({
      key: 'claude.permissionMode',
      label: '权限模式',
      type: 'select',
      options: PERMISSION_MODE_OPTIONS,
      currentValue: currentPermissionMode,
    });

    return fields;
  }

  handleFieldChange(
    key: string,
    _value: unknown,
    _config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    // Claude has no dependent field changes (no auto-reset on provider change, etc.)
    // Return the key as-is for the router to apply.
    return [{ key, value: _value }];
  }
}
