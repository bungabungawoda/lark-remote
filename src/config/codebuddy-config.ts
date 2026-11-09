/**
 * CodeBuddy config loader
 *
 * 模型清单有两个来源，权威性不同：
 * - 账号可用清单（`codebuddy-model-state.ts`，学自上游 400 的
 *   `Currently supported models for your account:`）——只有它代表这个账号
 *   真正能跑的模型；
 * - ACP 目录（`codebuddy-catalog.ts` 一次性探针）——CLI 内置静态清单，
 *   不按权益过滤、不区分区域，只用来提供展示名与积分费率。
 *
 * 还没学到账号清单时才用目录清单兜底渲染（否则下拉会空）；两者都没有就
 * 回退 `~/.codebuddy/settings.json` 的当前模型，卡片渲染成文本输入。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCodebuddyCatalog, THOUGHT_LEVEL_FALLBACK } from './codebuddy-catalog.js';
import { loadCodebuddyModelState, pickCodebuddyModel } from './codebuddy-model-state.js';
import { getLogger } from '../logger/index.js';

export interface CodebuddyConfigResult {
  /** 当前模型：配置值经账号清单校正后的结果 > settings.json。 */
  currentModel: string | undefined;
  /** 模型 id 清单（账号清单优先，其次目录；都不可用为空 → 卡片回退文本输入）。 */
  modelOptions: string[];
  /** modelId → 展示名（目录可用时非空）。 */
  modelDisplayNames: Record<string, string>;
  /** modelId → 积分费率（目录可用时非空，如 'x0.29 credits'）。 */
  modelCredits: Record<string, string>;
  /** thought_level 选项（目录不可用 = 真机观测的静态兜底）。 */
  thoughtLevels: ReadonlyArray<{ value: string; name: string }>;
}

/** CodeBuddy 配置根目录（会话 jsonl 与 settings.json 都在这里）。 */
export function resolveCodebuddyConfigDir(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  return path.join(os.homedir(), '.codebuddy');
}

/** Read model from `<configDir>/settings.json`（缺失/损坏 → undefined）。 */
function readSettingsModel(configDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined;
  } catch (err) {
    getLogger().warn(`[codebuddy-config] settings.json unreadable: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Load CodeBuddy config：账号可用清单优先（模型下拉只列账号真能用的 id）；
 * 还没学到清单时回退 ACP 目录（展示名 + thought_level），再回退
 * settings.json + THOUGHT_LEVEL_FALLBACK。
 */
export function loadCodebuddyConfig(configDir?: string): CodebuddyConfigResult {
  const settingsModel = readSettingsModel(resolveCodebuddyConfigDir(configDir));
  const catalog = loadCodebuddyCatalog();
  const state = loadCodebuddyModelState();

  const modelDisplayNames: Record<string, string> = {};
  const modelCredits: Record<string, string> = {};
  if (catalog) {
    for (const m of catalog.models) {
      modelDisplayNames[m.id] = m.name;
      if (m.credits) modelCredits[m.id] = m.credits;
    }
  }
  const thoughtLevels =
    catalog && catalog.thoughtLevels.length > 0 ? catalog.thoughtLevels : THOUGHT_LEVEL_FALLBACK;

  if (state.supported.length > 0) {
    return {
      currentModel:
        pickCodebuddyModel({ supported: state.supported, accountModel: settingsModel }) ??
        settingsModel,
      modelOptions: [...state.supported],
      modelDisplayNames,
      modelCredits,
      thoughtLevels,
    };
  }

  if (catalog && catalog.models.length > 0) {
    return {
      currentModel: catalog.currentModelId ?? settingsModel,
      modelOptions: catalog.models.map((m) => m.id),
      modelDisplayNames,
      modelCredits,
      thoughtLevels,
    };
  }

  return {
    currentModel: settingsModel,
    modelOptions: [],
    modelDisplayNames: {},
    modelCredits: {},
    thoughtLevels: THOUGHT_LEVEL_FALLBACK,
  };
}
