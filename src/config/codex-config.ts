/**
 * Codex config loader
 *
 * Reads model_provider and model from ~/.codex/config.toml,
 * provides dynamic dropdown options for /config card.
 *
 * Model filtering strategy:
 * - catalog 模式（config.toml 声明 model_catalog_json）：模型列表/档位来自活动目录
 * - 非 catalog 模式：openai 用 bundled 全量；anthropic 仅在用户显式配置时存在
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { getLogger } from '../logger/index.js';

/**
 * Resolve codex home directory.
 * Priority: explicit codexHome param > $CODEX_HOME env > ~/.codex
 */
export function resolveCodexHome(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** loadCodexConfig() return type */
interface CodexConfigResult {
  /** current selected model */
  currentModel: string;
  /** current selected model_provider */
  currentProvider: string;
  /** provider name list */
  providerNames: string[];
  /** provider -> env_key mapping (e.g., openai -> OPENAI_API_KEY) */
  providerEnvKeys: Record<string, string>;
  /** provider -> model list mapping.
   *  - custom provider: model from config.toml
   *  - openai: all bundled models
   *  - anthropic: bundled models with 'claude-*' prefix */
  providerModels: Record<string, string[]>;
  /** Get available model list by provider */
  modelOptions: (provider?: string) => string[];
}

/**
 * Fallback lists
 * Used when config.toml doesn't exist or cannot be parsed, and bundled command also fails
 */
/**
 * 与 codex 内置 provider 注册表对齐（model-provider-info built_in_model_providers：
 * openai/amazon-bedrock/ollama/lmstudio）。anthropic 不是内置 provider，必须用户显式
 * 配置 [model_providers.anthropic] 才存在，fallback 阶段不得虚构。
 */
const FALLBACK_PROVIDERS = ['openai'];
const FALLBACK_MODELS = [
  'o3',
  'o4-mini',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250115',
];

// ---------------------------------------------------------------------------
// bundled models: `codex debug models --bundled`
// ---------------------------------------------------------------------------

/** Enhanced bundled model info interface */
export interface BundledModelInfo {
  /** model slug (e.g., gpt-5.6-sol) */
  slug: string;
  /** display name (e.g., GPT-5.6-Sol) */
  displayName: string;
  /** priority, lower number = first in list */
  priority: number;
  /** supported reasoning effort levels */
  supportedReasoningLevels: string[];
  /** default reasoning effort；未声明时为 undefined（codex 语义：不传 effort） */
  defaultReasoningLevel: string | undefined;
}

interface BundledModelRaw {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  priority?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
}

/** Unified catalog cache entry (active or bundled source) */
interface CatalogCacheEntry {
  key: string;
  models: BundledModelInfo[];
  ts: number;
  /** true = 命令失败或结果为空（短 TTL 负缓存，P3-5） */
  failed: boolean;
}

/** Bundled models from codex binary, 1h TTL is enough (only change on binary upgrade) */
const BUNDLED_CACHE_TTL_MS = 60 * 60 * 1000;
/** 失败/空结果负缓存 TTL：避免每次卡片构建同步阻塞最长 8s（P3-5） */
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;
let catalogCache: CatalogCacheEntry | null = null;

/**
 * Read config.toml `model_catalog_json` path (tilde-expanded).
 * 返回语义：
 * - undefined：config.toml 不存在或**未声明**该键 → 非 catalog 模式；
 * - ''（空串哨兵）：已声明但不可用（值为空串/非字符串）→ 按"catalog 声明退化"处理
 *   （P2-1，绝不回退 bundled/FALLBACK）；
 * - TOML_PARSE_FAILED_SENTINEL：config.toml 存在但解析失败 → 无法得知是否声明，
 *   按非 catalog 处理（用户未声明 model_catalog_json 时的默认行为）；
 * - 具体路径：声明有效（含文件缺失，文件缺失由调用方按 active 命令失败处理）。
 */
const TOML_PARSE_FAILED_SENTINEL = '\u0000toml-parse-failed';

function readModelCatalogJsonPath(codexHome: string): string | undefined {
  const configFile = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configFile)) return undefined;
  try {
    const parsed = TOML.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    const raw = parsed.model_catalog_json;
    if (raw === undefined) return undefined; // 未声明 → 非 catalog
    if (typeof raw !== 'string' || raw.length === 0) return '';
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    if (path.isAbsolute(raw)) return raw;
    // 与 codex AbsolutePathBuf::resolve_path_against_base 一致：相对路径按
    // config.toml 所在目录解析（而非进程 cwd）。
    return path.resolve(path.dirname(configFile), raw);
  } catch {
    // config.toml 解析失败：codex 对非法配置是硬错误；此处无法得知是否声明了
    // model_catalog_json，按非 catalog 处理（P3-5），不冒充 catalog 声明退化
    return TOML_PARSE_FAILED_SENTINEL;
  }
}

/**
 * Catalog mode = config.toml **声明了** model_catalog_json（键存在即算，不要求文件存在）。
 * 依据：codex 运行时对"已配置但文件缺失/不可解析"的目录是硬错误
 * （core/src/config/mod.rs load_model_catalog ?），绝不会回退内置目录；因此键存在即
 * catalog 模式，文件缺失自然落入 `codex debug models` 失败路径 → 模型列表回退
 * [currentModel]（P1-1）。
 */
export function isCodexCatalogMode(codexHome?: string): boolean {
  const home = resolveCodexHome(codexHome);
  const p = readModelCatalogJsonPath(home);
  return p !== undefined && p !== TOML_PARSE_FAILED_SENTINEL;
}

/**
 * 单一解析器：把 `codex debug models`（活动目录）或 `--bundled`（内置目录）的原始 JSON
 * 输出解析为模型列表（P2-4 去重）。过滤/排序镜像 codex：
 * - show_in_picker = visibility == List（openai_models.rs ModelPreset::from）；
 * - API 模式（lark 用 API key 认证）下 codex filter_by_auth 过滤 supported_in_api=false；
 * - 按 priority 升序（build_available_models）。
 * 档位按目录声明**原样透传**（含 custom/none，P2-5），不按标准枚举过滤、不虚构兜底：
 * 未声明档位 → 空列表（codex with_model 语义：len=0 时用声明 default，都没有则不发
 * effort；P1）。空串档位/空串 default 被过滤（P3-9：codex ReasoningEffort::from_str
 * 对 "" 硬错误）。supported_in_api===true 过滤等价于 codex 的 chatgpt_mode ||
 * supported_in_api：本项目以 API-key 模式运行 codex，chatgpt_mode 恒 false（P3-3）。
 */
export function parseCodexModelsOutput(stdout: string): BundledModelInfo[] {
  const parsed = JSON.parse(stdout) as { models?: BundledModelRaw[] };
  const modelsRaw = Array.isArray(parsed?.models) ? parsed.models : [];

  return (
    modelsRaw
      .filter((m) => m && typeof m === 'object')
      // 严格镜像 codex API 模式 filter_by_auth：show_in_picker=list 且 supported_in_api=true
      .filter((m) => m.visibility === 'list' && m.supported_in_api === true)
      .sort((a, b) => {
        const pa = typeof a.priority === 'number' ? a.priority : Infinity;
        const pb = typeof b.priority === 'number' ? b.priority : Infinity;
        return pa - pb;
      })
      .map((m) => {
        const supportedReasoningLevels: string[] = [];
        if (Array.isArray(m.supported_reasoning_levels)) {
          const declared = m.supported_reasoning_levels
            .filter(
              (r): r is { effort: string } => r !== null && typeof r === 'object' && 'effort' in r,
            )
            .map((r) => String(r.effort))
            // P3-9：codex 拒绝空串档位（openai_models.rs from_str "" → Err）
            .filter((effort) => effort.length > 0);
          supportedReasoningLevels.push(...declared);
        }

        const defaultReasoningLevel =
          typeof m.default_reasoning_level === 'string' && m.default_reasoning_level.length > 0
            ? m.default_reasoning_level
            : undefined;

        return {
          slug: String(m.slug ?? ''),
          displayName: String(m.display_name ?? m.slug ?? ''),
          priority: typeof m.priority === 'number' ? m.priority : Infinity,
          supportedReasoningLevels,
          defaultReasoningLevel,
        };
      })
      .filter((m) => m.slug.length > 0)
  );
}

/**
 * 统一目录入口：catalog 模式（model_catalog_json 已声明，含声明退化 ''）跑
 * `debug models`（无 --bundled），否则（未声明或 config.toml 解析失败）跑
 * `debug models --bundled`。注（P3-4）：codex 无参 `debug models` 在
 * uses_codex_backend()/has_command_auth() 时会请求远端 /models（models-manager
 * manager.rs / models_endpoint.rs）；本项目以 API-key 模式运行（无 ChatGPT/命令
 * 认证），结果与 bundled 一致，故非 catalog 用 --bundled（已文档化）。
 * 缓存：键含 binary/home/mode/models.json mtime:size + config.toml mtime:size
 * （P3-4/P3-15/P3-5）；成功结果 TTL 1h，失败/空结果短 TTL 负缓存；stat 异常时
 * 指纹为空（P1-1/P3-10）。
 */
export function getCodexCatalogModels(codexHome?: string): BundledModelInfo[] {
  const binary = 'codex';
  const home = resolveCodexHome(codexHome);
  const catalogPath = readModelCatalogJsonPath(home);
  const bundled = catalogPath === undefined || catalogPath === TOML_PARSE_FAILED_SENTINEL;
  let configFingerprint = '';
  let catalogFingerprint = '';
  const configFile = path.join(home, 'config.toml');
  try {
    const st = fs.statSync(configFile);
    configFingerprint = `${st.mtimeMs}:${st.size}`;
  } catch {
    configFingerprint = '';
  }
  if (!bundled) {
    try {
      const st = fs.statSync(catalogPath);
      catalogFingerprint = `${st.mtimeMs}:${st.size}`;
    } catch {
      catalogFingerprint = '';
    }
  }
  const key = `${binary}\u0000${home}\u0000${bundled ? 'bundled' : 'active'}\u0000${catalogFingerprint}\u0000${configFingerprint}`;
  const now = Date.now();
  if (catalogCache && catalogCache.key === key) {
    const ttl = catalogCache.failed ? NEGATIVE_CACHE_TTL_MS : BUNDLED_CACHE_TTL_MS;
    if (now - catalogCache.ts < ttl) {
      return catalogCache.models;
    }
  }

  try {
    const args = bundled ? ['debug', 'models', '--bundled'] : ['debug', 'models'];
    const stdout = execFileSync(binary, args, {
      encoding: 'utf-8',
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const models = parseCodexModelsOutput(stdout);
    catalogCache = { key, models, ts: now, failed: models.length === 0 };
    return models;
  } catch (err) {
    getLogger().warn(
      `[codex-config] models unavailable for binary "${binary}": ${(err as Error).message}`,
    );
    catalogCache = { key, models: [], ts: now, failed: true };
    return [];
  }
}

/**
 * Test utility: clear the catalog cache. Tests that exercise the bundled
 * command path (`--bundled`) directly use `invalidateCodexBundledTestCache`
 * from `codex-bundled-test-helpers.ts`.
 */
export function invalidateCodexBundledCache(): void {
  catalogCache = null;
}

/**
 * Get supported reasoning effort options for a model.
 * @param codexHome 可选 codex 配置目录覆盖（与 loadCodexConfig 的 codexHome 对齐，
 *   与 loadCodexConfig 的 codexHome 对齐）；省略时走 $CODEX_HOME → ~/.codex。
 */
export function getReasoningEffortOptions(model: string, codexHome?: string): readonly string[] {
  const models = getCodexCatalogModels(codexHome);
  const found = models.find((m) => m.slug === model);
  // 未命中（含未知模型，codex fallback 元数据 supported 为空）→ []，不虚构档位（P1）
  return found?.supportedReasoningLevels ?? [];
}

/**
 * Get default reasoning effort for a model.
 * 未声明/未知模型 → undefined（codex 语义：ModelPreset.default_reasoning_effort
 * unwrap_or(ReasoningEffort::None)，即不传 effort；P3-12）。
 */
export function getDefaultReasoningEffort(model: string, codexHome?: string): string | undefined {
  const models = getCodexCatalogModels(codexHome);
  return models.find((m) => m.slug === model)?.defaultReasoningLevel;
}

// ---------------------------------------------------------------------------
// loadCodexConfig
// ---------------------------------------------------------------------------

interface LoadCodexConfigOpts {
  /** Explicit codex home override. Default: $CODEX_HOME -> ~/.codex */
  codexHome?: string;
}

/**
 * Extract custom provider name from model_providers config.
 * Skips built-in openai/anthropic, returns first custom provider.
 */
function extractCustomProvider(providers: Record<string, unknown>): string | undefined {
  const keys = Object.keys(providers);
  return keys.find((k) => k !== 'openai' && k !== 'anthropic');
}

/**
 * Read codex config.toml, extract provider and model info
 *
 * Model filtering strategy:
 * - Custom provider: model from config.toml (single model)
 * - openai: all bundled models
 * - anthropic: bundled models with 'claude-*' prefix
 */
export function loadCodexConfig(opts: LoadCodexConfigOpts = {}): CodexConfigResult {
  const codexHome = resolveCodexHome(opts.codexHome);
  const configFile = path.join(codexHome, 'config.toml');
  const catalogMode = isCodexCatalogMode(codexHome);

  // 统一目录来源：catalog 模式 = 活动目录（model_catalog_json 整体替换内置目录）；
  // 否则 = bundled（与原行为一致）
  const catalogSlugs = getCodexCatalogModels(codexHome).map((m) => m.slug);
  const allModels = catalogSlugs.length > 0 ? catalogSlugs : FALLBACK_MODELS;
  const anthropicModels = allModels.filter((m) => m.startsWith('claude-'));

  if (!fs.existsSync(configFile)) {
    // 无 config.toml：默认模型取目录首个可用模型（codex default_model_from_available），
    // 目录不可用时回退 'o3'（FALLBACK_MODELS 首项，非 catalog 默认）
    const currentModel = allModels[0] ?? 'o3';
    // No config file: only openai has bundled models
    const providerModels: Record<string, string[]> = {
      openai: allModels,
    };
    return {
      currentModel,
      currentProvider: FALLBACK_PROVIDERS[0],
      providerNames: FALLBACK_PROVIDERS,
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
      providerModels,
      modelOptions: (provider?: string) =>
        buildModelOptions(currentModel, FALLBACK_PROVIDERS[0], provider, providerModels),
    };
  }

  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = TOML.parse(raw);

    const modelKeyRaw =
      typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : undefined;
    const currentProvider = String(parsed.model_provider ?? FALLBACK_PROVIDERS[0]);

    // Extract model_providers section
    const modelProviders = (parsed.model_providers ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const rawProviderNames = Object.keys(modelProviders);

    let providerNames: string[];
    let providerEnvKeys: Record<string, string>;
    let providerModels: Record<string, string[]>;

    if (catalogMode) {
      // catalog 模式：provider 列表 = 内置 openai + [model_providers.*]（对齐 codex
      // merge_configured_model_providers(built_in_model_providers, cfg.model_providers)，
      // core/src/config/mod.rs:3655；model_provider 未声明时默认 "openai"，mod.rs:3659）。
      // anthropic 不是 codex 内置 provider，未显式配置时不得出现。模型列表仍只来自
      // 活动目录——openai+内置 gpt-5.x 的失效路径不因 provider 合并复活。
      providerNames = rawProviderNames.includes('openai')
        ? rawProviderNames
        : ['openai', ...rawProviderNames];
      providerEnvKeys = { openai: 'OPENAI_API_KEY' };
      for (const [name, config] of Object.entries(modelProviders)) {
        if (typeof config.env_key === 'string') {
          providerEnvKeys[name] = config.env_key;
        }
      }
      // 活动目录全局：codex 运行时 provider 与模型无绑定（StaticModelsManager），
      // 每个 provider 下拉都展示目录全部 slug
      // 活动目录不可用（命令失败/空）时回退 [currentModel]——无目录元数据时档位/能力
      // 不可信；禁止泄漏 FALLBACK_MODELS/内置目录。model 键缺失时不得虚构 'o3'（P1-2）。
      const catalogCurrentModel = modelKeyRaw ?? catalogSlugs[0] ?? '';
      const providerModelList =
        catalogSlugs.length > 0 ? catalogSlugs : modelKeyRaw ? [modelKeyRaw] : [];
      providerModels = {};
      for (const name of providerNames) {
        providerModels[name] = providerModelList;
      }
      const resolvedProvider =
        typeof parsed.model_provider === 'string' && parsed.model_provider.length > 0
          ? parsed.model_provider
          : 'openai';

      return {
        currentModel: catalogCurrentModel,
        currentProvider: resolvedProvider,
        providerNames,
        providerEnvKeys,
        providerModels,
        modelOptions: (provider?: string) =>
          buildModelOptions(catalogCurrentModel, resolvedProvider, provider, providerModels),
      };
    }

    // fallback 模式：保持原行为（openai/anthropic 内置 + bundled 模型）
    const currentModel = modelKeyRaw ?? catalogSlugs[0] ?? 'o3';
    providerNames = rawProviderNames;
    if (!providerNames.includes('openai')) {
      providerNames.unshift('openai');
    }

    const customProvider = extractCustomProvider(modelProviders);

    providerEnvKeys = {};
    providerEnvKeys['openai'] = 'OPENAI_API_KEY';
    for (const [name, config] of Object.entries(modelProviders)) {
      if (typeof config.env_key === 'string') {
        providerEnvKeys[name] = config.env_key;
      }
    }
    // anthropic 显式配置但未写 env_key 时保留默认键（P3-9：恢复旧版无条件映射的
    // 配置场景行为；未配置时不再虚构）
    if (
      rawProviderNames.includes('anthropic') &&
      !modelProviders['anthropic']?.env_key &&
      providerEnvKeys['anthropic'] === undefined
    ) {
      providerEnvKeys['anthropic'] = 'ANTHROPIC_API_KEY';
    }

    providerModels = { openai: allModels };
    // anthropic 仅在用户显式配置时才存在（非 codex 内置 provider）
    if (rawProviderNames.includes('anthropic')) {
      providerModels['anthropic'] = anthropicModels;
    }
    if (customProvider) {
      // Custom provider: use the model from config.toml
      providerModels[customProvider] = [currentModel];
    }

    return {
      currentModel,
      currentProvider,
      providerNames,
      providerEnvKeys,
      providerModels,
      modelOptions: (provider?: string) =>
        buildModelOptions(currentModel, currentProvider, provider, providerModels),
    };
  } catch {
    // config.toml 解析失败（readModelCatalogJsonPath 已把此场景标记为 catalog 声明退化 ''）：
    // catalogMode 为 true 时绝不回退 bundled/FALLBACK（P2-1），返回空 provider/模型列表；
    // 非 catalog 才走 FALLBACK 兜底。
    if (catalogMode) {
      return {
        currentModel: '',
        currentProvider: '',
        providerNames: [],
        providerEnvKeys: {},
        providerModels: {},
        modelOptions: () => [],
      };
    }
    const currentModel = catalogSlugs[0] ?? 'o3';
    const providerModels: Record<string, string[]> = {
      openai: allModels,
    };
    return {
      currentModel,
      currentProvider: FALLBACK_PROVIDERS[0],
      providerNames: FALLBACK_PROVIDERS,
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
      providerModels,
      modelOptions: (provider?: string) =>
        buildModelOptions(currentModel, FALLBACK_PROVIDERS[0], provider, providerModels),
    };
  }
}

/**
 * Build model options for a provider.
 * - If provider specified: return that provider's models.
 *   Only prepend currentModel if it belongs to currentProvider (same provider filter).
 *   Cross-provider currentModel is NOT leaked into another provider's list.
 * - If no provider: return all models from all providers (with currentModel prepended if not in any list)
 */
function buildModelOptions(
  currentModel: string,
  currentProvider: string,
  provider: string | undefined,
  providerModels: Record<string, string[]>,
): string[] {
  // 不为空 currentModel 虚构默认值（catalog 退化场景由上层显式传入，P1-2）；
  // 空值时直接返回原始列表
  const cm = currentModel;

  if (provider && providerModels[provider]) {
    // Return models for the specified provider
    const models = providerModels[provider];
    // Only prepend currentModel if it belongs to this provider (currentProvider matches)
    // Cross-provider currentModel must NOT leak into another provider's list
    if (cm && !models.includes(cm) && currentProvider === provider) {
      return [cm, ...models];
    }
    return models;
  }

  // No provider specified: return all unique models
  const allModels = Object.values(providerModels).flat();
  const unique = [...new Set(allModels)];
  // Ensure currentModel is always first (even if bundled failed)
  if (cm && !unique.includes(cm)) {
    return [cm, ...unique];
  }
  // If currentModel already in list but not first, move it to front
  if (cm && unique[0] !== cm) {
    const filtered = unique.filter((m) => m !== cm);
    return [cm, ...filtered];
  }
  return unique;
}
