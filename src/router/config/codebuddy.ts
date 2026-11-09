/**
 * CodeBuddy config builder — builds fields and handles field changes for
 * CodeBuddy agent (pure ACP mode).
 *
 * 模型清单以账号可用清单为准（`codebuddy-model-state.ts`，学自上游 400 的
 * supported list）；还没学到清单时才用 ACP 目录探针兜底（后台预热 + TTL
 * 缓存，过期按上次成功快照渲染并刷新）。目录是 CLI 静态清单，含账号无权的
 * id，只提供展示名与积分费率。两者都不可用时模型回退文本输入、思考档位
 * 回退真机观测的静态清单。沙箱是官方固定两态（true/false）。
 */

import { loadCodebuddyConfig, type CodebuddyConfigResult } from '../../config/codebuddy-config.js';
import { refreshCodebuddyCatalog, resolveCodebuddyEnv } from '../../config/codebuddy-catalog.js';
import { resolveCodebuddyModel } from '../../config/codebuddy-model-state.js';
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

/** 费率展示：目录里 `x0.29 credits` 与 `x0.29` 两种形态，统一去掉单位后缀。 */
function formatCredits(credits: string | undefined): string {
  return credits ? credits.replace(/\s*credits$/i, '').trim() : '';
}

/**
 * 模型：目录可用 → 下拉（展示名 + 费率），否则文本输入。
 *
 * 选项文本不带 id：目录里多数 id 只是展示名的重复（`Deepseek-V4.1-Flash`
 * 与 `deepseek-v4.1-flash`）。同名模型的费率通常不同（实测
 * `deepseek-v4.1-flash` x0.00 / `deepseek-v4.1-flash-sg` x0.03），仍可区分；
 * 只有「名称 + 费率」完全相同的极端情况才补 `（id）`，避免下拉里出现两个
 * 一模一样的选项。
 */
function modelField(cbCfg: CodebuddyConfigResult, configured: string): ConfigField {
  if (cbCfg.modelOptions.length === 0) {
    return {
      key: 'agents.codebuddy.model',
      label: '使用模型',
      type: 'input',
      currentValue: configured,
    };
  }
  const options = cbCfg.modelOptions.map((id) => {
    const name = cbCfg.modelDisplayNames[id];
    const label = name && name !== id ? name : id;
    const credits = formatCredits(cbCfg.modelCredits[id]);
    return { value: id, text: credits ? `${label} ${credits}` : label };
  });
  const textCounts = new Map<string, number>();
  for (const opt of options) textCounts.set(opt.text, (textCounts.get(opt.text) ?? 0) + 1);
  for (const opt of options) {
    if ((textCounts.get(opt.text) ?? 0) > 1) opt.text = `${opt.text}（${opt.value}）`;
  }
  return {
    key: 'agents.codebuddy.model',
    label: '使用模型',
    type: 'select',
    options,
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
    // 探测过才回退文本输入。启动时 initializeRunner 已预热，`/config` 打开
    // 时 router 层还会先 await 一次按账号指纹的刷新（见
    // prefetchConfigCardCatalogs），常态下这里是纯缓存读。fire-and-forget：
    // 不阻塞卡片，失败保留上次目录。
    // binary/timeoutMs 走默认，第三个参数把统一后的 env 透给探针：显式配置
    // 优先，未配置时叠加启动双探针判定的区域。国内版的
    // CODEBUDDY_INTERNET_ENVIRONMENT=internal 必须同时作用于会话连接和目录
    // 探针，否则 /config 读的是海外账号的模型清单。
    const cb = displayConfig.agents?.codebuddy;
    void refreshCodebuddyCatalog(cb?.acp?.binary, undefined, resolveCodebuddyEnv(cb?.env)).catch(
      () => {},
    );
    const cbCfg = loadCodebuddyConfig();
    // 配置里的 model 若不在账号可用清单里（换账号/换区后旧 id），卡片必须
    // 显示校正后的值，否则下拉回显一个账号无权、一发就 400 的模型。
    const alignedModel = resolveCodebuddyModel(cb?.model) ?? cbCfg.currentModel ?? '';

    return [
      modelField(cbCfg, alignedModel),
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
