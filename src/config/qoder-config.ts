/**
 * Qoder config loader
 *
 * Dynamically reads available models from `qodercn --list-models`, provides
 * dynamic dropdown options for /config card. Falls back to an empty list when
 * the command fails — the config card then renders the model as a free-text
 * input instead of a dropdown (官方不承诺该输出的结构，解析宽松：JSON 优先、
 * 逐行兜底，两端都失败才回退）。
 *
 * 推理强度档位同样动态探测：CLI 的 `--help` 不列 choices，但传非法值会在启动
 * 校验时报出全表（1.1.84 实测：`Valid values are: auto, none, low, medium,
 * high, xhigh, max, ultracode.`），据此解析出与安装版本一致的档位下拉；探测
 * 不成立时该字段同样回退文本输入。
 *
 * 探测全部走**异步 spawn**（`refreshQoderConfig`，卡片构建只同步读缓存）：
 * 单次 `--reasoning-effort off -p ""` 实测 4–6s，同步路径会堵住事件循环，
 * 让卡片回调超过飞书 3 秒上限（客户端提示「目标服务器超时未响应」）。缓存
 * 过期时先用上次成功快照渲染，后台刷新（stale-while-revalidate）；从未探测
 * 成功才回退文本输入。启动预热见 `warmQoderConfigCache`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '../logger/index.js';
import { spawnProcess } from '../platform/spawn.js';

/** Qoder CLI 输出中模型的宽松形态（结构未承诺，字段全部可选）。 */
interface QoderModelEntryLike {
  id?: unknown;
  name?: unknown;
  model?: unknown;
}

export interface QoderConfigResult {
  /** settings.json 里的当前模型（缺省 undefined = 跟随 Qoder 默认）。 */
  currentModel: string | undefined;
  /** --list-models 解析出的模型清单；解析失败为空列表。 */
  modelOptions: string[];
  /** 探测出的推理强度档位；探测不成立为空列表（卡片回退文本输入）。 */
  effortOptions: string[];
}

/** 目录快照（只含探测结果；currentModel 每次实时读 settings.json）。 */
interface QoderCatalogSnapshot {
  modelOptions: string[];
  effortOptions: string[];
}

/** 单次 CLI 调用超时（与旧同步路径的 10s 口径一致）。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 单次 CLI 输出上限（防异常输出打爆内存；量级与旧 spawnSync 的 maxBuffer 一致）。 */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** 目录缓存 TTL。CLI 升级/模型增删在 5 分钟内可见。 */
const CATALOG_CACHE_TTL_MS = 5 * 60_000;

interface QoderCatalogCacheEntry {
  binary: string;
  snapshot: QoderCatalogSnapshot;
  timestamp: number;
}

let catalogCache: QoderCatalogCacheEntry | null = null;
/** 在途刷新（并发点火复用，避免同一时刻 spawn 多份 CLI）。 */
let catalogRefreshInFlight: Promise<QoderConfigResult> | null = null;
/**
 * 补充档位（`off`）的探测结果，按 binary 永久缓存：该探测实测 4–6s，
 * 每 5 分钟重跑一次没有收益。失败不写缓存，下次刷新重试。
 */
const effortSupplementCache = new Map<string, string[]>();

/** 清空缓存（仅供测试使用，生产代码无调用点）。 */
export function invalidateQoderConfigCache(): void {
  catalogCache = null;
  catalogRefreshInFlight = null;
  effortSupplementCache.clear();
}

/**
 * Qoder 配置根目录解析：显式配置优先；缺省时 CN 版（~/.qoder-cn）优先于
 * 国际版（~/.qoder），以目录存在性判定。两个目录都不存在时仍返回 CN 路径
 * （首次安装前的 /config 卡与 /resume 保持可渲染的空态，而不是抛错）。
 */
export function resolveQoderConfigDir(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  const home = os.homedir();
  const cn = path.join(home, '.qoder-cn');
  if (fs.existsSync(cn)) return cn;
  return path.join(home, '.qoder');
}

/** Read model.name from `<configDir>/settings.json`（缺失/损坏 → undefined）。 */
function readCurrentModel(configDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { model?: { name?: unknown } | string };
    if (typeof parsed.model === 'string') return parsed.model || undefined;
    const name = parsed.model?.name;
    return typeof name === 'string' && name ? name : undefined;
  } catch (err) {
    getLogger().warn(`[qoder-config] settings.json unreadable: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * --list-models 输出的宽松解析：JSON（字符串数组 / 对象数组 / {models:[…]}）
 * 优先，失败则按非空行取模型名。两端都拿不到 → 空数组（卡片回退文本输入）。
 */
export function parseQoderModelList(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const data = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { models?: unknown }).models)
        ? ((data as { models: unknown[] }).models as unknown[])
        : null;
    if (list) {
      const names = list
        .map((item) => {
          if (typeof item === 'string') return item;
          const entry = item as QoderModelEntryLike;
          for (const key of ['id', 'name', 'model'] as const) {
            const value = entry[key];
            if (typeof value === 'string' && value) return value;
          }
          return '';
        })
        .filter((name: string) => name.length > 0);
      if (names.length > 0) return dedupe(names);
    }
  } catch {
    // 非 JSON：走逐行兜底
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*->]+/, '').trim())
    .filter(
      (line) =>
        /^[A-Za-z0-9._:/-]+$/.test(line) &&
        // 真机 1.1.72：输出首行是「MODEL」表头，后续行才是模型展示名。
        !/^(model|usage|options|examples?):?$/i.test(line),
    );
  return dedupe(lines);
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

interface CapturedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 异步 spawn + 捕获输出（一次性 CLI 探测）。超时/起不来 → reject，调用方
 * 统一回退空清单。走 `platform/spawn.ts` 统一收口（win32 垫片解析口径）。
 */
function runCaptured(binary: string, args: string[]): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error(`${binary} timed out after ${PROBE_TIMEOUT_MS}ms`));
      });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_OUTPUT_BYTES) {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`${binary} stdout exceeded ${MAX_OUTPUT_BYTES} bytes`));
        });
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > MAX_OUTPUT_BYTES) {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`${binary} stderr exceeded ${MAX_OUTPUT_BYTES} bytes`));
        });
      }
    });
    child.on('error', (err: Error) => settle(() => reject(err)));
    child.on('close', (status: number | null) => settle(() => resolve({ status, stdout, stderr })));
  });
}

/**
 * 从 `<binary> --list-models` 拉取并解析模型清单：spawn + 退出码校验 +
 * parse + 空清单 warn。任何失败（命令缺失/非零退出/超时）→ undefined，
 * 由调用方保留上次成功快照（从未成功则卡片回退文本输入）。
 */
async function fetchModelOptions(binary: string): Promise<string[] | undefined> {
  try {
    const res = await runCaptured(binary, ['--list-models']);
    if (res.status !== 0) {
      const stderr = res.stderr.trim();
      throw new Error(`${binary} exited ${res.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`);
    }
    const modelOptions = parseQoderModelList(res.stdout);
    if (modelOptions.length === 0) {
      getLogger().warn(
        '[qoder-config] --list-models produced no model names, card falls back to input',
      );
    }
    return modelOptions;
  } catch (err) {
    getLogger().warn(
      `[qoder-config] failed to load models: ${(err as Error).message}, using empty list`,
    );
    return undefined;
  }
}

/**
 * 探测用哨兵档位：任何版本都不会把它当合法值。若未来真被接受（无报错输出），
 * 解析为空清单 → 卡片回退文本输入，不会给出错误下拉。
 */
const QODER_EFFORT_PROBE_SENTINEL = '__lark_remote_effort_probe__';

/**
 * 校验报错漏列、但 CLI 实际接受的档位（TUI /effort 有 off，报错全表没有，
 * 传 off 实测静默通过）。逐个探测后才并入：被拒（报 Invalid reasoning
 * effort）则不进下拉，清单始终与安装的 CLI 对齐。探测结果按 binary 永久缓存
 * ——单次实测 4–6s，重复探测没有收益。
 */
const QODER_EFFORT_SUPPLEMENT = ['off'] as const;

/**
 * 从 CLI 校验报错里解析合法档位（1.1.84 实测形态）：
 * `Invalid reasoning effort: x. Valid values are: auto, none, low, medium, high, xhigh, max, ultracode.`
 * 只认这行冒号后的逗号分隔词（去尾部句点），其余 token 丢弃 —— 宽松口径与
 * parseQoderModelList 一致，文案变了就解析为空、回退文本输入。
 */
export function parseQoderEffortList(output: string): string[] {
  const match = output.match(/valid values are:\s*([^\r\n]+)/i);
  if (!match) return [];
  const levels = match[1]
    .split(',')
    .map((part) => part.trim().replace(/\.$/, ''))
    .filter((part) => /^[a-z][a-z0-9_-]*$/i.test(part));
  return [...new Set(levels)];
}

/**
 * 单档位探测：`--reasoning-effort <level> -p ""`。空 prompt 走不到模型调用，
 * 探测零 token 成本；合法值静默退出，非法值在 stderr 报 Invalid + 全表。
 */
async function probeAcceptsEffort(binary: string, level: string): Promise<boolean> {
  try {
    const res = await runCaptured(binary, ['--reasoning-effort', level, '-p', '']);
    return !/invalid reasoning effort/i.test(`${res.stdout}\n${res.stderr}`);
  } catch {
    return false;
  }
}

/**
 * 探测推理强度档位：哨兵值触发 CLI 校验报错 → 解析全表；报错漏列的补充档位
 * （off）按 binary 只探测一次后并入。哨兵探不出全表（CLI 缺失/未登录/未来
 * 版本改文案）→ undefined，由调用方保留上次成功快照（从未成功则回退文本
 * 输入）—— 与 --list-models 的回退口径一致。
 */
async function fetchEffortOptions(binary: string): Promise<string[] | undefined> {
  try {
    const probe = await runCaptured(binary, [
      '--reasoning-effort',
      QODER_EFFORT_PROBE_SENTINEL,
      '-p',
      '',
    ]);
    const parsed = parseQoderEffortList(`${probe.stdout}\n${probe.stderr}`);
    if (parsed.length === 0) {
      getLogger().warn('[qoder-config] effort probe produced no levels, card falls back to input');
      return undefined;
    }
    let supplements = effortSupplementCache.get(binary);
    if (supplements === undefined) {
      supplements = [];
      for (const level of QODER_EFFORT_SUPPLEMENT) {
        if (!parsed.includes(level) && (await probeAcceptsEffort(binary, level))) {
          supplements.push(level);
        }
      }
      effortSupplementCache.set(binary, supplements);
    }
    return [...parsed, ...supplements.filter((level) => !parsed.includes(level))];
  } catch (err) {
    getLogger().warn(
      `[qoder-config] effort probe failed: ${(err as Error).message}, using empty list`,
    );
    return undefined;
  }
}

/**
 * 同步读缓存（config 卡 buildFields 用，绝不 spawn）。从未成功探测 → 空清单
 * （卡片回退文本输入）；缓存过期仍返回上次成功快照，刷新由同一帧点火的
 * `refreshQoderConfig` 在后台完成（stale-while-revalidate）。
 */
export function loadQoderConfig(binary = 'qodercn', configDir?: string): QoderConfigResult {
  const snapshot = catalogCache?.binary === binary ? catalogCache.snapshot : undefined;
  return {
    currentModel: readCurrentModel(resolveQoderConfigDir(configDir)),
    modelOptions: snapshot?.modelOptions ?? [],
    effortOptions: snapshot?.effortOptions ?? [],
  };
}

/**
 * 异步刷新目录（buildFields 内联点火 / 启动预热调用）。TTL 内直接吃缓存；
 * 并发点火复用同一个 in-flight 刷新。探测失败保留上次成功快照（从未成功
 * 则空清单），并照常写时间戳（negative cache 让失败不再每个渲染都重试）。
 */
export function refreshQoderConfig(
  binary = 'qodercn',
  configDir?: string,
): Promise<QoderConfigResult> {
  const cached = catalogCache;
  if (cached && cached.binary === binary && Date.now() - cached.timestamp < CATALOG_CACHE_TTL_MS) {
    return Promise.resolve({
      currentModel: readCurrentModel(resolveQoderConfigDir(configDir)),
      ...cached.snapshot,
    });
  }
  if (catalogRefreshInFlight) return catalogRefreshInFlight;

  const previous = cached?.binary === binary ? cached.snapshot : undefined;
  catalogRefreshInFlight = (async (): Promise<QoderConfigResult> => {
    const [modelOptions, effortOptions] = await Promise.all([
      fetchModelOptions(binary),
      fetchEffortOptions(binary),
    ]);
    const snapshot: QoderCatalogSnapshot = {
      modelOptions: modelOptions ?? previous?.modelOptions ?? [],
      effortOptions: effortOptions ?? previous?.effortOptions ?? [],
    };
    catalogCache = { binary, snapshot, timestamp: Date.now() };
    return { currentModel: readCurrentModel(resolveQoderConfigDir(configDir)), ...snapshot };
  })()
    .catch((err) => {
      // fetch* 已内部兜底；这里只兜「Promise.all 之外」的意外，保持调用方零异常。
      getLogger().warn(`[qoder-config] refresh failed: ${(err as Error).message}`);
      const snapshot = previous ?? { modelOptions: [], effortOptions: [] };
      catalogCache = { binary, snapshot, timestamp: Date.now() };
      return { currentModel: readCurrentModel(resolveQoderConfigDir(configDir)), ...snapshot };
    })
    .finally(() => {
      catalogRefreshInFlight = null;
    });
  return catalogRefreshInFlight;
}

/**
 * 启动/后台预热（fire-and-forget）：让首次打开 /config 卡时缓存已温，
 * 不必等一次后台刷新才从文本输入升级为下拉。
 */
export function warmQoderConfigCache(binary = 'qodercn'): void {
  void refreshQoderConfig(binary).catch(() => {});
}
