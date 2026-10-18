/**
 * OpenCode 配置读取工具
 *
 * 从 opencode models 命令获取 provider 和 model 信息
 */

import { resolveExecutable } from '../platform/command.js';
import { spawnProcessSync } from '../platform/spawn.js';
import { getLogger } from '../logger/index.js';

interface OpencodeConfigResult {
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
let opencodeConfigCache: {
  binary: string;
  result: OpencodeConfigResult;
  timestamp: number;
} | null = null;
let opencodeConfigFailedAt: { binary: string; timestamp: number } | null = null;

/** 清空缓存（仅供测试使用，生产代码无调用点） */
export function invalidateOpencodeConfigCache(): void {
  opencodeConfigCache = null;
  opencodeConfigFailedAt = null;
}

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
 * 加载 opencode 配置，执行 opencode models 并解析
 *
 * @returns provider 列表和 model 查询接口
 */
export function loadOpencodeConfig(binary = 'opencode'): OpencodeConfigResult {
  const now = Date.now();

  // 正缓存命中：TTL 内不重复 execSync
  if (
    opencodeConfigCache?.binary === binary &&
    now - opencodeConfigCache.timestamp < OPENCODE_CONFIG_CACHE_TTL_MS
  ) {
    return opencodeConfigCache.result;
  }

  // 失败负缓存：命令最近失败过，TTL 内直接用 fallback，不再同步阻塞
  if (
    opencodeConfigFailedAt?.binary === binary &&
    now - opencodeConfigFailedAt.timestamp < OPENCODE_NEGATIVE_CACHE_TTL_MS
  ) {
    return buildFallbackResult();
  }

  try {
    // 经 seam 解析真实可执行文件（win32 PATHEXT），cross-spawn 同步执行
    const resolved = resolveExecutable(binary);
    if (!resolved) throw new Error('opencode not found');
    // v2 removed `--verbose`; plain `models` prints one `provider/model` per
    // line in both v1 and v2. Try the warm shared daemon first (fast); if it is
    // unavailable, retry with v2's private `--standalone` server.
    const modelOpts = {
      encoding: 'utf-8',
      // 30s → 10s，与 codex/kimi 对齐；maxBuffer 防模型清单 ENOBUFS 隐性截断
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    } as const;
    let res = spawnProcessSync(resolved.file, ['models'], modelOpts);
    if (res.error || res.status !== 0) {
      res = spawnProcessSync(resolved.file, ['models', '--standalone'], modelOpts);
    }
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(
        `opencode models exited code=${res.status}: ${String(res.stderr).slice(-200)}`,
      );
    }
    const output = String(res.stdout);

    // 按 provider 分组收集模型（只存 model ID，不存 provider/model 完整格式）
    const providerModels = new Map<string, string[]>();

    // 解析输出：每个模型以 provider/model 格式开头，后面跟着 JSON 块
    const lines = output.split('\n');

    for (const line of lines) {
      // 检测模型头如 "opencode/big-pickle" 或 "deepseek/deepseek-chat".
      // Split on the FIRST slash: some providers expose model IDs that
      // themselves contain "/" (e.g. openrouter/anthropic/...).
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
        // 无 provider 时返回所有 model ID（去重）
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

    const result = { providerNames, modelOptions };
    opencodeConfigCache = { binary, result, timestamp: now };
    opencodeConfigFailedAt = null;
    return result;
  } catch (error) {
    // 如果命令失败，使用 fallback
    const logger = getLogger();
    logger.warn(`[opencode-config] failed to load opencode models: ${error}`);
    opencodeConfigFailedAt = { binary, timestamp: now };
    return buildFallbackResult();
  }
}
