/**
 * CodeBuddy config builder — builds fields and handles field changes for
 * CodeBuddy agent (pure ACP mode).
 *
 * 模型/思考档位来自 ACP session/new 目录探针（`codebuddy-catalog.ts`，后台
 * 预热 + TTL 缓存；过期按上次成功快照渲染并在后台刷新，stale-while-
 * revalidate）。从未探测成功时模型回退文本输入、思考档位回退真机观测的
 * 静态清单。沙箱是官方固定两态（true/false）。
 */

import { loadCodebuddyConfig, type CodebuddyConfigResult } from '../../config/codebuddy-config.js';
import { refreshCodebuddyCatalog } from '../../config/codebuddy-catalog.js';
import { CODEBUDDY_PERMISSION_MODES } from '../../config/index.js';
import type { AgentConfigCardBuilder, ConfigField, SelectOption } from './types.js';
import type { AppConfig } from '../../config/index.js';
import { turnIdleTimeoutField } from './common/turn-idle.js';
import { permissionModeField } from './common/permission-mode.js';
import { DEFAULT_TURN_IDLE_TIMEOUT_MINUTES } from '../../config/index.js';

const PERMISSION_MODE_OPTIONS: SelectOption[] = CODEBUDDY_PERMISSION_MODES.map((mode) => ({
  value: mode,
  // 'default' 是本项目自造的「不干预」值；其余是官方 modes 枚举
  // （真机 session/new availableModes 观测，含 fullAccess）。
  text: mode === 'default' ? 'default（跟随 CodeBuddy 默认）' : mode,
}));

/** sandbox 官方固定两态（真机 configOptions 观测）。 */
const SANDBOX_OPTIONS: SelectOption[] = [
  { value: 'false', text: 'false（本地执行）' },
  { value: 'true', text: 'true（sandbox-cli 隔离）' },
];

/**
 * 「跟随 CodeBuddy 默认」哨兵值。不能用空串：飞书 select 把空 initial_option
 * 当作「未选择」（显示 placeholder），空串选项的选中态永远无法回显。
 */
const DEFAULT_SENTINEL = 'default';

/** 模型：目录可用 → 下拉（展示名 + 积分费率），否则文本输入。 */
function modelField(cbCfg: CodebuddyConfigResult, configured: string): ConfigField {
  if (cbCfg.modelOptions.length === 0) {
    return {
      key: 'agents.codebuddy.model',
      label: '使用模型',
      type: 'input',
      currentValue: configured,
    };
  }
  return {
    key: 'agents.codebuddy.model',
    label: '使用模型',
    type: 'select',
    options: cbCfg.modelOptions.map((id) => {
      const name = cbCfg.modelDisplayNames[id];
      // 积分费率随目录下发（如 'x0.29 credits'），选模型时直接可见
      const credits = cbCfg.modelCredits[id];
      const base = name && name !== id ? `${name}（${id}）` : id;
      return { value: id, text: credits ? `${base} · ${credits}` : base };
    }),
    currentValue: configured,
  };
}

/** default 哨兵 = 不下发（跟随 CodeBuddy 默认 enabled）。 */
function thinkingLevelField(
  levels: ReadonlyArray<{ value: string; name: string }>,
  current: string,
): ConfigField {
  return {
    key: 'agents.codebuddy.thinkingLevel',
    label: '思考档位',
    type: 'select',
    options: [
      { value: DEFAULT_SENTINEL, text: 'default（跟随 CodeBuddy 默认）' },
      ...levels.map((t) => ({ value: t.value, text: t.name })),
    ],
    currentValue: current || DEFAULT_SENTINEL,
  };
}

/** 未配置 = 不下发（跟随 CodeBuddy 默认 false）。 */
function sandboxField(current: boolean | undefined): ConfigField {
  return {
    key: 'agents.codebuddy.sandbox',
    label: '命令沙箱',
    type: 'select',
    options: [
      { value: DEFAULT_SENTINEL, text: 'default（跟随 CodeBuddy 默认）' },
      ...SANDBOX_OPTIONS,
    ],
    currentValue: current === undefined ? DEFAULT_SENTINEL : String(current),
  };
}

export class CodebuddyConfigBuilder implements AgentConfigCardBuilder {
  buildFields(displayConfig: AppConfig): ConfigField[] {
    // 目录冷路径在这里点火：buildFields 是同步契约（kimi 的 buildFields 同样
    // 在内联 spawn 探测），本次渲染用缓存/兜底：缓存过期也先用上次成功快照
    // （stale-while-revalidate），探针完成后下一次渲染换新；只有从未成功
    // 探测过才回退文本输入。启动时 initializeRunner 已预热，常态下这里是
    // 纯缓存读。fire-and-forget：不阻塞卡片，失败保留上次目录。router 层的
    // catalog 预取编排只对 DSH 生效，CodeBuddy 必须在这里自行点火。
    void refreshCodebuddyCatalog().catch(() => {});
    const cbCfg = loadCodebuddyConfig();
    const cb = displayConfig.agents?.codebuddy;

    return [
      modelField(cbCfg, cb?.model ?? cbCfg.currentModel ?? ''),
      permissionModeField(
        'agents.codebuddy.permissionMode',
        PERMISSION_MODE_OPTIONS,
        cb?.permissionMode ?? 'default',
      ),
      thinkingLevelField(cbCfg.thoughtLevels, cb?.thinkingLevel ?? ''),
      sandboxField(cb?.sandbox),
      turnIdleTimeoutField(
        'agents.codebuddy.acp.turnIdleTimeoutMinutes',
        cb?.acp?.turnIdleTimeoutMinutes ?? DEFAULT_TURN_IDLE_TIMEOUT_MINUTES,
      ),
    ];
  }

  handleFieldChange(
    key: string,
    value: unknown,
    _config: AppConfig,
  ): Array<{ key: string; value: unknown }> {
    // default 哨兵 / 空串（旧卡片）= 清除配置（跟随 CodeBuddy 默认）。
    if (key === 'agents.codebuddy.model' && typeof value === 'string' && !value.trim()) {
      return [{ key, value: undefined }];
    }
    if (
      key === 'agents.codebuddy.thinkingLevel' &&
      typeof value === 'string' &&
      (!value.trim() || value.trim() === DEFAULT_SENTINEL)
    ) {
      return [{ key, value: undefined }];
    }
    if (key === 'agents.codebuddy.sandbox') {
      if (value === '' || value === undefined || value === DEFAULT_SENTINEL) {
        return [{ key, value: undefined }];
      }
      if (typeof value === 'string') return [{ key, value: value === 'true' }];
      // string/boolean 双口径合法收敛（zod schema 收 boolean）。
      return [{ key, value: Boolean(value) }];
    }
    return [{ key, value }];
  }
}
