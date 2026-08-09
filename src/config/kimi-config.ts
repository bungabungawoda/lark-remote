/**
 * Kimi config loader
 *
 * Dynamically reads available models from `kimi provider list --json`,
 * provides dynamic dropdown options for /config card.
 */

import { execFileSync } from 'node:child_process';
import { getLogger } from '../logger/index.js';

/** Valid thinking effort values for kimi (Layer 1: Schema enum source) */
export const KIMI_THINKING_EFFORTS = ['low', 'high', 'max'] as const;
export type KimiThinkingEffort = (typeof KIMI_THINKING_EFFORTS)[number];

/** Fallback efforts when all values are filtered out */
export const FALLBACK_EFFORTS: readonly string[] = ['low', 'high', 'max'];

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
interface KimiConfigResult {
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

/** 清空缓存（测试与配置热更新用，与 codex/opencode 的 invalidate 对齐） */
export function invalidateKimiConfigCache(): void {
  kimiConfigCache = null;
}

/** Cache for loadKimiConfig to avoid repeated sync calls */
let kimiConfigCache: { result: KimiConfigResult; timestamp: number } | null = null;
const KIMI_CONFIG_CACHE_TTL_MS = 60000; // 1 minute TTL

/**
 * Load Kimi models from `kimi provider list --json`.
 * Falls back to defaults if the command fails.
 * Uses caching to avoid repeated sync calls.
 */
export function loadKimiConfig(): KimiConfigResult {
  const now = Date.now();

  // Return cached result if still valid
  if (kimiConfigCache && now - kimiConfigCache.timestamp < KIMI_CONFIG_CACHE_TTL_MS) {
    return kimiConfigCache.result;
  }

  const logger = getLogger();

  try {
    const output = execFileSync('kimi', ['provider', 'list', '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const data = JSON.parse(output.toString()) as KimiProviderListJson;

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

    const result = {
      currentModel,
      modelOptions,
      modelDisplayNames,
      modelEfforts,
      modelDefaultEfforts,
    };

    kimiConfigCache = { result, timestamp: Date.now() };

    return result;
  } catch (err) {
    logger.warn(`[kimi-config] failed to load models: ${(err as Error).message}, using defaults`);
    const result = buildDefaultResult();
    kimiConfigCache = { result, timestamp: Date.now() };
    return result;
  }
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
