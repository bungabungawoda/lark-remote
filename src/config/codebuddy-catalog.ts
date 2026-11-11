/**
 * CodeBuddy 模型/配置目录探针（`codebuddy --acp` 一次性会话）。
 *
 * 模型清单与 thought_level 选项只随 session/new 下发（真机 2.142.0 实测：
 * `models.availableModels[]` + `configOptions[]`），没有独立 CLI 入口。
 *
 * 为什么是异步而不是 spawnSync 预排 stdin：--acp 服务端在 stdin EOF 时开始
 * 关闭，spawnSync 写完 input 即关 stdin，`session/new` 响应永远等不到
 * （实测 ETIMEDOUT 只收到 initialize）。必须真进程保住 stdin，顺序
 * initialize → session/new，拿到响应立即杀。同步侧只读缓存（过期也先用
 * 上次成功快照渲染，stale-while-revalidate）；`/config` 卡的 buildFields
 * 内联点火与启动预热负责异步刷新（同 DSH 目录探针模式）。
 *
 * 副作用：每次探针在 `<codebuddyHome>/projects/<tmpdir编码>/` 留一个空会话
 * 文件——TTL 缓存 + 预热摊平。spawn 收口 `platform/spawn.ts`（win32 垫片
 * 解析口径与 runner 一致）。
 *
 * 身份口径：目录是 f(登录态, 区域)，不是本地静态清单。探针必须透传
 * `agents.codebuddy.env`（runner 侧走 mergeProcessEnv 的同一份 override），
 * 否则「国内版设了 CODEBUDDY_INTERNET_ENVIRONMENT=internal」只作用于会话连接、
 * 不作用于 /config 的模型下拉。缓存因此按 env 指纹分区：区域一变，旧快照
 * 立即不可信（失败也不得 stale 复用）。登录态变化用 `settings.json` 的
 * mtime+size 指纹观测（切换登录时 CLI 会重写它，探针本身不会），指纹一变
 * 同样强制重探；上游 401 仍会 invalidateCodebuddyCatalogCache() 兜底。
 *
 * 区域判定：显式配了 agents.codebuddy.env.CODEBUDDY_INTERNET_ENVIRONMENT 时
 * 原样优先；未配置时先读「宿主已声明的区域」——V3 产品配置
 * （ACC_PRODUCT_CONFIG_PATH / ACC_PRODUCT_CONFIG_V3 的 networkEnvironment）
 * 与进程 env CODEBUDDY_INTERNET_ENVIRONMENT，V3 优先（CLI 侧 EnvProductProvider
 * 优先级 20000 高于 ClientInternetEnviromentProductProvider 6005）。命中即
 * 定区，只跑一次目录探针，不猜、不双探。
 *
 * 宿主没有 V3 / env 信号时，再读 WorkBuddy 桌面端落盘的 V3 产品配置缓存
 * （~/.workbuddy/cache/acc-product-config-v3-*.json 的 networkEnvironment）：
 * lark-remote 从普通终端启动时看不到 WorkBuddy 注入给子进程的产品配置，
 * 但宿主已按该缓存登录（endpoint / 账号区域同源），用它补上缺失的声明。
 *
 * 宿主没有信号时才退回双探针：internal / external 各跑一次，拿两份目录与
 * settings.json 的当前模型做唯一性匹配。两次探针复用 refreshCodebuddyCatalog
 * 的 in-flight 串行，不并发 spawn 两个 ACP server；胜出目录直接写回缓存。
 * 两边都可用却无法区分时不接管，保持宿主环境口径（不猜、不改用户环境）。
 *
 * 双探针的边界：session/new 的模型清单是 CLI 内置静态清单
 * （`codebuddy --help` 的 --model 可选项与它逐项相同），两个区域返回同一份，
 * 因此双探针在多数账号上必然 inconclusive——这正是前置判据必须存在的原因。
 *
 * 模型是否可用**不**由本目录决定：目录既不按账号权益过滤，也不区分区域，
 * 拿它当判据会放行账号无权的 id。模型口径见 `codebuddy-model-state.ts`
 * （上游 400 的 supported list + 上次成功值）。目录只用于展示名与积分费率。
 *
 * 全自动链路（除交互式 /login 外没有人工步骤）：
 * 1. 开跑前 ensureCodebuddyRegion() 等一次判定——启动探测未完成时，首条消息
 *    不会拿着宿主 env 打错端点；
 * 2. 上游 401 后 scheduleCodebuddyRegionRedetect() 在进程内重判，用户重新
 *    登录后无需重启 lark-remote。
 */

import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeProcessEnv, spawnProcess, useDetachedProcessGroup } from '../platform/spawn.js';
import { createTerminator, type Terminator } from '../platform/terminator.js';
import { getLogger } from '../logger/index.js';
import { CODEBUDDY_CLIENT_CAPABILITIES } from '../acp-protocol.js';
import { readCodebuddyAccountModel } from './codebuddy-model-state.js';

/** 目录里的一个模型（真机形状：modelId/name/_meta.maxInputTokens/effortOptions）。 */
interface CodebuddyCatalogModel {
  id: string;
  name: string;
  maxInputTokens?: number;
  /** 该模型支持的推理档位（value 清单；空 = 不限制/不支持档位选择）。 */
  efforts: string[];
  /**
   * 积分费率倍率（真机形状 "x0.29 credits"；hy4free 为 "x0.00 credits"）。
   * 只读目录 `_meta.credits`，展示用原始串不做数值解析（语义/单位随
   * CodeBuddy 版本走）。字段缺席是优雅退化：卡片不显示费率，不 crash。
   */
  credits?: string;
}

/** session/new 下发的配置面子集（桥接关心的两张表）。 */
interface CodebuddyCatalog {
  models: CodebuddyCatalogModel[];
  currentModelId?: string;
  thoughtLevels: Array<{ value: string; name: string }>;
}

/** thought_level 兜底清单（真机 2.142.0 观测值；catalog 不可用时用）。 */
export const THOUGHT_LEVEL_FALLBACK: ReadonlyArray<{ value: string; name: string }> = [
  { value: 'enabled', name: 'On（默认）' },
  { value: 'disabled', name: 'Off' },
  { value: 'minimal', name: 'Minimal' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'X-High' },
  { value: 'max', name: 'Max' },
];

const CATALOG_CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * CodeBuddy ACP 启动参数（探针与 runner 共用，必须一致）。
 *
 * `--serve --port 0` 不是可选项：CLI 在 ACP 模式下仍会起一个本地 HTTP 服务，
 * 默认端口写死 50403（帮助里的 "interactive mode reuses a stable port"）。
 * WorkBuddy 桌面端等其它 CodeBuddy 实例占着该端口时，进程直接
 * `EADDRINUSE ... exit 1`：探针拿不到目录（/config 模型列表永远停在旧快照），
 * runner 也起不来。`--port 0` 让 CLI 自动分配，ACP 仍走 stdio。
 *
 * 结构化提问（AskUserQuestion）不靠 CLI 参数：ACP 下由 initialize 的
 * clientCapabilities._meta['codebuddy.ai'].question 打开（见
 * src/acp-protocol.ts）；探针与 runner 共用同一份能力声明。探针只跑
 * initialize → session/new，不调工具，与 runner 共用同一份参数。
 */
export const CODEBUDDY_ACP_ARGS = ['--acp', '--serve', '--port', '0'] as const;

/** 区域取值（CODEBUDDY_INTERNET_ENVIRONMENT 的两种口径）。 */
const CODEBUDDY_REGIONS = ['internal', 'external'] as const;
type CodebuddyRegion = (typeof CODEBUDDY_REGIONS)[number];
const REGION_ENV_KEY = 'CODEBUDDY_INTERNET_ENVIRONMENT';
const PRODUCT_CONFIG_PATH_KEY = 'ACC_PRODUCT_CONFIG_PATH';
const PRODUCT_CONFIG_INLINE_KEYS = [
  'ACC_PRODUCT_CONFIG_V3',
  'ACC_PRODUCT_CONFIG_V2',
  'ACC_PRODUCT_CONFIG',
] as const;

/** 宿主/V3 已声明的区域（不 spawn、不联网）。 */
type CodebuddyRegionSource = 'v3-config' | 'host-env' | 'workbuddy-cache';
interface CodebuddyRegionSignal {
  region: CodebuddyRegion;
  source: CodebuddyRegionSource;
}

/** 区域取值只认 internal / external；ioa 等其它口径不接管。 */
function normalizeRegion(value: unknown): CodebuddyRegion | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'internal' || normalized === 'external' ? normalized : null;
}

/** endpoint 域名 → 区域（包内 product.json 的 internalDomain / externalDomain 口径）。 */
function regionFromEndpoint(value: unknown): CodebuddyRegion | null {
  if (typeof value !== 'string' || !value) return null;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (isHostOrSubdomain(host, 'codebuddy.ai') || isHostOrSubdomain(host, 'workbuddy.ai')) {
    return 'external';
  }
  if (
    host.endsWith('.cn') ||
    host === 'copilot.tencent.com' ||
    host.endsWith('.copilot.tencent.com')
  ) {
    return 'internal';
  }
  return null;
}

function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * V3 产品配置 JSON → 区域。优先级：networkEnvironment（官方字段）→
 * productFeaturesConfig.NetworkFailover.region（cn-saas）→ endpoint 域名。
 * 读不出就返回 null，让调用方退回宿主 env / 双探针。
 */
export function regionFromProductConfig(config: unknown): CodebuddyRegion | null {
  if (!config || typeof config !== 'object') return null;
  const rec = config as Record<string, unknown>;
  const declared = normalizeRegion(rec.networkEnvironment);
  if (declared) return declared;
  const failover = rec.productFeaturesConfig as
    { NetworkFailover?: { region?: unknown } } | undefined;
  const failoverRegion = failover?.NetworkFailover?.region;
  if (typeof failoverRegion === 'string' && failoverRegion.trim().toLowerCase().startsWith('cn-')) {
    return 'internal';
  }
  return regionFromEndpoint(rec.endpoint) ?? regionFromEndpoint(rec.stagingEndpoint);
}

function parseProductConfig(text: string): CodebuddyRegion | null {
  try {
    return regionFromProductConfig(JSON.parse(text) as unknown);
  } catch {
    return null; // 配置不可读 / 非 JSON：不猜
  }
}

/**
 * 读宿主已声明的区域：先 V3 产品配置（PATH 文件优先，其次内联 JSON env），
 * 再进程 env CODEBUDDY_INTERNET_ENVIRONMENT。V3 与 env 冲突时以 V3 为准——
 * CLI 最终 endpoint 由 V3 的 EnvProductProvider 裁决，读 env 会判错。
 * 纯本地读，没有信号时返回 null（交给双探针）。
 */
export function readHostCodebuddyRegion(
  env: NodeJS.ProcessEnv = process.env,
): CodebuddyRegionSignal | null {
  let v3Region: CodebuddyRegion | null = null;
  const configPath = env[PRODUCT_CONFIG_PATH_KEY];
  if (configPath) {
    try {
      v3Region = parseProductConfig(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // 文件不存在 / 不可读：退回内联 env
    }
  }
  if (!v3Region) {
    for (const key of PRODUCT_CONFIG_INLINE_KEYS) {
      const raw = env[key];
      if (!raw) continue;
      v3Region = parseProductConfig(raw);
      if (v3Region) break;
    }
  }

  const hostRegion = normalizeRegion(env[REGION_ENV_KEY]);
  if (v3Region) {
    if (hostRegion && hostRegion !== v3Region) {
      getLogger().warn(
        `[codebuddy-catalog] V3 product config declares ${v3Region} but ${REGION_ENV_KEY}=${hostRegion}; using V3`,
      );
    }
    return { region: v3Region, source: 'v3-config' };
  }
  return hostRegion ? { region: hostRegion, source: 'host-env' } : null;
}

/**
 * WorkBuddy 桌面端缓存的 V3 产品配置目录；目录不存在返回 null。
 * 只有 lark-remote 从普通终端启动（拿不到 WorkBuddy 注入的
 * ACC_PRODUCT_CONFIG_*）时才需要它。
 */
export function defaultCodebuddyProductConfigCacheDir(): string | null {
  try {
    const dir = path.join(os.homedir(), '.workbuddy', 'cache');
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 从 WorkBuddy 的 V3 产品配置缓存读宿主区域：按 mtime 从新到旧，最多看
 * 3 个 `acc-product-config-v3-*.json`（有的缓存只写 endpoint，由
 * regionFromProductConfig 的域名兜底判定）。读不到/解析失败返回 null。
 * 纯本地读，不 spawn、不联网。
 */
export function readCodebuddyProductConfigCacheRegion(
  cacheDir: string | null | undefined,
): CodebuddyRegionSignal | null {
  if (!cacheDir) return null;
  let names: string[];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return null;
  }
  const candidates: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (!/^acc-product-config-v3-.*\.json$/.test(name)) continue;
    const file = path.join(cacheDir, name);
    try {
      candidates.push({ file, mtime: fs.statSync(file).mtimeMs });
    } catch {
      // 读取中被清理：跳过
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates.slice(0, 3)) {
    try {
      const region = regionFromProductConfig(JSON.parse(fs.readFileSync(file, 'utf-8')));
      if (region) return { region, source: 'workbuddy-cache' };
    } catch {
      // 非 JSON / 半截文件：看下一个
    }
  }
  return null;
}

/**
 * 启动探测结果：只在「显式 env 未配置」时接管。null = 保持宿主环境口径；
 * 上游 401 / 重新探测会清掉它。进程内只判一次，重复调用不重复 spawn。
 */
let detectedRegion: CodebuddyRegion | null = null;
let regionDetectionInFlight: Promise<CodebuddyRegion | null> | null = null;

/** 开跑前等待区域判定的上限：超时就先用宿主 env 开跑，不把用户堵在启动上。 */
const REGION_DETECT_WAIT_MS = 8_000;
/** 401 后自动重判的冷却：上游持续 401 时不反复 spawn 探针。 */
const REGION_REDETECT_COOLDOWN_MS = 30_000;
let lastRegionRedetectAt = 0;
/**
 * 判定失败/无法区分后的退避：探针本身不可用时（CLI 卡住、两个端点都拒），
 * 没有这道闸，每条消息都会白等一次 REGION_DETECT_WAIT_MS。
 */
const REGION_DETECT_FAILURE_BACKOFF_MS = 60_000;
let lastRegionDetectFailureAt = 0;

/** 探针 env override（与 runner 侧 `agents.codebuddy.env` 同口径）。 */
type CodebuddyCatalogEnv = Record<string, string | undefined>;

/**
 * 缓存身份指纹：只编码显式的 env override。进程重启会重置整块缓存，
 * 宿主 process.env 无需入键；登录态变化没有 env 信号，走 401 invalidation。
 */
function envIdentityKey(env: CodebuddyCatalogEnv): string {
  return JSON.stringify(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

let catalogCache: {
  result: CodebuddyCatalog | null;
  timestamp: number;
  envKey: string;
  /** 探测时的账号指纹；变化说明登录态/账号被外部改过，缓存立即失效。 */
  accountKey: string | null;
} | null = null;
/** 正在跑的目录探针（并发点火复用，见 refreshCodebuddyCatalog）。 */
let catalogRefreshInFlight: {
  envKey: string;
  promise: Promise<CodebuddyCatalog | null>;
} | null = null;
/** invalidation 代际：失效后才结算的探针不得把它探测到的旧目录写回缓存。 */
let catalogEpoch = 0;

/**
 * 清空缓存（生产调用点：上游 401 认证失效、/config 改了 codebuddy env/binary；
 * 测试也用它做用例隔离）。同时 bump 代际，让在途探针的结果作废。
 */
export function invalidateCodebuddyCatalogCache(): void {
  catalogCache = null;
  catalogEpoch++;
}

/**
 * 同步读缓存（config 卡 buildFields 用）。从未成功探测 → null（卡片回退
 * 文本输入）。过期不影响可读性：返回上次成功目录，刷新由同一帧点火的
 * refreshCodebuddyCatalog 在后台完成（stale-while-revalidate）——否则卡在
 * TTL 边界打开时下拉会退化成输入框，而探针完成又不会触发重绘。
 */
export function loadCodebuddyCatalog(): CodebuddyCatalog | null {
  return catalogCache?.result ?? null;
}

/**
 * 排空在途探针 / 区域判定（测试用例边界用）。
 *
 * 生产路径不需要它：每个调用点都 await 自己那一轮的 promise。测试里必须显式
 * 排空，否则上一用例 fire-and-forget 的后台判定会在下一用例跑到一半才收尾
 * ——它可能把 `lastRegionDetectFailureAt` 设上退避，也可能让下一轮探针复用在途
 * 结果，断言（探针次数）就变成机器负载相关。最多排 8 轮，避免异常情况下挂住。
 */
export async function _drainCodebuddyProbesForTest(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const pending: Promise<unknown>[] = [];
    if (catalogRefreshInFlight) pending.push(catalogRefreshInFlight.promise);
    if (regionDetectionInFlight) pending.push(regionDetectionInFlight);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

interface CatalogModelInput {
  modelId?: unknown;
  name?: unknown;
  _meta?: {
    maxInputTokens?: unknown;
    effortOptions?: Array<{ value?: unknown }>;
    credits?: unknown;
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function effortsFrom(options: Array<{ value?: unknown }> | undefined): string[] {
  const efforts: string[] = [];
  for (const option of options ?? []) {
    const value = nonEmptyString(option?.value);
    if (value !== undefined) efforts.push(value);
  }
  return efforts;
}

/** 单条目录记录 → 模型（字段类型不符时该字段缺席，坏条目整体跳过）。 */
function parseCatalogModel(item: unknown): CodebuddyCatalogModel | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const m = item as CatalogModelInput;
  const id = nonEmptyString(m.modelId);
  if (id === undefined) return undefined;
  const meta = m._meta ?? {};
  const model: CodebuddyCatalogModel = {
    id,
    name: nonEmptyString(m.name) ?? id,
    efforts: effortsFrom(meta.effortOptions),
  };
  const maxInputTokens = numberOrUndefined(meta.maxInputTokens);
  if (maxInputTokens !== undefined) model.maxInputTokens = maxInputTokens;
  const credits = nonEmptyString(meta.credits);
  if (credits !== undefined) model.credits = credits;
  return model;
}

/** availableModels[] → 模型清单（跳过坏条目）。 */
function parseCatalogModels(available: unknown[]): CodebuddyCatalogModel[] {
  const models: CodebuddyCatalogModel[] = [];
  for (const item of available) {
    const model = parseCatalogModel(item);
    if (model !== undefined) models.push(model);
  }
  return models;
}

function currentModelIdPatch(
  models: { currentModelId?: unknown } | undefined,
): Pick<CodebuddyCatalog, 'currentModelId'> {
  const id = models?.currentModelId;
  return typeof id === 'string' ? { currentModelId: id } : {};
}

/** configOptions[] → thought_level 的 {value,name} 清单（无该选项 → 空）。 */
function parseThoughtLevels(
  configOptions: Array<Record<string, unknown>>,
): Array<{ value: string; name: string }> {
  const thoughtOption = configOptions.find((o) => o?.id === 'thought_level');
  const options = thoughtOption?.options as Array<{ value?: unknown; name?: unknown }> | undefined;
  return (options ?? [])
    .filter((o) => typeof o?.value === 'string')
    .map((o) => ({
      value: o.value as string,
      name: typeof o.name === 'string' ? o.name : (o.value as string),
    }));
}

/** session/new 响应 → 目录（纯函数，fixture 可单测）。结构不符 → null。 */
export function mapCatalogResponse(result: unknown): CodebuddyCatalog | null {
  if (!result || typeof result !== 'object') return null;
  const rec = result as {
    models?: { availableModels?: unknown[]; currentModelId?: unknown };
    configOptions?: Array<Record<string, unknown>>;
  };
  const available = rec.models?.availableModels;
  if (!Array.isArray(available) || available.length === 0) return null;

  const models = parseCatalogModels(available);
  if (models.length === 0) return null;

  return {
    models,
    ...currentModelIdPatch(rec.models),
    thoughtLevels: parseThoughtLevels(rec.configOptions ?? []),
  };
}

interface ProbeProcess {
  proc: ChildProcess;
  terminator: Terminator;
  /** stderr 尾部（探针失败时唯一的事后诊断通道）。 */
  stderrSuffix: () => string;
}

/**
 * spawn + Terminator + stderr 收集；同步 spawn 异常告警并返回 null。
 * 异步 `'error'`（ENOENT 等）由 probeOnce 统一收口，见那里的监听。
 */
function spawnProbeProcess(
  binary: string,
  cwd: string,
  env: CodebuddyCatalogEnv,
): ProbeProcess | null {
  let proc: ChildProcess;
  try {
    // 探针进程收尾走 Terminator（组杀/taskkill）：win32 上 codebuddy 是 .cmd
    // 垫片，裸 kill() 只杀 cmd.exe，node 子进程会带着 ACP server 变孤儿。
    // posix 侧 Terminator 用 kill(-pid) 组杀，子进程必须是进程组组长，否则
    // ESRCH 会被误判为成功、探针静默残留。用统一 seam：posix 建组，win32
    // 不建组（detached 会让 .cmd 丢 stdio）。
    proc = spawnProcess(binary, [...CODEBUDDY_ACP_ARGS], {
      cwd,
      // 与 runner 的 JsonlRpcTransport 同口径：宿主 env + agents.codebuddy.env
      // 覆盖（mergeProcessEnv 处理 win32 大小写同名键）。不传 env 时探针只看
      // 得见 lark-remote 自己的进程环境，国内版 internal 就永远到不了目录探针。
      env: mergeProcessEnv(process.env, env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: useDetachedProcessGroup(),
    });
  } catch (err) {
    getLogger().warn(`[codebuddy-catalog] spawn failed: ${(err as Error).message}`);
    return null;
  }
  const stderrTail: string[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk.toString());
    if (stderrTail.length > 5) stderrTail.shift();
  });
  return {
    proc,
    terminator: createTerminator({ graceMs: 2_000, agent: 'codebuddy' }),
    stderrSuffix: () =>
      stderrTail.length > 0 ? `: ${stderrTail.join('').slice(-2000).trim()}` : '',
  };
}

interface ProbeHandshakeState {
  sawInitialize: boolean;
  cwd: string;
  send: (obj: unknown) => void;
}

/** 单行 JSON-RPC → 握手推进 / 收口；done=true 时 catalog 交给 finish。 */
function handleProbeLine(
  line: string,
  state: ProbeHandshakeState,
): { done: true; catalog: CodebuddyCatalog | null } | { done: false } {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return { done: false };
  let msg: { id?: unknown; result?: unknown };
  try {
    msg = JSON.parse(trimmed) as { id?: unknown; result?: unknown };
  } catch {
    return { done: false }; // 非 JSON 行（日志污染）跳过
  }
  if (msg.id === 1 && !state.sawInitialize) {
    // initialize 响应到达 → 发 ACP 规范的 initialized 通知 + session/new。
    state.sawInitialize = true;
    state.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    state.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: state.cwd, mcpServers: [] },
    });
    return { done: false };
  }
  if (msg.id === 2 && msg.result) {
    return { done: true, catalog: mapCatalogResponse(msg.result) };
  }
  return { done: false };
}

/**
 * 对真 `codebuddy --acp` 进程跑 initialize → session/new，返回 session/new
 * 的 result。超时/退出/解析失败 → null（调用方回退静态清单），不抛。
 * timeoutMs 仅作为可测性 seam（生产默认 PROBE_TIMEOUT_MS）。
 */
async function probeOnce(
  binary: string,
  cwd: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  env: CodebuddyCatalogEnv = {},
): Promise<CodebuddyCatalog | null> {
  const spawned = spawnProbeProcess(binary, cwd, env);
  if (!spawned) return null;
  const { proc, terminator, stderrSuffix } = spawned;
  const logger = getLogger();

  return new Promise<CodebuddyCatalog | null>((resolve) => {
    const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
    let settled = false;
    const finish = (value: CodebuddyCatalog | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminator
        .stop(proc, { immediate: true })
        .catch((err) => {
          // 杀探针失败（如 win32 句柄占用重试耗尽）意味着探针进程可能残留，
          // 不能无声——否则泄漏无痕（probe 本身的结果另走 warn，与此无关）。
          logger.debug(`[codebuddy-catalog] probe terminator.stop failed: ${String(err)}`);
        })
        .finally(() => {
          if (!value) {
            logger.warn(
              `[codebuddy-catalog] probe failed (${reason ?? 'stream closed'})${stderrSuffix()}`,
            );
          }
          resolve(value);
        });
    };

    // spawn 失败（binary 不存在 / 无执行权限）以异步 `'error'` 事件到达，
    // spawnProbeProcess 的同步 try/catch 抓不到；win32 上 cross-spawn 还会用
    // verifyENOENT 主动 emit。预热与卡片点火都是 fire-and-forget，不监听就会
    // 变成未捕获异常，轻则测试报 Unhandled Errors，重则击穿整个进程。
    proc.on('error', (err) => finish(null, `spawn: ${(err as Error).message}`));

    const send = (obj: unknown) => proc.stdin?.write(`${JSON.stringify(obj)}\n`);
    const state: ProbeHandshakeState = { sawInitialize: false, cwd, send };
    // spawn 未成功时 stdout 可能是 null（平台差异），不能把空 stream 交给
    // readline.createInterface 抛 TypeError 掩盖真正的失败原因。
    if (!proc.stdout) {
      finish(null, 'spawn: no stdout');
      return;
    }
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const outcome = handleProbeLine(line, state);
      if (outcome.done) finish(outcome.catalog);
    });
    rl.on('close', () => finish(null));

    // 握手起点：initialize（session/new 在 id=1 响应到达后发，见 line 处理器）。
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: CODEBUDDY_CLIENT_CAPABILITIES,
      },
    });
  });
}

/**
 * 异步刷新目录（buildFields 内联点火 / 启动预热调用）。成功写入新目录；
 * 同一身份下失败保留上次成功目录并照常记时间戳（negative cache 让失败的
 * 探针在 TTL 内不再反复 spawn）。换身份（env 指纹变了 / invalidate 过）时
 * 旧目录一律不可信，失败也不 stale 复用。返回本次结果。
 * binary/timeoutMs 是测试 seam，生产只传第三个 env 参数。
 */
export function refreshCodebuddyCatalog(
  binary = 'codebuddy',
  timeoutMs = PROBE_TIMEOUT_MS,
  env: CodebuddyCatalogEnv = {},
  opts: { force?: boolean } = {},
): Promise<CodebuddyCatalog | null> {
  // 卡片每次重绘都会点火。TTL 内且账号指纹未变时直接吃缓存（含 negative
  // cache），并发点火复用同一个 in-flight probe；约束：TTL 窗口内重复重绘
  // 不得重复 spawn。force 供 /config 打开这类「必须反映当前登录」的路径使用。
  const envKey = envIdentityKey(env);
  const accountKey = readAccountFingerprint();
  const cached = catalogCache;
  const cacheValid =
    cached !== null &&
    cached.envKey === envKey &&
    cached.accountKey === accountKey &&
    Date.now() - cached.timestamp < CATALOG_CACHE_TTL_MS;
  if (cacheValid && !opts.force) {
    return Promise.resolve(cached.result);
  }
  if (catalogRefreshInFlight) {
    if (catalogRefreshInFlight.envKey === envKey && !opts.force) {
      return catalogRefreshInFlight.promise;
    }
    // 身份已变（/config 改了 env、换了登录）：旧探针结果属于另一个身份，
    // 不能复用。串行等它收尾再按新身份点火，避免同时 spawn 两个 ACP server。
    return catalogRefreshInFlight.promise.then(() =>
      refreshCodebuddyCatalog(binary, timeoutMs, env, opts),
    );
  }

  const epoch = catalogEpoch;
  const promise = probeOnce(binary, os.tmpdir(), timeoutMs, env)
    .then((result) => {
      if (epoch !== catalogEpoch) {
        // 401 invalidation 发生在这次探针在途期间：结果来自旧登录态，丢弃。
        getLogger().warn('[codebuddy-catalog] discarding probe result after invalidation');
        return result;
      }
      // 失败只复用「同一身份」的 stale 快照——env 与账号指纹都要一致。换区
      // 或换账号后继续渲染旧目录，正是「/config 的模型列表没跟着切换」的
      // 直接机制。
      const prev = catalogCache;
      const sameIdentityStale =
        prev && prev.envKey === envKey && prev.accountKey === accountKey ? prev.result : null;
      catalogCache = {
        result: result ?? sameIdentityStale,
        timestamp: Date.now(),
        envKey,
        accountKey,
      };
      if (!result) {
        getLogger().warn(
          '[codebuddy-catalog] probe unavailable, keeping last known catalog if any',
        );
      }
      return result;
    })
    .finally(() => {
      catalogRefreshInFlight = null;
    });
  catalogRefreshInFlight = { envKey, promise };
  return promise;
}

/**
 * 后台预热（fire-and-forget；同身份失败保留上次成功目录，从未成功时落
 * negative cache，卡片路径优雅回退）。env 必须与 runner 侧同一份配置。
 */
function warmCodebuddyCatalogCache(env: CodebuddyCatalogEnv = {}, binary = 'codebuddy'): void {
  void refreshCodebuddyCatalog(binary, PROBE_TIMEOUT_MS, env).catch(() => {});
}

/**
 * 账号指纹：settings.json 的 mtime + size。
 *
 * 切换登录（换账号 / 换区域）时 CLI 会重写它，而目录探针本身不会（真机实测：
 * 连续探针不改变 mtime）。所以「指纹变了」= 账号被外部改过，目录快照必须
 * 重新探——这是 `/config` 打开时能立刻反映新登录的唯一本地信号（env 指纹
 * 只能覆盖区域显式配置的情况）。只 stat、不读内容。
 */
function readAccountFingerprint(): string | null {
  try {
    const st = fs.statSync(path.join(os.homedir(), '.codebuddy', 'settings.json'));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export interface RegionProbeResult {
  region: CodebuddyRegion;
  catalog: CodebuddyCatalog | null;
}

/**
 * 双探针判据（纯函数）：只有一个区域拿到目录就选它；两边都拿到时，用账号
 * 当前模型做唯一性匹配（currentModelId 精确匹配优先）。仍无法区分则返回
 * null —— 不猜、不覆盖宿主 env。
 */
export function pickWinningRegion(
  probes: RegionProbeResult[],
  accountModel?: string,
): RegionProbeResult | null {
  const valid = probes.filter((p) => p.catalog && p.catalog.models.length > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  if (accountModel) {
    const exact = valid.filter((p) => p.catalog!.currentModelId === accountModel);
    if (exact.length === 1) return exact[0];
    const contains = valid.filter((p) => p.catalog!.models.some((m) => m.id === accountModel));
    if (contains.length === 1) return contains[0];
  }
  return null;
}

/** 探测胜出后把目录写回缓存（同身份 envKey），避免再 spawn 一次探针。 */
function primeCodebuddyCatalog(catalog: CodebuddyCatalog, env: CodebuddyCatalogEnv): void {
  catalogCache = {
    result: catalog,
    timestamp: Date.now(),
    envKey: envIdentityKey(env),
    accountKey: readAccountFingerprint(),
  };
}

export function getDetectedCodebuddyRegion(): CodebuddyRegion | null {
  return detectedRegion;
}

/**
 * 统一 env 口径：显式配置的 CODEBUDDY_INTERNET_ENVIRONMENT 原样优先；否则
 * 叠加启动探测出的区域。runner、目录探针、启动预热都必须经过这里。
 */
export function resolveCodebuddyEnv(env: CodebuddyCatalogEnv = {}): CodebuddyCatalogEnv {
  if (env[REGION_ENV_KEY] !== undefined || !detectedRegion) return env;
  return { ...env, [REGION_ENV_KEY]: detectedRegion };
}

/** 清掉自动判定结果（上游 401 后让下一条消息重新判定）。 */
export function invalidateCodebuddyRegion(): void {
  detectedRegion = null;
  // 401 后的重判必须能立刻生效，不受失败退避影响。
  lastRegionDetectFailureAt = 0;
}

/**
 * 开跑前的区域屏障：显式配置或已判定时立即返回；否则等待双探针（上限
 * opts.waitMs，默认 REGION_DETECT_WAIT_MS）。超时/失败返回 null，调用方按
 * 宿主 env 继续——宁可这一轮可能打错端点，也不把用户堵在启动探测上。探测
 * 本身有 in-flight 去重，多个并发会话共享同一次判定。
 */
export async function ensureCodebuddyRegion(
  env: CodebuddyCatalogEnv = {},
  opts: { waitMs?: number; binary?: string; hostProductConfigCacheDir?: string | null } = {},
): Promise<CodebuddyRegion | null> {
  if (env[REGION_ENV_KEY] !== undefined) return null;
  if (detectedRegion) return detectedRegion;
  // 上一轮判定失败/超时且还在退避窗口内：直接放行，别再堵一次。
  if (Date.now() - lastRegionDetectFailureAt < REGION_DETECT_FAILURE_BACKOFF_MS) return null;
  const waitMs = opts.waitMs ?? REGION_DETECT_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const result = await Promise.race([
      detectCodebuddyRegion({
        configuredEnv: env,
        binary: opts.binary,
        hostProductConfigCacheDir: opts.hostProductConfigCacheDir,
      }),
      timeout,
    ]);
    if (result === null && !detectedRegion) {
      // 这一轮没等到结论（超时或探测失败）：退避一段时间，后续消息直接放行。
      lastRegionDetectFailureAt = Date.now();
    }
    return result;
  } catch {
    lastRegionDetectFailureAt = Date.now();
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 401 后的进程内重判：用户重新 /login 后新凭据已落在 ~/.codebuddy，重建连接
 * 就能用对区域，不需要重启 lark-remote。冷却窗口防止上游持续 401 时反复
 * spawn 探针；已有探测在途时等它收尾再点火（那次结果已被 epoch 判废）。
 */
export function scheduleCodebuddyRegionRedetect(
  env: CodebuddyCatalogEnv = {},
  opts: { binary?: string; hostProductConfigCacheDir?: string | null } = {},
): void {
  if (env[REGION_ENV_KEY] !== undefined) return;
  const now = Date.now();
  if (now - lastRegionRedetectAt < REGION_REDETECT_COOLDOWN_MS) return;
  lastRegionRedetectAt = now;
  const fire = () => {
    void detectCodebuddyRegion({
      configuredEnv: env,
      binary: opts.binary,
      hostProductConfigCacheDir: opts.hostProductConfigCacheDir,
    }).catch(() => {});
  };
  const inFlight = regionDetectionInFlight;
  if (inFlight) {
    void inFlight.finally(fire).catch(() => {});
    return;
  }
  fire();
}

interface DetectCodebuddyRegionOptions {
  binary?: string;
  timeoutMs?: number;
  configuredEnv?: CodebuddyCatalogEnv;
  accountModel?: string;
  /** 丢弃已判定结果重新判定（`/config` 发现当前区域探不通时使用）。 */
  force?: boolean;
  /**
   * WorkBuddy V3 产品配置缓存目录（宿主区域声明的本地副本）。生产入口传入
   * `defaultCodebuddyProductConfigCacheDir()`；不传 = 不看缓存（双探针语义）。
   */
  hostProductConfigCacheDir?: string | null;
}

/**
 * 启动时判定区域：宿主/V3 已声明区域时只跑一次目录探针；否则 internal /
 * external 各跑一次（复用 refresh 的 in-flight 串行，不并发 spawn 两个 ACP
 * server）。显式配置、探针全失败、或两边目录无法区分时返回 null，保持宿主
 * env 口径，不擅自改写用户环境。
 */
export async function detectCodebuddyRegion(
  opts: DetectCodebuddyRegionOptions = {},
): Promise<CodebuddyRegion | null> {
  const configuredEnv = opts.configuredEnv ?? {};
  if (configuredEnv[REGION_ENV_KEY] !== undefined) {
    detectedRegion = null; // 显式配置优先，不接管
    return null;
  }
  if (opts.force) detectedRegion = null;
  if (detectedRegion) return detectedRegion;
  if (regionDetectionInFlight) return regionDetectionInFlight;

  const binary = opts.binary ?? 'codebuddy';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const accountModel = opts.accountModel ?? readCodebuddyAccountModel();
  const epoch = catalogEpoch;

  const task = (async () => {
    // 前置判据：宿主/V3 已经声明区域就不必猜。只跑一次目录探针（双探针的
    // 前提不存在），结果由 refreshCodebuddyCatalog 按胜出区域的 envKey 入缓存，
    // runner 与 /config 通过 resolveCodebuddyEnv 拿到同一份 env。V3/env 都没
    // 声明时再看 WorkBuddy 落盘的产品配置缓存（普通终端启动的常见形态）。
    const hostSignal =
      readHostCodebuddyRegion() ??
      readCodebuddyProductConfigCacheRegion(opts.hostProductConfigCacheDir);
    if (hostSignal) {
      const env = { ...configuredEnv, [REGION_ENV_KEY]: hostSignal.region };
      await refreshCodebuddyCatalog(binary, timeoutMs, env);
      if (epoch !== catalogEpoch) {
        getLogger().warn('[codebuddy-catalog] region resolution superseded by invalidation');
        return null;
      }
      detectedRegion = hostSignal.region;
      lastRegionDetectFailureAt = 0;
      getLogger().info(
        `[codebuddy-catalog] region resolved from ${hostSignal.source}: ${hostSignal.region}`,
      );
      return hostSignal.region;
    }

    const probes: RegionProbeResult[] = [];
    for (const region of CODEBUDDY_REGIONS) {
      const env = { ...configuredEnv, [REGION_ENV_KEY]: region };
      probes.push({ region, catalog: await refreshCodebuddyCatalog(binary, timeoutMs, env) });
    }
    const winner = pickWinningRegion(probes, accountModel);
    if (!winner) {
      // 两边都没目录，或都有目录却无法唯一匹配：进入退避窗口，别让后续每条
      // 消息都再等一轮注定没有结论的探针。
      lastRegionDetectFailureAt = Date.now();
      getLogger().warn(
        '[codebuddy-catalog] region detection inconclusive, keeping host environment',
      );
      return null;
    }
    if (epoch !== catalogEpoch) {
      // 探测在途期间发生了 401 invalidation：两份目录都来自旧登录态，作废。
      // 这是「结果过期」不是「判定失败」，不进入退避——401 后要能立刻重判。
      getLogger().warn('[codebuddy-catalog] region detection superseded by invalidation');
      return null;
    }
    const winnerEnv = { ...configuredEnv, [REGION_ENV_KEY]: winner.region };
    detectedRegion = winner.region;
    lastRegionDetectFailureAt = 0;
    primeCodebuddyCatalog(winner.catalog!, winnerEnv);
    getLogger().info(`[codebuddy-catalog] region auto-detected: ${winner.region}`);
    return winner.region;
  })().finally(() => {
    regionDetectionInFlight = null;
  });
  regionDetectionInFlight = task;
  return task;
}

/** `/config` 打开时的目录刷新结果。 */
interface CodebuddyConfigRefresh {
  catalog: CodebuddyCatalog | null;
  /** 登录态/区域可能已变：调用方应丢弃持久 sessionId 与缓存 runner。 */
  identityChanged: boolean;
  region: CodebuddyRegion | null;
}

/**
 * `/config` 打开前的目录刷新：保证卡片反映**当前登录**，而不是上一个账号的
 * 快照。
 *
 * 三条路径：
 * 1. 账号指纹未变、TTL 内 → 直接吃缓存（常态，不 spawn）；
 * 2. 指纹变了（切换登录 / 换账号）→ 缓存自动失效，强制重探当前区域；
 * 3. 当前区域探不通（切区后旧区域必然拒绝）→ 双探针重判并接管新区域。
 *
 * 返回 `identityChanged` 时调用方必须重置 CodeBuddy 的持久 sessionId 与
 * runner：它们绑在旧身份上，不重置的话下一条消息会在失效端点重放 401。
 */
export async function refreshCodebuddyCatalogForConfig(
  opts: {
    binary?: string;
    env?: CodebuddyCatalogEnv;
    timeoutMs?: number;
    hostProductConfigCacheDir?: string | null;
  } = {},
): Promise<CodebuddyConfigRefresh> {
  const configuredEnv = opts.env ?? {};
  const binary = opts.binary ?? 'codebuddy';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const before = catalogCache;
  const fingerprintChanged = before !== null && before.accountKey !== readAccountFingerprint();

  let catalog = await refreshCodebuddyCatalog(
    binary,
    timeoutMs,
    resolveCodebuddyEnv(configuredEnv),
  );
  let region = getDetectedCodebuddyRegion();
  let regionSwitched = false;

  if (!catalog && configuredEnv[REGION_ENV_KEY] === undefined) {
    // 当前区域拿不到目录：按区域判定重判（宿主信号优先，否则双探针）。显式
    // 配置了区域时不接管（用户锁定优先）。
    const detected = await detectCodebuddyRegion({
      configuredEnv,
      binary,
      timeoutMs,
      force: true,
      hostProductConfigCacheDir: opts.hostProductConfigCacheDir,
    });
    const fresh = detected ? loadCodebuddyCatalog() : null;
    if (detected && fresh) {
      catalog = fresh;
      region = detected;
      regionSwitched = true;
    }
  }

  return {
    catalog,
    identityChanged: fingerprintChanged || regionSwitched,
    region: region ?? null,
  };
}

/**
 * 启动预热入口：显式配了区域环境变量就直接预热；否则先做区域判定（宿主信号
 * 优先，没有信号才双探针），成功时 detect 已把目录写入缓存，失败/无法区分时
 * 按宿主 env 常规预热。binary 必须与 runner 同源
 * （`agents.codebuddy.acp.binary`），否则配了自定义 CLI 的机器会去探一个不存在
 * 的 `codebuddy`。
 */
export function warmCodebuddyCatalogWithRegionDetection(
  env: CodebuddyCatalogEnv = {},
  binary?: string,
  hostProductConfigCacheDir?: string | null,
): void {
  if (env[REGION_ENV_KEY] !== undefined) {
    warmCodebuddyCatalogCache(env, binary);
    return;
  }
  void detectCodebuddyRegion({ configuredEnv: env, binary, hostProductConfigCacheDir })
    .then((region) => {
      if (!region) warmCodebuddyCatalogCache(resolveCodebuddyEnv(env), binary);
    })
    .catch(() => {});
}
