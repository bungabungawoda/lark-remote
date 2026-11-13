/**
 * OpenCode 配置读取工具
 *
 * 从 opencode models 命令获取 provider 和 model 信息。
 *
 * 同步读走统一 SWR 快照（`SyncCatalog`）：TTL 过期返回旧清单 + 后台异步刷新，
 * 不再在卡片构建路径上同步 spawn（上限 10s，会卡住整个事件循环）。
 */

import { resolveExecutable } from '../platform/command.js';
import { spawnProcessSync } from '../platform/spawn.js';
import { getLogger } from '../logger/index.js';
import { SyncCatalog } from './catalog-cache.js';

export interface OpencodeConfigResult {
  /** provider 名称列表 */
  providerNames: string[];
  /** 根据 provider 获取可用模型列表（返回纯 model ID，不带 provider 前缀） */
  modelOptions: (provider?: string) => string[];
}

/**
 * 内置的 fallback 列表
 * 当 opencode 命令失败时使用
 * 格式：provider/model（内部用，modelOptions 返回时会去掉 provider 前缀）
 */
const FALLBACK_MODELS: Record<string, string[]> = {
  opencode: ['big-pickle'],
  'opencode-go': ['deepseek-v4.1-flash'],
  deepseek: ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro'],
  'minimax-cn-coding-plan': ['MiniMax-M2.5'],
};
/** fallback provider 列表从模型表派生，保证不会出现空模型列表的 provider（历史曾混入无模型的 myprovider/volcengine-plan） */
const FALLBACK_PROVIDERS = Object.keys(FALLBACK_MODELS);

/** 正缓存 TTL：opencode models 列表短时间不变，1 分钟（与 kimi-config 对齐） */
const OPENCODE_CONFIG_CACHE_TTL_MS = 60_000;
/**
 * 失败负缓存 TTL：命令失败后 30s 内直接用 fallback，避免每次 /config 卡片构建
 * 都同步阻塞事件循环最长 10s（与 codex-config 负缓存对齐）。
 */
const OPENCODE_NEGATIVE_CACHE_TTL_MS = 30_000;

/** `opencode models` 调用边界（同步/异步一致）。 */
const OPENCODE_COMMAND = {
  label: 'opencode',
  timeoutMs: 10_000,
  // 30s → 10s，与 codex/kimi 对齐；maxBuffer 防模型清单 ENOBUFS 隐性截断
  maxBuffer: 64 * 1024 * 1024,
} as const;

function buildFallbackResult(): OpencodeConfigResult {
  return {
    providerNames: FALLBACK_PROVIDERS,
    modelOptions: (provider?: string) => {
      if (!provider) {
        // 无 provider 时返回所有 model ID（去重）
        const allModels = new Set<string>();
        for (const models of Object.values(FALLBACK_MODELS)) {
          for (const m of models) {
            allModels.add(m);
          }
        }
        return Array.from(allModels).sort();
      }
      return FALLBACK_MODELS[provider] ?? [];
    },
  };
}

/**
 * 解析 `opencode models` 输出。
 *
 * 每个模型以 `provider/model` 格式开头，后面可能跟 JSON 块。只取模型头：
 * 按**第一个**斜杠切（部分 provider 的 model ID 自身含 `/`，如 openrouter/
 * anthropic/...）。
 */
function parseOpencodeModelsOutput(output: string): OpencodeConfigResult {
  const providerModels = new Map<string, string[]>();

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) continue;
    const providerID = trimmed.slice(0, slash);
    const modelID = trimmed.slice(slash + 1);
    if (!/^[a-zA-Z0-9_.-]+$/.test(providerID)) continue;
    if (/\s/.test(modelID)) continue;

    if (!providerModels.has(providerID)) {
      providerModels.set(providerID, []);
    }
    providerModels.get(providerID)!.push(modelID);
  }

  const providerNames = Array.from(providerModels.keys()).sort();

  const modelOptions = (provider?: string): string[] => {
    if (!provider) {
      const allModels = new Set<string>();
      for (const models of providerModels.values()) {
        for (const m of models) {
          allModels.add(m);
        }
      }
      return Array.from(allModels).sort();
    }
    return providerModels.get(provider) ?? [];
  };

  return { providerNames, modelOptions };
}

/** v2 的 `models --standalone` 回退：共享 daemon 不可用时用它单独起服务。 */
const OPENCODE_MODEL_ARGS = ['models'] as const;
const OPENCODE_STANDALONE_ARGS = ['models', '--standalone'] as const;

/** 同步执行 `opencode models`（冷启动路径，仅无快照时一次）。 */
function loadSync(binary: string): OpencodeConfigResult {
  // 经 seam 解析真实可执行文件（win32 PATHEXT），cross-spawn 同步执行
  const resolved = resolveExecutable(binary);
  if (!resolved) throw new Error('opencode not found');
  const opts = {
    encoding: 'utf-8',
    timeout: OPENCODE_COMMAND.timeoutMs,
    maxBuffer: OPENCODE_COMMAND.maxBuffer,
    windowsHide: true,
  } as const;
  let res = spawnProcessSync(resolved.file, [...OPENCODE_MODEL_ARGS], opts);
  if (res.error || res.status !== 0) {
    res = spawnProcessSync(resolved.file, [...OPENCODE_STANDALONE_ARGS], opts);
  }
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`opencode models exited code=${res.status}: ${String(res.stderr).slice(-200)}`);
  }
  return parseOpencodeModelsOutput(String(res.stdout));
}

/** 异步执行 `opencode models`（后台刷新路径，不阻塞事件循环）。 */
async function loadAsync(binary: string): Promise<OpencodeConfigResult> {
  // 动态 import：单测 mock 的 platform/spawn 不提供 spawnProcess，静态 import
  // 会在模块求值时因缺导出报错。异步路径只在后台刷新时走到，测试不触发。
  const { runTextCommandAsync } = await import('../platform/cli-command.js');
  const resolved = resolveExecutable(binary);
  if (!resolved) throw new Error('opencode not found');
  try {
    return parseOpencodeModelsOutput(
      await runTextCommandAsync(resolved.file, [...OPENCODE_MODEL_ARGS], OPENCODE_COMMAND),
    );
  } catch {
    // 共享 daemon 不可用 → v2 standalone 再试一次（与同步路径同语义）
    return parseOpencodeModelsOutput(
      await runTextCommandAsync(resolved.file, [...OPENCODE_STANDALONE_ARGS], OPENCODE_COMMAND),
    );
  }
}

/** 统一 SWR 缓存：同步读快照、后台异步刷新（TTL/负缓存口径与旧实现一致）。 */
const opencodeCatalog = new SyncCatalog<OpencodeConfigResult, string>({
  agent: 'opencode',
  key: () => 'opencode',
  loadSync: (binary) => loadSync(binary),
  loadAsync: (binary) => loadAsync(binary),
  fallback: buildFallbackResult,
  isEmpty: (value) => value.providerNames.length === 0,
  ttlMs: OPENCODE_CONFIG_CACHE_TTL_MS,
  negativeTtlMs: OPENCODE_NEGATIVE_CACHE_TTL_MS,
});

/**
 * 加载 opencode 配置（同步，卡片构建用）。
 *
 * 命中快照直接返回；TTL 过期返回旧清单并在后台刷新；冷启动才同步跑一次
 * `opencode models`（启动 `warmOpencodeConfigCache` 后生产路径不会走到这里）。
 */
export function loadOpencodeConfig(binary = 'opencode'): OpencodeConfigResult {
  return opencodeCatalog.read(binary, binary);
}

/** 显式异步加载（warm / 测试用）：刷新快照并返回结果。 */
export async function loadOpencodeConfigAsync(binary = 'opencode'): Promise<OpencodeConfigResult> {
  return opencodeCatalog.refresh(binary, binary);
}

/** 启动后台预热：消除首次打开 OpenCode 配置卡时的同步 spawn。 */
export function warmOpencodeConfigCache(binary = 'opencode'): void {
  opencodeCatalog.refresh(binary, binary).catch((err: unknown) => {
    getLogger().warn(`[opencode-config] warm failed: ${(err as Error).message}`);
  });
}

/** 清空缓存（仅供测试使用，生产代码无调用点） */
export function _invalidateOpencodeConfigCacheForTest(): void {
  opencodeCatalog.invalidate();
}
