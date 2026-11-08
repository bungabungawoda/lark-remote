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
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from '../logger/index.js';
import { spawnProcessSync } from '../platform/spawn.js';

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

/** 清空缓存（仅供测试使用，生产代码无调用点）。 */
export function invalidateQoderConfigCache(): void {
  qoderConfigCache = null;
}

/**
 * Cache for loadQoderConfig to avoid repeated sync calls。按 binary 键控：
 * CN 版（qodercn）与国际版（qoder）的 --list-models 输出不同，TTL 内切换
 * binary 不得读到另一家的结果。
 */
let qoderConfigCache: { binary: string; result: QoderConfigResult; timestamp: number } | null =
  null;
const QODER_CONFIG_CACHE_TTL_MS = 60000; // 1 minute TTL

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

/**
 * 从 `<binary> --list-models` 拉取并解析模型清单：spawn + 退出码校验 +
 * parse + 空清单 warn。任何失败（命令缺失/非零退出）一律回退空数组
 * （卡片回退文本输入），不把异常抛给调用方。
 */
function fetchModelOptions(binary: string): string[] {
  try {
    // spawnProcessSync（cross-spawn）而非 execFileSync：win32 垫片解析口径与
    // runner spawn 一致（同 kimi-config 的理由）。
    const res = spawnProcessSync(binary, ['--list-models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const stderr = String(res.stderr ?? '').trim();
      throw new Error(`${binary} exited ${res.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`);
    }
    const modelOptions = parseQoderModelList(String(res.stdout ?? ''));
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
    return [];
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
 * effort）则不进下拉，清单始终与安装的 CLI 对齐。
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
 * 捕获式 spawn：进程起不来/超时抛 res.error，返回退出码与 stdout+stderr 合并
 * 输出（探测判定只看报错文案，不盯退出码 —— 合法值静默 exit 42、非法值
 * exit 1 都是版本细节）。
 */
function spawnCaptured(binary: string, args: string[]): { status: number | null; output: string } {
  // spawnProcessSync（cross-spawn）而非 execFileSync：win32 垫片解析口径与
  // runner spawn 一致（同 kimi-config 的理由）。
  const res = spawnProcessSync(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (res.error) throw res.error;
  return {
    status: res.status,
    output: `${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`,
  };
}

/**
 * 单档位探测：`--reasoning-effort <level> -p ""`。空 prompt 走不到模型调用，
 * 探测零 token 成本；合法值静默退出，非法值在 stderr 报 Invalid + 全表。
 */
function runEffortProbe(binary: string, level: string): { status: number | null; output: string } {
  return spawnCaptured(binary, ['--reasoning-effort', level, '-p', '']);
}

/** 探测单个档位是否被当前 CLI 接受：输出里没有 Invalid reasoning effort 即接受。 */
function probeAcceptsEffort(binary: string, level: string): boolean {
  try {
    return !/invalid reasoning effort/i.test(runEffortProbe(binary, level).output);
  } catch {
    return false;
  }
}

/**
 * 探测推理强度档位：哨兵值触发 CLI 校验报错 → 解析全表；报错漏列的补充档位
 * （off）逐个探测后并入。哨兵探不出全表（CLI 缺失/未登录/未来版本改文案）
 * 一律空数组，卡片回退文本输入 —— 与 --list-models 的回退口径一致。
 */
function fetchEffortOptions(binary: string): string[] {
  try {
    const parsed = parseQoderEffortList(runEffortProbe(binary, QODER_EFFORT_PROBE_SENTINEL).output);
    if (parsed.length === 0) {
      getLogger().warn('[qoder-config] effort probe produced no levels, card falls back to input');
      return [];
    }
    const extra = QODER_EFFORT_SUPPLEMENT.filter(
      (level) => !parsed.includes(level) && probeAcceptsEffort(binary, level),
    );
    return [...parsed, ...extra];
  } catch (err) {
    getLogger().warn(
      `[qoder-config] effort probe failed: ${(err as Error).message}, using empty list`,
    );
    return [];
  }
}

/**
 * Load Qoder models from `<binary> --list-models` + current model from
 * settings.json, effort levels from a validation-error probe. Uses caching to
 * avoid repeated sync calls.
 */
export function loadQoderConfig(binary = 'qodercn', configDir?: string): QoderConfigResult {
  const now = Date.now();
  if (
    qoderConfigCache &&
    qoderConfigCache.binary === binary &&
    now - qoderConfigCache.timestamp < QODER_CONFIG_CACHE_TTL_MS
  ) {
    return qoderConfigCache.result;
  }

  const resolvedDir = resolveQoderConfigDir(configDir);
  const currentModel = readCurrentModel(resolvedDir);
  const modelOptions = fetchModelOptions(binary);
  const effortOptions = fetchEffortOptions(binary);

  const result: QoderConfigResult = { currentModel, modelOptions, effortOptions };
  qoderConfigCache = { binary, result, timestamp: Date.now() };
  return result;
}
