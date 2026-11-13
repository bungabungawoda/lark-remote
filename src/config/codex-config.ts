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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { runTextCommandAsync, runTextCommandSync } from '../platform/cli-command.js';
import { SyncCatalog } from './catalog-cache.js';
import {
  cachedEndpointModels,
  warmEndpointModels,
  type EndpointModelsTarget,
} from './endpoint-models.js';

/** codex CLI 名（cross-spawn 负责 win32 .cmd 垫片解析）。 */
const CODEX_BINARY = 'codex';

/** codex CLI 调用超时 / 输出上限（同步与异步路径一致）。 */
const CODEX_TIMEOUT_MS = 8_000;
const CODEX_MAX_BUFFER = 4 * 1024 * 1024;

/** 探测调用的边界（共用实现见 platform/cli-command）。 */
const CODEX_COMMAND = {
  label: 'codex',
  timeoutMs: CODEX_TIMEOUT_MS,
  maxBuffer: CODEX_MAX_BUFFER,
} as const;

/**
 * Resolve codex home directory.
 * Priority: explicit codexHome param > $CODEX_HOME env > ~/.codex
 *
 * 空串/纯空白按「未设置」处理：`??` 只挡 undefined，放过空串会让
 * `path.join('', 'config.toml')` 变成相对**进程 cwd** 的路径。
 */
export function resolveCodexHome(codexHome?: string): string {
  return codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
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
const FALLBACK_MODELS = ['o3', 'o4-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'];
/**
 * anthropic 的独立兜底模型表：anthropic 非内置 provider，仅在用户显式配置后使用。
 * 不得混入 FALLBACK_MODELS——无 config.toml 时 openai 的模型列表会原样暴露这些
 * claude 条目（claude 模型列在 openai provider 下是错的）。
 */
const ANTHROPIC_FALLBACK_MODELS = ['claude-sonnet-4-20250514', 'claude-opus-4-20250115'];

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

/** Bundled models from codex binary, 1h TTL is enough (only change on binary upgrade) */
const BUNDLED_CACHE_TTL_MS = 60 * 60 * 1000;
/** 失败/空结果负缓存 TTL：避免每次卡片构建同步阻塞最长 8s */
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;
/**
 * codex 目录读取上下文：bundled 决定命令参数（--bundled 与否）。
 * 一个 SyncCatalog 实例按 keyOverride 适配多个 codexHome（测试常用临时目录）。
 */
interface CodexCatalogCtx {
  bundled: boolean;
}

function codexCatalogContext(codexHome?: string): { key: string; ctx: CodexCatalogCtx } {
  const { key, bundled } = computeCodexCatalogKey(codexHome);
  return { key, ctx: { bundled } };
}

/**
 * Read config.toml `model_catalog_json` path (tilde-expanded).
 * 返回语义：
 * - undefined：config.toml 不存在或**未声明**该键 → 非 catalog 模式；
 * - ''（空串哨兵）：已声明但不可用（值为空串/非字符串）→ 按"catalog 声明退化"处理
 *   （绝不回退 bundled/FALLBACK）；
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
    // model_catalog_json，按非 catalog 处理，不冒充 catalog 声明退化
    return TOML_PARSE_FAILED_SENTINEL;
  }
}

/**
 * Catalog mode = config.toml **声明了** model_catalog_json（键存在即算，不要求文件存在）。
 * 依据：codex 运行时对"已配置但文件缺失/不可解析"的目录是硬错误
 * （core/src/config/mod.rs load_model_catalog ?），绝不会回退内置目录；因此键存在即
 * catalog 模式，文件缺失自然落入 `codex debug models` 失败路径 → 模型列表回退
 * [currentModel]。
 */
export function isCodexCatalogMode(codexHome?: string): boolean {
  const home = resolveCodexHome(codexHome);
  const p = readModelCatalogJsonPath(home);
  return p !== undefined && p !== TOML_PARSE_FAILED_SENTINEL;
}

/**
 * 单一解析器：把 `codex debug models`（活动目录）或 `--bundled`（内置目录）的原始 JSON
 * 输出解析为模型列表（去重）。过滤/排序镜像 codex：
 * - show_in_picker = visibility == List（openai_models.rs ModelPreset::from）；
 * - API 模式（lark 用 API key 认证）下 codex filter_by_auth 过滤 supported_in_api=false；
 * - 按 priority 升序（build_available_models）。
 * 档位按目录声明**原样透传**（含 custom/none），不按标准枚举过滤、不虚构兜底：
 * 未声明档位 → 空列表（codex with_model 语义：len=0 时用声明 default，都没有则不发
 * effort；）。空串档位/空串 default 被过滤（codex ReasoningEffort::from_str
 * 对 "" 硬错误）。supported_in_api===true 过滤等价于 codex 的 chatgpt_mode ||
 * supported_in_api：本项目以 API-key 模式运行 codex，chatgpt_mode 恒 false。
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
            // codex 拒绝空串档位（openai_models.rs from_str "" → Err）
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
 * 统一 SWR 目录缓存（catalog 模式跑 `debug models`，否则 `--bundled`）。
 *
 * 同步读快照、后台异步刷新：TTL 过期不再同步跑 `codex debug models`（上限 8s，
 * 会卡住整个事件循环），旧快照立即返回。
 *
 * 缓存：键含 binary/home/mode/models.json mtime:size + config.toml mtime:size；
 * 成功 TTL 1h，失败/空结果短 TTL 负缓存。
 */
const codexCatalog = new SyncCatalog<BundledModelInfo[], CodexCatalogCtx>({
  agent: 'codex',
  key: () => computeCodexCatalogKey().key,
  loadSync: ({ bundled }) => parseCodexModelsOutput(runCodexCommandSync(catalogArgs(bundled))),
  loadAsync: async ({ bundled }) =>
    parseCodexModelsOutput(await runCodexCommandAsync(catalogArgs(bundled))),
  fallback: () => [],
  isEmpty: (models) => models.length === 0,
  ttlMs: BUNDLED_CACHE_TTL_MS,
  negativeTtlMs: NEGATIVE_CACHE_TTL_MS,
});

/**
 * codex 当前模型目录（同步，卡片构建用）。
 *
 * 同步路径只读快照：命中直接返回；TTL 过期返回旧快照并在后台刷新；刷新在途
 * 且无快照时返回 [] 交给调用方既有 fallback（FALLBACK_MODELS / currentModel）。
 * 冷启动保留一次同步加载，保证首帧就有真实清单；启动 warm 后生产路径几乎不会
 * 走到这里。
 */
export function getCodexCatalogModels(codexHome?: string): BundledModelInfo[] {
  const { key, ctx } = codexCatalogContext(codexHome);
  return codexCatalog.read(key, ctx);
}

/**
 * 显式异步加载模型目录（不阻塞事件循环）：单飞刷新快照并返回结果。
 * 启动预热与测试走这条路径。
 */
export async function loadCodexCatalogModelsAsync(codexHome?: string): Promise<BundledModelInfo[]> {
  const { key, ctx } = codexCatalogContext(codexHome);
  return codexCatalog.refresh(key, ctx);
}

/**
 * 启动/后台预热：fire-and-forget 调用异步加载，消除首次打开 Codex 配置卡时的
 * 8s 同步阻塞。非致命——失败/未安装 codex 时静默落负缓存。
 */
export function warmCodexCatalogCache(codexHome?: string): void {
  void loadCodexCatalogModelsAsync(codexHome);
}

/** 计算目录缓存键（binary/home/mode + 指纹），同步与异步路径共享。 */
function computeCodexCatalogKey(codexHome?: string): { key: string; bundled: boolean } {
  const binary = CODEX_BINARY;
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
  return { key, bundled };
}

/** `codex debug models` 参数（--bundled 与否）。 */
function catalogArgs(bundled: boolean): string[] {
  return bundled ? ['debug', 'models', '--bundled'] : ['debug', 'models'];
}

/** `codex debug models` 的同步输出；命令名进错误信息，stderr 片段随错误带出。 */
function runCodexCommandSync(args: string[]): string {
  return runTextCommandSync(CODEX_BINARY, args, CODEX_COMMAND);
}

/** `codex debug models` 的异步输出，与同步路径同超时 / 输出上限。 */
function runCodexCommandAsync(args: string[]): Promise<string> {
  return runTextCommandAsync(CODEX_BINARY, args, CODEX_COMMAND);
}

/**
 * Test utility: clear the catalog cache. Tests that exercise the bundled
 * command path (`--bundled`) directly use `invalidateCodexBundledTestCache`
 * from `tests/lib/codex-bundled-test-helpers.ts`.
 */
export function _invalidateCodexBundledCacheForTest(): void {
  codexCatalog.invalidate();
}

/** Test utility: clear in-flight async catalog loads (see async loader tests). */
export function _clearCodexCatalogInFlightForTest(): void {
  codexCatalog.invalidate();
}

/**
 * Get supported reasoning effort options for a model.
 * @param codexHome 可选 codex 配置目录覆盖（与 loadCodexConfig 的 codexHome 对齐，
 *   与 loadCodexConfig 的 codexHome 对齐）；省略时走 $CODEX_HOME → ~/.codex。
 */
export function getReasoningEffortOptions(model: string, codexHome?: string): readonly string[] {
  const models = getCodexCatalogModels(codexHome);
  const found = models.find((m) => m.slug === model);
  // 未命中（含未知模型，codex fallback 元数据 supported 为空）→ []，不虚构档位
  return found?.supportedReasoningLevels ?? [];
}

/**
 * Get default reasoning effort for a model.
 * 未声明/未知模型 → undefined（codex 语义：ModelPreset.default_reasoning_effort
 * unwrap_or(ReasoningEffort::None)，即不传 effort；）。
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
 * 一个自定义 provider 的清单端点：`base_url` + `env_key` 指向的环境变量。
 *
 * 凭据只从环境变量取，与 codex 自己读 key 的方式一致（config.toml 不存 key）；
 * 环境里没有 key 就不探——没有认证的请求只会换回 401，白等一次超时。
 * `wire_api = "anthropic"` 的 provider 按 Anthropic 方言问（带 anthropic-version
 * 头、允许剥 /anthropic 回 root）。
 */
function endpointTargetOf(config: unknown): EndpointModelsTarget | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const cfg = config as Record<string, unknown>;
  const baseUrl = typeof cfg.base_url === 'string' ? cfg.base_url.trim() : '';
  if (!baseUrl) return undefined;
  const envKey = typeof cfg.env_key === 'string' ? cfg.env_key.trim() : '';
  const apiKey = envKey ? (process.env[envKey] ?? '').trim() : '';
  if (!apiKey) return undefined;
  return { baseUrl, apiKey, anthropic: cfg.wire_api === 'anthropic' };
}

/** 自定义 provider 的端点清单（同步读缓存；未命中时踢一次后台探测）。 */
function endpointModelsOf(config: unknown): string[] | undefined {
  const target = endpointTargetOf(config);
  return target ? cachedEndpointModels(target) : undefined;
}

/**
 * 启动预热：非 catalog 模式下，后台探一次自定义 provider 的清单。
 *
 * 只读 config.toml（不触目录、不 spawn codex）——启动路径上不能因为预热把
 * `codex debug models` 的同步 spawn 拉进来。
 */
export function warmCodexEndpointModels(codexHome?: string): void {
  const home = resolveCodexHome(codexHome);
  if (isCodexCatalogMode(home)) return; // catalog 模式不替换列表，探了也用不上
  const toml = readCodexToml(home);
  if (toml.state !== 'parsed') return;
  const providers = providersOf(toml.parsed);
  const name = extractCustomProvider(providers);
  if (!name) return;
  const target = endpointTargetOf(providers[name]);
  if (target) warmEndpointModels(target);
}

/** config.toml 的 `model_providers` 表（缺失或形状不对时空对象）。 */
function providersOf(parsed: Record<string, unknown>): Record<string, unknown> {
  const providers = parsed.model_providers;
  return providers && typeof providers === 'object' ? (providers as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// loadCodexConfig 三段管线：readCodexToml（IO）→ normalizeProviders（转换）
// → applyProfiles（装配）。前两段之间的产物可独立单测；红线：resolveCodexHome
// 的环境变量优先级（codexHome 参数 > $CODEX_HOME > ~/.codex）只在
// loadCodexConfig 入口解析一次，各段不得自行再解析。
// ---------------------------------------------------------------------------

/** normalizeProviders / applyProfiles 的中间产物：与 modelOptions 解耦的 provider 事实。 */
interface CodexProviderProfile {
  currentModel: string;
  currentProvider: string;
  providerNames: string[];
  /** provider -> env_key 映射（e.g. openai -> OPENAI_API_KEY），消费方据此取密钥。 */
  providerEnvKeys: Record<string, string>;
  providerModels: Record<string, string[]>;
}

/**
 * 管线第 1 段（IO）：读 + 解析 config.toml，不做任何语义解释。
 * - missing：文件不存在；
 * - parsed：TOML 解析成功（内容后续由 normalizeProviders 解释）；
 * - invalid：读取/解析抛错（含 TOCTOU 窗口内的文件损坏）——错误在此分类收口，
 *   消费方（loadCodexConfig）据此走「解析失败」兜底，绝不向上抛异常。
 */
function readCodexToml(
  codexHome: string,
):
  | { state: 'missing' }
  | { state: 'parsed'; parsed: Record<string, unknown> }
  | { state: 'invalid' } {
  const configFile = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configFile)) return { state: 'missing' };
  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    return { state: 'parsed', parsed: TOML.parse(raw) as Record<string, unknown> };
  } catch {
    return { state: 'invalid' };
  }
}

/** normalizeProviders 的目录上下文（loadCodexConfig 一次算好；纯转换不再读 IO）。 */
interface ProviderNormalizeCtx {
  catalogMode: boolean;
  catalogSlugs: string[];
  allModels: string[];
  anthropicModels: string[];
}

/**
 * 管线第 2 段（纯转换）：把已解析的 TOML + 目录上下文归一成 provider/model 事实。
 * Model filtering strategy:
 * - Custom provider: model from config.toml (single model)
 * - openai: all bundled models
 * - anthropic: bundled models with 'claude-*' prefix
 */
function normalizeProviders(
  parsed: Record<string, unknown>,
  ctx: ProviderNormalizeCtx,
): CodexProviderProfile {
  const { catalogMode, catalogSlugs, allModels, anthropicModels } = ctx;

  const modelKeyRaw =
    typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : undefined;
  const currentProvider = String(parsed.model_provider ?? FALLBACK_PROVIDERS[0]);

  // Extract model_providers section
  const modelProviders = providersOf(parsed) as Record<string, Record<string, unknown>>;
  const rawProviderNames = Object.keys(modelProviders);

  if (catalogMode) {
    // catalog 模式：provider 列表 = 内置 openai + [model_providers.*]（对齐 codex
    // merge_configured_model_providers(built_in_model_providers, cfg.model_providers)，
    // core/src/config/mod.rs:3655；model_provider 未声明时默认 "openai"，mod.rs:3659）。
    // anthropic 不是 codex 内置 provider，未显式配置时不得出现。模型列表仍只来自
    // 活动目录——openai+内置 gpt-5.x 的失效路径不因 provider 合并复活。
    const providerNames = rawProviderNames.includes('openai')
      ? rawProviderNames
      : ['openai', ...rawProviderNames];
    const providerEnvKeys: Record<string, string> = { openai: 'OPENAI_API_KEY' };
    for (const [name, config] of Object.entries(modelProviders)) {
      if (typeof config.env_key === 'string') {
        providerEnvKeys[name] = config.env_key;
      }
    }
    // 活动目录全局：codex 运行时 provider 与模型无绑定（StaticModelsManager），
    // 每个 provider 下拉都展示目录全部 slug
    // 活动目录不可用（命令失败/空）时回退 [currentModel]——无目录元数据时档位/能力
    // 不可信；禁止泄漏 FALLBACK_MODELS/内置目录。model 键缺失时不得虚构 'o3'。
    const catalogCurrentModel = modelKeyRaw ?? catalogSlugs[0] ?? '';
    const providerModelList =
      catalogSlugs.length > 0 ? catalogSlugs : modelKeyRaw ? [modelKeyRaw] : [];
    const providerModels: Record<string, string[]> = {};
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
    };
  }

  // fallback 模式：保持原行为（openai/anthropic 内置 + bundled 模型）
  const currentModel = modelKeyRaw ?? catalogSlugs[0] ?? 'o3';
  const providerNames = rawProviderNames;
  if (!providerNames.includes('openai')) {
    providerNames.unshift('openai');
  }

  const customProvider = extractCustomProvider(modelProviders);

  const providerEnvKeys: Record<string, string> = {};
  providerEnvKeys['openai'] = 'OPENAI_API_KEY';
  for (const [name, config] of Object.entries(modelProviders)) {
    if (typeof config.env_key === 'string') {
      providerEnvKeys[name] = config.env_key;
    }
  }
  // anthropic 显式配置但未写 env_key 时保留默认键（恢复旧版无条件映射的
  // 配置场景行为；未配置时不再虚构）
  if (
    rawProviderNames.includes('anthropic') &&
    !modelProviders['anthropic']?.env_key &&
    providerEnvKeys['anthropic'] === undefined
  ) {
    providerEnvKeys['anthropic'] = 'ANTHROPIC_API_KEY';
  }

  const providerModels: Record<string, string[]> = { openai: allModels };
  // anthropic 仅在用户显式配置时才存在（非 codex 内置 provider）
  if (rawProviderNames.includes('anthropic')) {
    providerModels['anthropic'] = anthropicModels;
  }
  if (customProvider) {
    // 自定义 provider：先按 config.toml 里的 base_url 问端点自己列了什么。
    // 探不到（无 base_url / 无 key / 失败）就只用 config.toml 的当前模型——
    // 不能凭空造列表。buildModelOptions 会把 currentModel 补到列表首位，
    // 所以替换掉 [currentModel] 不会让正在用的模型从下拉里消失。
    const live = endpointModelsOf(modelProviders[customProvider]);
    providerModels[customProvider] = live && live.length > 0 ? live : [currentModel];
  }

  return {
    currentModel,
    currentProvider,
    providerNames,
    providerEnvKeys,
    providerModels,
  };
}

/**
 * 管线第 3 段（纯装配）：给 provider 事实挂上 modelOptions 查询闭包，产出
 * 对外的 CodexConfigResult。
 */
function applyProfiles(profile: CodexProviderProfile): CodexConfigResult {
  return {
    ...profile,
    modelOptions: (provider?: string) =>
      buildModelOptions(
        profile.currentModel,
        profile.currentProvider,
        provider,
        profile.providerModels,
      ),
  };
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
  // 红线：resolveCodexHome 环境变量优先级（codexHome 参数 > $CODEX_HOME > ~/.codex）
  // 只在此解析一次，下游各段共用同一 codexHome，不得重复解析。
  const codexHome = resolveCodexHome(opts.codexHome);
  const catalogMode = isCodexCatalogMode(codexHome);

  // 统一目录来源：catalog 模式 = 活动目录（model_catalog_json 整体替换内置目录）；
  // 否则 = bundled（与原行为一致）
  const catalogSlugs = getCodexCatalogModels(codexHome).map((m) => m.slug);
  const allModels = catalogSlugs.length > 0 ? catalogSlugs : FALLBACK_MODELS;
  // anthropic 模型列表仅在用户显式配置 anthropic 时使用：catalog 可用取 catalog 中的
  // claude-*，否则用 ANTHROPIC_FALLBACK_MODELS（与 openai 兜底表隔离）
  const anthropicModels =
    catalogSlugs.length > 0
      ? catalogSlugs.filter((m) => m.startsWith('claude-'))
      : ANTHROPIC_FALLBACK_MODELS;

  const toml = readCodexToml(codexHome);

  if (toml.state === 'missing') {
    // 无 config.toml：默认模型取目录首个可用模型（codex default_model_from_available），
    // 目录不可用时回退 'o3'（FALLBACK_MODELS 首项，非 catalog 默认）
    const currentModel = allModels[0] ?? 'o3';
    // No config file: only openai has bundled models
    return applyProfiles({
      currentModel,
      currentProvider: FALLBACK_PROVIDERS[0],
      providerNames: FALLBACK_PROVIDERS,
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
      providerModels: { openai: allModels },
    });
  }

  if (toml.state === 'invalid') {
    // config.toml 读取/解析失败：readModelCatalogJsonPath 对此返回
    // TOML_PARSE_FAILED_SENTINEL（isCodexCatalogMode → false），因此正常路径下
    // catalogMode 恒为 false，下面的 `if (catalogMode)` 分支只在两次读取之间
    // config.toml 被改写（TOCTOU）时可达；保留该防御，避免把“已声明 catalog、
    // 随后配置损坏”误降级成 bundled 模型。
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
    return applyProfiles({
      currentModel: catalogSlugs[0] ?? 'o3',
      currentProvider: FALLBACK_PROVIDERS[0],
      providerNames: FALLBACK_PROVIDERS,
      providerEnvKeys: { openai: 'OPENAI_API_KEY' },
      providerModels: { openai: allModels },
    });
  }

  return applyProfiles(
    normalizeProviders(toml.parsed, { catalogMode, catalogSlugs, allModels, anthropicModels }),
  );
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
  // 不为空 currentModel 虚构默认值（catalog 退化场景由上层显式传入）；
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
