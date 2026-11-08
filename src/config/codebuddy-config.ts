/**
 * CodeBuddy config loader
 *
 * 模型/思考档位目录来自 ACP session/new（`codebuddy-catalog.ts` 一次性探针，
 * TTL 缓存 + 后台预热）；缓存过期先按上次成功快照渲染并在后台刷新
 * （stale-while-revalidate）。从未成功探测时才回退 `~/.codebuddy/settings.json`
 * （当前模型）+ 静态兜底清单，/config 卡的「使用模型」随之渲染成文本输入。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCodebuddyCatalog, THOUGHT_LEVEL_FALLBACK } from './codebuddy-catalog.js';
import { getLogger } from '../logger/index.js';

export interface CodebuddyConfigResult {
  /** 当前模型：ACP 目录 currentModelId > settings.json。 */
  currentModel: string | undefined;
  /** 模型 id 清单（目录不可用为空 → 卡片回退文本输入）。 */
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
 * Load CodeBuddy config：ACP 目录优先（含模型展示名 + thought_level 选项）；
 * 目录缺失（从未成功探测）时回退 settings.json + THOUGHT_LEVEL_FALLBACK。
 */
export function loadCodebuddyConfig(configDir?: string): CodebuddyConfigResult {
  const settingsModel = readSettingsModel(resolveCodebuddyConfigDir(configDir));
  const catalog = loadCodebuddyCatalog();

  if (catalog && catalog.models.length > 0) {
    const modelDisplayNames: Record<string, string> = {};
    const modelCredits: Record<string, string> = {};
    for (const m of catalog.models) {
      modelDisplayNames[m.id] = m.name;
      if (m.credits) modelCredits[m.id] = m.credits;
    }
    return {
      currentModel: catalog.currentModelId ?? settingsModel,
      modelOptions: catalog.models.map((m) => m.id),
      modelDisplayNames,
      modelCredits,
      thoughtLevels:
        catalog.thoughtLevels.length > 0 ? catalog.thoughtLevels : THOUGHT_LEVEL_FALLBACK,
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
