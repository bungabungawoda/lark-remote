/**
 * pi 配置读取工具
 *
 * 从 ~/.pi/agent/models.json 和 auth.json 读取 provider 和 model 信息
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface PiProviderInfo {
  /** Provider 名称 */
  name: string;
  /** API 端点（可选） */
  baseUrl?: string;
  /** API 类型 */
  api?: string;
  /** 该 provider 下的模型列表 */
  models: string[];
  /** 是否有认证信息 */
  isAuthenticated: boolean;
}

/** loadPiConfig() 的返回类型，包含 provider 和 model 的聚合信息 */
export interface PiConfigResult {
  /** provider 名称列表 */
  providerNames: string[];
  /** 获取指定 provider 的 model 选项 */
  modelOptions: (provider?: string) => string[];
}

/**
 * 解析 pi 配置目录。优先使用 PI_CONFIG_DIR 环境变量（测试隔离用），
 * 默认 ~/.pi/agent。每次调用时动态读取环境变量，避免模块级缓存导致
 * singleFork 模式下测试设置 env 过晚（与 CLAUDE_SETTINGS_PATH 模式类似，
 * 但 pi-config 的常量原本在模块级求值，改为惰性求值以支持运行时切换）。
 */
function getPiConfigDir(): string {
  return process.env.PI_CONFIG_DIR ?? path.join(os.homedir(), '.pi', 'agent');
}

/** @internal Exported for testing only — verify env var is respected. */
export function _getModelsFilePath(): string {
  return path.join(getPiConfigDir(), 'models.json');
}

/** @internal Exported for testing only. */
export function _getAuthFilePath(): string {
  return path.join(getPiConfigDir(), 'auth.json');
}

/**
 * 内置的 fallback 列表（provider 和 model 同源）
 * 当配置文件不存在时使用
 *
 * 语义约束：每个 provider fallback 都必须在此有至少 1 个 model，
 * 每个 model 中出现的 provider 都必须在 provider fallback 中。
 */
const FALLBACK_ENTRIES: Array<{ modelId: string; provider: string }> = [
  { modelId: 'glm-5.2', provider: 'Volcano' },
  { modelId: 'glm-5.1', provider: 'lt' },
  { modelId: 'claude-sonnet-4-20250514', provider: 'anthropic' },
  { modelId: 'gpt-4o', provider: 'openai' },
  { modelId: 'gemini-2.5-pro', provider: 'google' },
  { modelId: 'deepseek-chat', provider: 'deepseek' },
  { modelId: 'llama3', provider: 'ollama' },
];

function getPiProviderFallback(): string[] {
  return [...new Set(FALLBACK_ENTRIES.map((e) => e.provider))];
}

function getPiModelFallback(provider?: string): string[] {
  // 方案一：返回纯 model ID，不带 provider 后缀
  const all = FALLBACK_ENTRIES.map((e) => e.modelId);
  if (!provider) return all;
  return all.filter((m) => {
    const entry = FALLBACK_ENTRIES.find((e) => e.modelId === m);
    return entry?.provider === provider;
  });
}

/**
 * 读取 pi 的 provider 和 model 配置
 *
 * @returns provider 列表，每个 provider 包含名称、模型列表和认证状态
 */
export function loadPiProviderConfig(): PiProviderInfo[] {
  const results = new Map<string, PiProviderInfo>();
  const modelsFile = _getModelsFilePath();
  const authFile = _getAuthFilePath();

  // 1. 读取 models.json
  let modelsData: { providers?: Record<string, unknown> } = {};
  if (fs.existsSync(modelsFile)) {
    try {
      modelsData = JSON.parse(fs.readFileSync(modelsFile, 'utf-8'));
    } catch {
      // 文件格式错误，跳过
    }
  }

  // 2. 读取 auth.json
  let authData: Record<string, unknown> = {};
  if (fs.existsSync(authFile)) {
    try {
      authData = JSON.parse(fs.readFileSync(authFile, 'utf-8')) ?? {};
    } catch {
      // 文件格式错误，跳过
    }
  }

  // 3. 从 models.json 提取 providers
  const providers = modelsData.providers ?? {};
  for (const [name, config] of Object.entries(providers)) {
    const cfg = config as {
      baseUrl?: string;
      api?: string;
      models?: Array<{ id: string }>;
    };

    results.set(name, {
      name,
      baseUrl: cfg.baseUrl,
      api: cfg.api,
      models: (cfg.models ?? []).map((m) => m.id),
      isAuthenticated: !!authData[name],
    });
  }

  // 4. 对于 auth.json 中有凭据但未在 models.json 中定义的 provider
  //    添加为占位项
  for (const name of Object.keys(authData)) {
    if (!results.has(name)) {
      results.set(name, {
        name,
        models: [],
        isAuthenticated: true,
      });
    }
  }

  return Array.from(results.values());
}

/**
 * 聚合加载 pi 配置，只读一次文件，返回 provider 和 model 的查询接口
 *
 * 用于 buildConfigCard 等需要同时获取 provider 和 model 的场景，
 * 避免重复 I/O。
 */
export function loadPiConfig(): PiConfigResult {
  const config = loadPiProviderConfig();

  if (config.length === 0) {
    return {
      providerNames: getPiProviderFallback(),
      modelOptions: (provider?: string) => getPiModelFallback(provider),
    };
  }

  const providerNames = config.map((p) => p.name);

  const modelOptions = (provider?: string): string[] => {
    const providers = provider ? config.filter((p) => p.name === provider) : config;

    const models: string[] = [];
    for (const p of providers) {
      if (p.models.length > 0) {
        for (const modelId of p.models) {
          // 方案一：返回纯 model ID，不带 provider 后缀
          models.push(modelId);
        }
      }
    }

    if (models.length === 0) {
      return getPiModelFallback(provider);
    }

    return models;
  };

  return { providerNames, modelOptions };
}

/**
 * 获取可用的 model 列表（纯 model ID，不带 provider 前缀）
 *
 * @param provider 可选，指定 provider 时只返回该 provider 的模型
 * @returns model 名称数组（纯 modelId）
 */
export function getPiModelOptions(provider?: string): string[] {
  return loadPiConfig().modelOptions(provider);
}
