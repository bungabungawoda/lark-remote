/**
 * Qoder config loader
 *
 * Dynamically reads available models from `qodercn --list-models`, provides
 * dynamic dropdown options for /config card. Falls back to an empty list when
 * the command fails — the config card then renders the model as a free-text
 * input instead of a dropdown (官方不承诺该输出的结构，解析宽松：JSON 优先、
 * 逐行兜底，两端都失败才回退）。
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
 * Load Qoder models from `<binary> --list-models` + current model from
 * settings.json. Uses caching to avoid repeated sync calls.
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

  const result: QoderConfigResult = { currentModel, modelOptions };
  qoderConfigCache = { binary, result, timestamp: Date.now() };
  return result;
}
