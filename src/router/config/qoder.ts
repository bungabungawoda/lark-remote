/**
 * Qoder config builder — builds fields and handles field changes for Qoder
 * agent (generic CLI mode).
 *
 * 模型清单来自 `qodercn --list-models`（宽松解析）；清单为空（命令失败/未
 * 登录）时回退文本输入。推理强度与模型一样无稳定枚举（官方不承诺档位集），
 * 渲染为文本输入。
 */

import { loadQoderConfig } from '../../config/qoder-config.js';
import { QODER_PERMISSION_MODES } from '../../config/index.js';
import type { AgentConfigCardBuilder, ConfigField, SelectOption } from './types.js';
import type { AppConfig } from '../../config/index.js';
import { permissionModeField } from './common/permission-mode.js';

const PERMISSION_MODE_OPTIONS: SelectOption[] = QODER_PERMISSION_MODES.map((mode) => ({
  value: mode,
  // 'default' 是本项目自造的「不干预」值；其余是 CLI 官方枚举（snake_case）。
  text: mode === 'default' ? 'default（跟随 Qoder 默认）' : mode,
}));

/** 模型：目录可用（--list-models 有输出）→ 下拉，否则文本输入。 */
function modelField(modelOptions: string[], configured: string): ConfigField {
  if (modelOptions.length === 0) {
    return {
      key: 'agents.qoder.model',
      label: '使用模型',
      type: 'input',
      currentValue: configured,
    };
  }
  return {
    key: 'agents.qoder.model',
    label: '使用模型',
    type: 'select',
    options: modelOptions,
    currentValue: configured,
  };
}

/** 推理强度无稳定枚举（官方不承诺档位集），渲染为文本输入。 */
function effortField(current: string): ConfigField {
  return {
    key: 'agents.qoder.reasoningEffort',
    label: '推理强度',
    type: 'input',
    currentValue: current,
  };
}

/** 上下文窗口：未配置显示空串（留空/0 = 跟随 CLI/模型默认）。 */
function contextWindowField(contextWindow: number | undefined): ConfigField {
  return {
    key: 'agents.qoder.contextWindow',
    label: '上下文窗口(tokens, 留空或0=CLI默认)',
    type: 'input',
    currentValue: contextWindow != null ? String(contextWindow) : '',
  };
}

export class QoderConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    // binary 随配置（CN 版 qodercn / 国际版 qoder）——loader 探测的命令必须
    // 与 runner 实际 spawn 的一致，否则 --list-models 永远打不到已装的 CLI。
    const qCfg = loadQoderConfig(displayConfig.agents?.qoder?.cli?.binary);
    const q = displayConfig.agents?.qoder;

    return [
      modelField(qCfg.modelOptions, q?.model ?? qCfg.currentModel ?? ''),
      effortField(q?.reasoningEffort ?? ''),
      permissionModeField(
        'agents.qoder.permissionMode',
        PERMISSION_MODE_OPTIONS,
        q?.permissionMode ?? 'default',
      ),
      contextWindowField(q?.contextWindow),
    ];
  }

  handleFieldChange(
    key: string,
    value: unknown,
    _config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    // 文本输入的空串 = 清除配置（跟随 Qoder 自己的 settings.json）。
    if (
      (key === 'agents.qoder.model' || key === 'agents.qoder.reasoningEffort') &&
      typeof value === 'string' &&
      !value.trim()
    ) {
      return [{ key, value: undefined }];
    }
    // 上下文窗口：留空或 0 = 删除键（跟随 CLI/模型默认，router 对 undefined
    // 做键删除）；其余交由保存链路的 coerceValue 转数字，非法值由 zod 校验报错。
    if (key === 'agents.qoder.contextWindow') {
      const raw = String(value ?? '').trim();
      if (raw === '' || raw === '0') {
        return [{ key, value: undefined }];
      }
    }
    return [{ key, value }];
  }
}
