/**
 * pi 配置读取工具
 *
 * 事实源是 `pi --list-models`：这是 pi 运行时自己的解析结果——内置 provider
 * 目录与 models.json 叠加后、再按「凭据可用」过滤的清单。
 *
 * 不直接读 models.json 的原因（实测）：
 * - `models[]` 是**追加**语义，不是全集。内置 provider 只写 1 条，pi 实际给出
 *   内置 4 条 + 新增 1 条 = 5 条；按文件读只得 1 条。
 * - 内置 provider（anthropic/google 等）不在 models.json 里，按文件读完全看不到。
 * - 本机实测：pi 可用 14 个模型，按文件读只得 8 个。
 * 语义出处：pi `docs/models-configuration.md`（「内置 provider ID 表示修改该
 * provider；每条 models 条目新增一个模型」）。
 *
 * 命令输出是定宽表格（pi 无 JSON 模式，见其 dist/cli/list-models.js）：
 * 六列以两个空格分隔，超长 id 会把列撑开，所以按分隔符切而不是按列位取。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runTextCommandAsync, runTextCommandSync } from '../platform/cli-command.js';
import { SyncCatalog } from './catalog-cache.js';

/** pi CLI 名（cross-spawn 负责 win32 .cmd 垫片解析）。 */
const PI_BINARY = 'pi';

/**
 * 命令超时 / 输出上限。实测本机 `pi --list-models` 166–244ms，8s 留足 Windows
 * 首次 node 冷启动；失败由负缓存兜住，不会每次打开卡片都等满。
 */
const PI_TIMEOUT_MS = 8_000;
const PI_MAX_BUFFER = 4 * 1024 * 1024;

/** 成功结果缓存：pi 的清单只在装/卸模型、登录登出时变。 */
const PI_CACHE_TTL_MS = 5 * 60 * 1000;
/** 失败负缓存：立刻重试只会再等满一次超时（未安装时尤其浪费）。 */
const PI_NEGATIVE_TTL_MS = 30 * 1000;

/** 探测调用的边界（共用实现见 platform/cli-command）。 */
const PI_COMMAND = {
  label: 'pi',
  timeoutMs: PI_TIMEOUT_MS,
  maxBuffer: PI_MAX_BUFFER,
} as const;

/** pi 列出的一个模型：provider 决定下拉分组，model 是喂给 `pi --model` 的 ID。 */
export interface PiListedModel {
  provider: string;
  model: string;
}

/** loadPiConfig() 的返回类型，包含 provider 和 model 的聚合信息 */
interface PiConfigResult {
  /** provider 名称列表 */
  providerNames: string[];
  /** 获取指定 provider 的 model 选项 */
  modelOptions: (provider?: string) => string[];
}

/**
 * 解析 pi 配置目录。优先使用 PI_CONFIG_DIR 环境变量（测试隔离用），
 * 默认 ~/.pi/agent。每次调用时动态读取环境变量，避免模块级缓存导致
 * singleFork 模式下测试设置 env 过晚。
 *
 * 空串/纯空白按「未设置」处理：`??` 只挡 undefined，放过空串会让 models.json
 * 解析成相对**进程 cwd** 的路径。
 */
function getPiConfigDir(): string {
  return process.env.PI_CONFIG_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
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
 *
 * 只在 `pi --list-models` 拿不到任何模型时使用：CLI 未安装、超时、或本进程
 * 环境里没有任何可用凭据。语义约束：每个 model 中出现的 provider 都必须在
 * provider fallback 中。
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
  const all = FALLBACK_ENTRIES.map((e) => e.modelId);
  if (!provider) return all;
  return all.filter((m) => {
    const entry = FALLBACK_ENTRIES.find((e) => e.modelId === m);
    return entry?.provider === provider;
  });
}

// ---------------------------------------------------------------------------
// `pi --list-models` 输出解析
// ---------------------------------------------------------------------------

/**
 * 把 `pi --list-models` 的 stdout 解析成 (provider, model) 对。
 *
 * 表格首行是表头，其余每行以两个以上空格分隔六列（provider / model /
 * context / max-out / thinking / images）。只取前两列：能力列当前没有消费方，
 * 不解析就不会因为 pi 增列而误判。行列数不足（哨兵文案、空行、夹带日志）
 * 一律跳过——列表宁短勿脏，脏行会把 provider 当成模型灌进下拉框。
 *
 * 零模型时 pi 打印一段提示文案而非空输出（formatNoModelsAvailableMessage），
 * 首行不是表头即视为空清单，交给 fallback。
 */
export function parsePiListModels(stdout: string): PiListedModel[] {
  const out: PiListedModel[] = [];
  let seenHeader = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const cols = line.split(/ {2,}/);
    if (cols.length < 2) continue;
    const [provider, model] = cols;
    if (!seenHeader) {
      // 表头：provider / model。不是表头的第一行说明没有表格（提示文案等）
      if (provider.trim() !== 'provider' || model.trim() !== 'model') return [];
      seenHeader = true;
      continue;
    }
    out.push({ provider: provider.trim(), model: model.trim() });
  }
  return seenHeader ? out : [];
}

// ---------------------------------------------------------------------------
// `pi --list-models` 调用与缓存
// ---------------------------------------------------------------------------

/**
 * 缓存键：包含命令会读的两个文件的指纹。
 *
 * 用户改了 models.json（增删模型）或登录/登出（auth.json 变化）时清单会变，
 * 键不跟着变就会在 TTL 内一直给旧清单。PI_CONFIG_DIR 进键是为了测试与多配置
 * 目录互不串味。
 */
function computePiListKey(): string {
  const fingerprint = (file: string): string => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  };
  return [
    PI_BINARY,
    getPiConfigDir(),
    fingerprint(_getModelsFilePath()),
    fingerprint(_getAuthFilePath()),
  ].join('\u0000');
}

/** `pi --list-models` 的同步输出；命令名进错误信息，stderr 片段随错误带出。 */
function runPiListSync(): string {
  return runTextCommandSync(PI_BINARY, ['--list-models'], PI_COMMAND);
}

/** `pi --list-models` 的异步输出，与同步路径同超时 / 输出上限。 */
function runPiListAsync(): Promise<string> {
  return runTextCommandAsync(PI_BINARY, ['--list-models'], PI_COMMAND);
}

/**
 * 统一 SWR 缓存：同步读快照、后台异步刷新。TTL 过期不再同步 spawn CLI，
 * 事件循环不再被 pi 的 166–244ms 阻塞（其它 agent 的 run 卡流式 patch 一起受益）。
 */
const piListCatalog = new SyncCatalog<PiListedModel[]>({
  agent: 'pi',
  key: computePiListKey,
  loadSync: () => parsePiListModels(runPiListSync()),
  loadAsync: async () => parsePiListModels(await runPiListAsync()),
  fallback: () => [],
  isEmpty: (models) => models.length === 0,
  ttlMs: PI_CACHE_TTL_MS,
  negativeTtlMs: PI_NEGATIVE_TTL_MS,
});

/**
 * pi 当前列出的模型（同步）。
 *
 * 同步路径只读快照：命中直接返回；TTL 过期返回旧快照并在后台刷新；刷新在途
 * 且无快照时返回空清单交给调用方 fallback。冷启动（无快照）保留一次同步加载，
 * 保证首帧就有真实清单；启动 `warmPiListCache` 后生产路径几乎不会走到这里。
 */
export function loadPiListedModels(): PiListedModel[] {
  return piListCatalog.read();
}

/**
 * 显式异步加载：单飞刷新快照并返回结果（warm / 测试用）。
 */
export async function loadPiListedModelsAsync(): Promise<PiListedModel[]> {
  return piListCatalog.refresh();
}

/**
 * 启动时后台预热：消除首次打开 Pi 配置卡时的同步 spawn。
 * fire-and-forget；失败落负缓存，同步路径照常 fallback。
 */
export function warmPiListCache(): void {
  piListCatalog.warm();
}

/** Test utility: clear the cache and any in-flight loads. */
export function _invalidatePiListCacheForTest(): void {
  piListCatalog.invalidate();
}

// ---------------------------------------------------------------------------
// 对外的 provider / model 查询
// ---------------------------------------------------------------------------

/**
 * 聚合加载 pi 配置，返回 provider 和 model 的查询接口。
 *
 * 未拿到任何模型（CLI 缺失/超时/无凭据）时回退到 FALLBACK_ENTRIES；指定了
 * provider 但该 provider 没有模型时，同样回退到它的 fallback，避免下拉框变空。
 */
export function loadPiConfig(): PiConfigResult {
  const listed = loadPiListedModels();
  if (listed.length === 0) {
    return {
      providerNames: getPiProviderFallback(),
      modelOptions: (provider?: string) => getPiModelFallback(provider),
    };
  }

  const providerNames = [...new Set(listed.map((m) => m.provider))];

  const modelOptions = (provider?: string): string[] => {
    const models = listed.filter((m) => !provider || m.provider === provider).map((m) => m.model);
    const unique = [...new Set(models)];
    return unique.length > 0 ? unique : getPiModelFallback(provider);
  };

  return { providerNames, modelOptions };
}

/**
 * 获取可用的 model 列表（纯 model ID，不带 provider 前缀）
 *
 * @param provider 可选，指定 provider 时只返回该 provider 的模型
 * @returns pi 列出的模型 ID 数组
 */
export function getPiModelOptions(provider?: string): string[] {
  return loadPiConfig().modelOptions(provider);
}
