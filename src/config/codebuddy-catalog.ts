/**
 * CodeBuddy 模型/配置目录探针（`codebuddy --acp` 一次性会话）。
 *
 * 模型清单与 thought_level 选项只随 session/new 下发（真机 2.142.0 实测：
 * `models.availableModels[]` + `configOptions[]`），没有独立 CLI 入口。
 *
 * 为什么是异步而不是 spawnSync 预排 stdin：--acp 服务端在 stdin EOF 时开始
 * 关闭，spawnSync 写完 input 即关 stdin，`session/new` 响应永远等不到
 * （实测 ETIMEDOUT 只收到 initialize）。必须真进程保住 stdin，顺序
 * initialize → session/new，拿到响应立即杀。同步侧只读缓存；`/config` 卡的
 * buildFields 内联点火与启动预热负责异步刷新（同 DSH 目录探针模式）。
 *
 * 副作用：每次探针在 `<codebuddyHome>/projects/<tmpdir编码>/` 留一个空会话
 * 文件——TTL 缓存 + 预热摊平。spawn 收口 `platform/spawn.ts`（win32 垫片
 * 解析口径与 runner 一致）。
 */

import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import { spawnProcess } from '../platform/spawn.js';
import { createTerminator, type Terminator } from '../platform/terminator.js';
import { getLogger } from '../logger/index.js';
import { CODEBUDDY_CLIENT_CAPABILITIES } from '../acp-protocol.js';

/** 目录里的一个模型（真机形状：modelId/name/_meta.maxInputTokens/effortOptions）。 */
export interface CodebuddyCatalogModel {
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
export interface CodebuddyCatalog {
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

let catalogCache: { result: CodebuddyCatalog | null; timestamp: number } | null = null;

/** 清空缓存（仅供测试使用，生产代码无调用点）。 */
export function invalidateCodebuddyCatalogCache(): void {
  catalogCache = null;
}

/** 同步读缓存（config 卡 buildFields 用）。未预热/过期 → null。 */
export function loadCodebuddyCatalog(): CodebuddyCatalog | null {
  if (!catalogCache) return null;
  if (Date.now() - catalogCache.timestamp >= CATALOG_CACHE_TTL_MS) return null;
  return catalogCache.result;
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

/** spawn + Terminator + stderr 收集；spawn 失败告警并返回 null。 */
function spawnProbeProcess(binary: string, cwd: string): ProbeProcess | null {
  let proc: ChildProcess;
  try {
    // 探针进程收尾走 Terminator（组杀/taskkill）：win32 上 codebuddy 是 .cmd
    // 垫片，裸 kill() 只杀 cmd.exe，node 子进程会带着 ACP server 变孤儿。
    proc = spawnProcess(binary, ['--acp'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
): Promise<CodebuddyCatalog | null> {
  const spawned = spawnProbeProcess(binary, cwd);
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
        .catch(() => {})
        .finally(() => {
          if (!value) {
            logger.warn(
              `[codebuddy-catalog] probe failed (${reason ?? 'stream closed'})${stderrSuffix()}`,
            );
          }
          resolve(value);
        });
    };

    const send = (obj: unknown) => proc.stdin?.write(`${JSON.stringify(obj)}\n`);
    const state: ProbeHandshakeState = { sawInitialize: false, cwd, send };
    const rl = readline.createInterface({ input: proc.stdout! });
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
 * 异步刷新目录（buildFields 内联点火 / 启动预热调用）。成功与否都写缓存
 * （negative cache 让失败的探针在 TTL 内不再反复 spawn）。返回本次结果。
 * timeoutMs 是测试 seam，生产调用不传。
 */
export async function refreshCodebuddyCatalog(
  binary = 'codebuddy',
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<CodebuddyCatalog | null> {
  const result = await probeOnce(binary, os.tmpdir(), timeoutMs);
  catalogCache = { result, timestamp: Date.now() };
  if (!result) {
    getLogger().warn(
      '[codebuddy-catalog] probe unavailable, config card falls back to static lists',
    );
  }
  return result;
}

/** 后台预热（fire-and-forget；失败落 negative cache，卡片路径优雅回退）。 */
export function warmCodebuddyCatalogCache(binary = 'codebuddy'): void {
  void refreshCodebuddyCatalog(binary).catch(() => {});
}
