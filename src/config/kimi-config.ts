/**
 * Kimi config loader
 *
 * Dynamically reads available models from `kimi provider list --json`,
 * provides dynamic dropdown options for /config card.
 *
 * 同步读走统一 SWR 快照（`SyncCatalog`）：TTL 过期返回旧清单 + 后台异步刷新，
 * 不再在卡片构建路径上同步 spawn（上限 10s，会卡住整个事件循环）。
 */

import { getLogger } from '../logger/index.js';
import { spawnProcessSync } from '../platform/spawn.js';
import { SyncCatalog } from './catalog-cache.js';

/** Valid thinking effort values for kimi (Layer 1: Schema enum source) */
export const KIMI_THINKING_EFFORTS = ['low', 'high', 'max'] as const;
export type KimiThinkingEffort = (typeof KIMI_THINKING_EFFORTS)[number];

/**
 * 兜底 effort 全集就是 schema 枚举本身（不是另一份字面量，否则新增取值要改两处）。
 * 类型放宽为 readonly string[]：消费侧拿的是外部输入过滤后的兜底列表，不做枚举窄化。
 */
export const FALLBACK_EFFORTS: readonly string[] = KIMI_THINKING_EFFORTS;

/** Kimi provider list JSON structure */
interface KimiProviderListJson {
  providers: Record<
    string,
    {
      type: string;
      apiKey: string;
      baseUrl: string;
    }
  >;
  models: Record<
    string,
    {
      provider: string;
      model: string;
      maxContextSize: number;
      capabilities: string[];
      displayName: string;
      supportEfforts?: string[];
      defaultEffort?: string;
    }
  >;
}

/** Load Kimi config and return available models */
export interface KimiConfigResult {
  /** Current default model */
  currentModel: string;
  /** Available model list */
  modelOptions: string[];
  /** Model -> display name mapping */
  modelDisplayNames: Record<string, string>;
  /** Model -> supported efforts mapping */
  modelEfforts: Record<string, string[]>;
  /** Model -> default effort mapping */
  modelDefaultEfforts: Record<string, string>;
}

/** 成功清单缓存 TTL（与 opencode 对齐）。 */
const KIMI_CONFIG_CACHE_TTL_MS = 60_000;
/** 失败负缓存 TTL：命令失败后短时间不重试，避免反复同步阻塞。 */
const KIMI_NEGATIVE_CACHE_TTL_MS = 30_000;

/** `kimi provider list --json` 调用边界（同步/异步一致）。 */
const KIMI_COMMAND = {
  label: 'kimi',
  timeoutMs: 10_000,
  maxBuffer: 2 * 1024 * 1024,
} as const;

/** 清空缓存（仅供测试使用，生产代码无调用点） */
export function _invalidateKimiConfigCacheForTest(): void {
  kimiCatalog.invalidate();
}

function buildDefaultResult(): KimiConfigResult {
  return {
    currentModel: 'kimi-code/k3',
    modelOptions: [
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
    ],
    modelDisplayNames: {
      'kimi-code/k3': 'K3',
      'kimi-code/kimi-for-coding': 'K2.7 Coding',
      'kimi-code/kimi-for-coding-highspeed': 'K2.7 Coding Highspeed',
    },
    modelEfforts: {
      'kimi-code/k3': ['low', 'high', 'max'],
      'kimi-code/kimi-for-coding': ['low', 'high', 'max'],
      'kimi-code/kimi-for-coding-highspeed': ['low', 'high', 'max'],
    },
    modelDefaultEfforts: {
      'kimi-code/k3': 'max',
      'kimi-code/kimi-for-coding': 'max',
      'kimi-code/kimi-for-coding-highspeed': 'max',
    },
  };
}

/**
 * 解析 `kimi provider list --json` 输出。
 *
 * effort 只保留 schema 枚举内的值（Layer 2 过滤）；默认档非法时回退 `max`。
 * 清单为空 → 默认清单（卡片不能空下拉）。
 */
function parseKimiProviderList(output: string): KimiConfigResult {
  const logger = getLogger();
  const data = JSON.parse(output) as KimiProviderListJson;

  if (!data.models || Object.keys(data.models).length === 0) {
    logger.warn('[kimi-config] no models found in provider list, using defaults');
    return buildDefaultResult();
  }

  const modelOptions: string[] = [];
  const modelDisplayNames: Record<string, string> = {};
  const modelEfforts: Record<string, string[]> = {};
  const modelDefaultEfforts: Record<string, string> = {};

  for (const [modelId, modelInfo] of Object.entries(data.models)) {
    modelOptions.push(modelId);
    modelDisplayNames[modelId] = modelInfo.displayName;

    // Layer 2: Filter effort values to only include valid ones from KIMI_THINKING_EFFORTS
    const efforts = modelInfo.supportEfforts ?? [...FALLBACK_EFFORTS];
    const filteredEfforts = (efforts as string[]).filter((e): e is KimiThinkingEffort =>
      (KIMI_THINKING_EFFORTS as readonly string[]).includes(e),
    );
    // Fallback to default if all filtered out
    modelEfforts[modelId] = filteredEfforts.length > 0 ? filteredEfforts : [...FALLBACK_EFFORTS];

    // Layer 2: Validate default effort, fallback to 'max' if invalid
    const def = modelInfo.defaultEffort ?? 'max';
    modelDefaultEfforts[modelId] = (KIMI_THINKING_EFFORTS as readonly string[]).includes(def)
      ? def
      : 'max';
  }

  // Find current default model from the first provider
  let currentModel = 'kimi-code/k3';
  if (data.models['kimi-code/k3']) {
    currentModel = 'kimi-code/k3';
  } else if (modelOptions.length > 0) {
    currentModel = modelOptions[0];
  }

  return { currentModel, modelOptions, modelDisplayNames, modelEfforts, modelDefaultEfforts };
}

/** 同步跑 `kimi provider list --json`（冷启动路径，仅无快照时一次）。 */
function loadSync(): KimiConfigResult {
  // spawnProcessSync（cross-spawn）而非 execFileSync：kimi 是 npm 全局安装的
  // .cmd 垫片，win32 上 execFileSync 不做 PATHEXT 解析（裸名解析到无扩展名的
  // sh 脚本直接执行失败，.cmd 又 EINVAL）；cross-spawn 与 runner spawn 走
  // 同一垫片执行路径（posix 直通）。stderr 参与 pipe 以便失败信息可诊断。
  const res = spawnProcessSync('kimi', ['provider', 'list', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: KIMI_COMMAND.timeoutMs,
    maxBuffer: KIMI_COMMAND.maxBuffer,
    encoding: 'utf-8',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? '').trim();
    throw new Error(`kimi exited ${res.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`);
  }
  return parseKimiProviderList(String(res.stdout ?? ''));
}

/** 异步跑 `kimi provider list --json`（后台刷新路径，不阻塞事件循环）。 */
async function loadAsync(): Promise<KimiConfigResult> {
  // 动态 import：单测 mock 的 platform/spawn 的 spawnProcess 会直接抛错，
  // 静态 import 会把异步路径带进模块求值；这里只在后台刷新时惰性加载。
  const { runTextCommandAsync } = await import('../platform/cli-command.js');
  return parseKimiProviderList(
    await runTextCommandAsync('kimi', ['provider', 'list', '--json'], KIMI_COMMAND),
  );
}

/** 统一 SWR 缓存：同步读快照、后台异步刷新。 */
const kimiCatalog = new SyncCatalog<KimiConfigResult>({
  agent: 'kimi',
  key: () => 'kimi',
  loadSync: () => loadSync(),
  loadAsync: () => loadAsync(),
  fallback: buildDefaultResult,
  isEmpty: (value) => value.modelOptions.length === 0,
  ttlMs: KIMI_CONFIG_CACHE_TTL_MS,
  negativeTtlMs: KIMI_NEGATIVE_CACHE_TTL_MS,
});

/**
 * Load Kimi models from `kimi provider list --json`（同步，卡片构建用）。
 * 命中快照直接返回；TTL 过期返回旧清单并在后台刷新；冷启动才同步 spawn 一次。
 */
export function loadKimiConfig(): KimiConfigResult {
  return kimiCatalog.read();
}

/** 显式异步加载（warm / 测试用）：刷新快照并返回结果。 */
export async function loadKimiConfigAsync(): Promise<KimiConfigResult> {
  return kimiCatalog.refresh();
}

/** 启动后台预热：消除首次打开 Kimi 配置卡时的同步 spawn。 */
export function warmKimiConfigCache(): void {
  kimiCatalog.refresh().catch((err: unknown) => {
    getLogger().warn(`[kimi-config] warm failed: ${(err as Error).message}`);
  });
}
