/**
 * CodeBuddy 模型事实源。
 *
 * ACP `session/new` 的 availableModels 是 CLI 内置静态清单——`codebuddy --help`
 * 的 `--model` 可选项与它逐项相同，既不按账号权益过滤，也不区分区域（实测
 * internal / external 返回同一份，其中多数模型当前账号用不了）。拿它当
 * 「模型是否可用」的判据会放行账号无权的 id，上游只回一句 400
 * `model [X] service info not found`，卡片侧只剩泛化的 Internal error。
 *
 * 模型口径因此改用两条可验证信号：
 * 1. 账号可用清单：上游 400 的错误文本会附
 *    `Currently supported models for your account:`，这是唯一的权威清单；
 * 2. 上次成功使用的模型：turn 成功即记账，清单缺失时作为已知可用值。
 *
 * 学习结果落 `<configDir>/codebuddy-model-state.json`，跨重启复用。两条信号
 * 都没有时不猜——保持配置原值（用户显式选择优先）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import { getLogger } from '../logger/index.js';

interface CodebuddyModelState {
  /** 账号真实可用模型 id（来自上游 400 的错误文本）。 */
  supported: string[];
  /** 上次成功完成 turn 的模型 id。 */
  lastSuccess?: string;
  /** 最近一次学习时间（epoch ms）。 */
  updatedAt?: number;
}

const EMPTY_STATE: CodebuddyModelState = { supported: [] };

/** 会话 jsonl 尾部扫描窗口：错误行总在文件末尾，读全量没必要。 */
const SESSION_TAIL_BYTES = 256 * 1024;

/** 无历史偏好时的回落顺序（账号清单里挑一个能用的对话模型）。 */
const PREFERRED_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro'];

/** 别名型 id：能用但语义含糊，只在没有具体模型可选时才取。 */
const ALIAS_MODELS = new Set(['default-model', 'max-model']);

let statePath: string | null = null;
let cached: CodebuddyModelState | null = null;

/**
 * 绑定状态文件路径（启动时由入口按配置目录注入）。路径变化即丢缓存，
 * 便于测试与多实例共用同一进程。
 */
export function configureCodebuddyModelState(filePath: string): void {
  if (filePath === statePath) return;
  statePath = filePath;
  cached = null;
}

/** 测试/多实例复位用：清掉内存缓存与路径绑定。 */
export function _resetCodebuddyModelStateForTest(): void {
  statePath = null;
  cached = null;
}

function isModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function uniqueModels(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 读状态文件；缺失/损坏/未绑定路径时返回空状态（不抛）。 */
export function loadCodebuddyModelState(): CodebuddyModelState {
  if (cached) return cached;
  if (!statePath) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<CodebuddyModelState>;
    cached = {
      supported: Array.isArray(parsed.supported) ? uniqueModels(parsed.supported) : [],
      lastSuccess: isModelId(parsed.lastSuccess) ? parsed.lastSuccess : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
    };
  } catch {
    cached = EMPTY_STATE;
  }
  return cached;
}

function persist(next: CodebuddyModelState): void {
  cached = next;
  if (!statePath) return;
  try {
    atomicWriteJson(statePath, next);
  } catch (err) {
    getLogger().warn(`[codebuddy-model] persist failed: ${(err as Error).message}`);
  }
}

/** 记一次成功：下次配置失效时优先回落到它。 */
export function recordCodebuddyModelSuccess(model: string | undefined): void {
  if (!isModelId(model)) return;
  const state = loadCodebuddyModelState();
  if (state.lastSuccess === model) return;
  persist({ ...state, lastSuccess: model, updatedAt: Date.now() });
}

/**
 * 记一次上游拒绝：写入账号可用清单，并把已失效的 lastSuccess 清掉。
 * 清单为空（错误文本没带列表）时不动状态，避免用不完整信息覆盖已知清单。
 */
export function recordCodebuddyModelRejection(input: {
  model?: string;
  supported: readonly string[];
}): CodebuddyModelState | null {
  const supported = uniqueModels(input.supported);
  if (supported.length === 0) return null;
  const state = loadCodebuddyModelState();
  const lastSuccess =
    state.lastSuccess && supported.includes(state.lastSuccess) ? state.lastSuccess : undefined;
  const next: CodebuddyModelState = { supported, lastSuccess, updatedAt: Date.now() };
  persist(next);
  return next;
}

/**
 * 从错误文本解析账号可用清单：`Currently supported models for your account:`
 * 之后连续的 `- <id>` 行。取最后一次出现的块（长会话里可能有多条历史错误）。
 */
export function parseSupportedModels(text: string | undefined): string[] {
  if (!text) return [];
  const header = /Currently supported models for your account:/gi;
  let lastIndex = -1;
  for (let m = header.exec(text); m; m = header.exec(text)) lastIndex = m.index;
  if (lastIndex < 0) return [];

  const lines = text.slice(lastIndex).split('\n').slice(1);
  const ids: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (ids.length > 0) break;
      continue;
    }
    const bullet = /^[-*]\s*(\S+)$/.exec(line);
    if (!bullet) {
      if (ids.length > 0) break;
      continue;
    }
    ids.push(bullet[1]);
  }
  return uniqueModels(ids);
}

/** 从错误文本解析被上游拒绝的模型 id。 */
export function parseRejectedModel(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /model\s*\[([^\]\s]+)\]\s*service info not found/i.exec(text);
  return m?.[1];
}

interface PickCodebuddyModelInput {
  /** 配置里的 model（用户显式选择）。 */
  configured?: string;
  /** 已学到的账号可用清单；空 = 还没有权威信号。 */
  supported?: readonly string[];
  /** 上次成功使用的模型。 */
  lastSuccess?: string;
  /** 交互式登录写下的账号当前模型（`settings.json`）。 */
  accountModel?: string;
}

/**
 * 模型口径（纯函数）。清单未知时原样返回 configured——没有证据就不改写
 * 用户选择；清单已知时按「配置 → 上次成功 → 账号当前 → 偏好顺序」挑一个
 * 清单内的 id，避免继续下发账号无权的模型。
 */
export function pickCodebuddyModel(input: PickCodebuddyModelInput): string | undefined {
  const supported = uniqueModels(input.supported ?? []);
  if (supported.length === 0) return input.configured;

  const { configured, lastSuccess, accountModel } = input;
  if (configured && supported.includes(configured)) return configured;
  if (lastSuccess && supported.includes(lastSuccess)) return lastSuccess;
  if (accountModel && supported.includes(accountModel)) return accountModel;
  for (const id of PREFERRED_MODELS) {
    if (supported.includes(id)) return id;
  }
  const concrete = supported.find((id) => !ALIAS_MODELS.has(id));
  return concrete ?? supported[0];
}

/** 交互式登录写下的账号当前模型；只读这一个非敏感字段。 */
export function readCodebuddyAccountModel(codebuddyHome?: string): string | undefined {
  const home = codebuddyHome ?? path.join(os.homedir(), '.codebuddy');
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf-8')) as {
      model?: unknown;
    };
    return isModelId(parsed.model) ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function readFileTail(filePath: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf-8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响结果
      }
    }
  }
}

/** 一行 jsonl 里所有可读文本（assistant content、裸 text、provider 错误）。 */
function rowTexts(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value) out.push(value);
  };
  const content = row.content;
  if (Array.isArray(content)) {
    for (const part of content) push((part as { text?: unknown })?.text);
  }
  push(row.text);
  const providerError = (row.providerData as { error?: Record<string, unknown> } | undefined)
    ?.error;
  if (providerError) {
    push(providerError.message);
    const data = providerError.data as Record<string, unknown> | undefined;
    if (data) push(data.message);
  }
  return out;
}

/**
 * 从会话 jsonl 尾部读取本次失败的真实原因（ACP 只回泛化的 Internal error，
 * 400 全文只落在会话文件里）。返回解析出的被拒模型与账号可用清单；
 * 没匹配到模型类错误返回 null。
 */
export function readCodebuddyModelError(sessionFile: string): {
  model?: string;
  supported: string[];
} | null {
  const tail = readFileTail(sessionFile, SESSION_TAIL_BYTES);
  if (!tail) return null;

  // 尾部第一行可能是被截断的半行，解析失败跳过即可。
  let matched: string | undefined;
  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const text of rowTexts(row)) {
      if (/service info not found|Currently supported models/i.test(text)) matched = text;
    }
  }
  if (!matched) return null;

  const supported = parseSupportedModels(matched);
  const model = parseRejectedModel(matched);
  if (!model && supported.length === 0) return null;
  return { model, supported };
}

/** runner / 卡片共用的模型口径：已学到的账号清单优先，没有信号时保持配置值。 */
export function resolveCodebuddyModel(configured: string | undefined): string | undefined {
  const state = loadCodebuddyModelState();
  return pickCodebuddyModel({
    configured,
    supported: state.supported,
    lastSuccess: state.lastSuccess,
    accountModel: readCodebuddyAccountModel(),
  });
}
