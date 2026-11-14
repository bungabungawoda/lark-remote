/**
 * Qoder config builder — builds fields and handles field changes for Qoder
 * agent (ACP mode, `qodercn --acp`).
 *
 * 模型清单来自 `qodercn --list-models`（宽松解析）；清单为空（命令失败/未
 * 登录）时回退文本输入。推理强度档位动态探测（CLI 校验报错解析，见
 * qoder-config.ts）；探测不成立时同样回退文本输入。权限模式是 ACP 原生
 * 词汇（1.1.84 session/new availableModes 实测），旧 snake_case 值显示前归一。
 */

import { loadQoderConfig, refreshQoderConfig } from '../../config/qoder-config.js';
import { QODER_PERMISSION_MODES, normalizeQoderPermissionMode } from '../../config/index.js';
import type { AgentConfigCardBuilder, ConfigField, SelectOption } from './types.js';
import type { AppConfig } from '../../config/index.js';
import { permissionModeField } from './common/permission-mode.js';

/** ACP modeId → 卡片说明（描述取自 1.1.84 session/new 的 availableModes）。 */
const PERMISSION_MODE_TEXT: Record<string, string> = {
  default: 'default（逐项审批）',
  acceptEdits: 'acceptEdits（自动放行文件编辑）',
  auto: 'auto（安全分类器自动放行）',
  dontAsk: 'dontAsk（不询问，直接拒绝）',
  yolo: 'yolo（全部自动放行）',
};

const PERMISSION_MODE_OPTIONS: SelectOption[] = QODER_PERMISSION_MODES.map((mode) => ({
  value: mode,
  text: PERMISSION_MODE_TEXT[mode] ?? mode,
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

/**
 * 推理强度：有探测档位 → 下拉（首项 'default' = 不传 --reasoning-effort，
 * 跟随 Qoder 自己的 settings.json）；探测不成立 → 文本输入（旧口径）。
 * 现配置值不在探测清单里时追加为可选项（input 时代存下的自由文本，避免空选）。
 */
function effortField(effortOptions: string[], current: string): ConfigField {
  if (effortOptions.length === 0) {
    return {
      key: 'agents.qoder.reasoningEffort',
      label: '推理强度',
      type: 'input',
      currentValue: current,
    };
  }
  const levels: SelectOption[] = effortOptions.map((value) => ({ value, text: value }));
  const extras: SelectOption[] =
    current && !effortOptions.includes(current)
      ? [{ value: current, text: `${current}（现配置，不在探测清单）` }]
      : [];
  return {
    key: 'agents.qoder.reasoningEffort',
    label: '推理强度',
    type: 'select',
    options: [{ value: 'default', text: 'default（跟随 Qoder 默认）' }, ...levels, ...extras],
    currentValue: current || 'default',
  };
}

/** 上下文窗口预设档（value = tokens，随 --context-window 下发）。 */
const CONTEXT_WINDOW_PRESETS: SelectOption[] = [
  { value: '1000000', text: '1M' },
  { value: '500000', text: '500K' },
];

/**
 * 上下文窗口：预设下拉（1M/500K）+ 自定义输入，双字段写同一个 key（同 codex
 * 模型字段的「下拉 + 自定义」口径）。'default'（自造值）= 不传
 * --context-window 跟随 CLI/模型（实测默认即 1M，但不钉死，CLI 改默认不漂移）；
 * 自定义值追加进下拉，避免空选。CLI 侧校验只有「正整数」（实测任意正整数
 * 静默通过），预设档只是快捷方式，不是枚举。
 */
function contextWindowFields(contextWindow: number | undefined): ConfigField[] {
  const raw = contextWindow != null ? String(contextWindow) : '';
  const preset = CONTEXT_WINDOW_PRESETS.find((p) => p.value === raw);
  const custom = raw && !preset ? raw : '';
  const presetOptions: SelectOption[] = custom
    ? [...CONTEXT_WINDOW_PRESETS, { value: custom, text: custom }]
    : CONTEXT_WINDOW_PRESETS;
  return [
    {
      key: 'agents.qoder.contextWindow',
      label: '上下文窗口',
      type: 'select',
      options: [{ value: 'default', text: 'default（跟随 CLI/模型）' }, ...presetOptions],
      currentValue: preset?.value || custom || 'default',
    },
    {
      key: 'agents.qoder.contextWindow',
      label: '自定义上下文窗口(tokens)',
      type: 'input',
      currentValue: custom,
    },
  ];
}

export class QoderConfigBuilder implements AgentConfigCardBuilder {
  async refreshCatalogs(options: { config: AppConfig }): Promise<void> {
    await refreshQoderConfig(options.config.agents?.qoder?.cli?.binary ?? undefined);
  }

  buildFields(displayConfig: AppConfig): ConfigField[] {
    // binary 随配置（CN 版 qodercn / 国际版 qoder）——loader 探测的命令必须
    // 与 runner 实际 spawn 的一致，否则 --list-models 永远打不到已装的 CLI。
    const binary = displayConfig.agents?.qoder?.cli?.binary;
    // 目录刷新在后台点火，卡片本帧只读缓存（stale-while-revalidate）。
    // 同步探测单次 4–6s（`--reasoning-effort off -p ""`），会堵住事件循环
    // 让卡片回调超过飞书 3 秒上限；缓存冷时本帧回退文本输入，探针落地后由
    // router 按目录签名补刷成下拉（§9.29）。启动时预热，常态纯缓存读。
    void refreshQoderConfig(binary).catch(() => {});
    const qCfg = loadQoderConfig(binary);
    const q = displayConfig.agents?.qoder;

    return [
      modelField(qCfg.modelOptions, q?.model ?? qCfg.currentModel ?? ''),
      effortField(qCfg.effortOptions, q?.reasoningEffort ?? ''),
      permissionModeField(
        'agents.qoder.permissionMode',
        PERMISSION_MODE_OPTIONS,
        // 旧 snake_case 配置值归一为 ACP modeId 后回显（否则下拉空选）。
        normalizeQoderPermissionMode(q?.permissionMode ?? 'default'),
      ),
      ...contextWindowFields(q?.contextWindow),
    ];
  }

  handleFieldChange(
    key: string,
    value: unknown,
    _config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    // 文本输入的空串 = 清除配置（跟随 Qoder 自己的 settings.json）；推理强度
    // 下拉的 'default'（自造值，非官方档位）同义：runner 对 undefined 不传
    // --reasoning-effort。
    if (
      (key === 'agents.qoder.model' || key === 'agents.qoder.reasoningEffort') &&
      typeof value === 'string' &&
      (!value.trim() || (key === 'agents.qoder.reasoningEffort' && value.trim() === 'default'))
    ) {
      return [{ key, value: undefined }];
    }
    // 上下文窗口：留空/0/下拉的 'default'（自造值）= 删除键（跟随 CLI/模型
    // 默认，router 对 undefined 做键删除）；其余交由保存链路的 coerceValue
    // 转数字，非法值由 zod 校验报错。
    if (key === 'agents.qoder.contextWindow') {
      const raw = String(value ?? '').trim();
      if (raw === '' || raw === '0' || raw === 'default') {
        return [{ key, value: undefined }];
      }
    }
    return [{ key, value }];
  }
}
