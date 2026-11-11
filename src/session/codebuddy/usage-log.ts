/**
 * CodeBuddy 逐请求用量读取：`<configDir>/logs/<YYYY-MM-DD>/<basename>__<md5(cwd)>.log`。
 *
 * 会话 jsonl 只在每个 turn 的最后一条 assistant 消息上落 usage（`requests: 1`），
 * 中间模型请求没有采样；只读 jsonl 会把多步 turn 系统性低报。CodeBuddy 的
 * `agent.model_call.completed` 日志行按请求记录 input/output/cache，本模块
 * 按 `conversation_id` 过滤、按 `conversation_request_id` 分 turn 汇总：
 *   - turn   = 末个 turn 内所有请求之和（本 run flow）
 *   - cum    = 整个会话所有请求之和（累计）
 *   - latest = 末条请求（context 水位）
 *
 * 日志是 CodeBuddy 的内部诊断格式：文件缺失/被清理、行解析失败、字段漂移
 * 一律返回 undefined，由 reader 回退 jsonl（只有末次请求，口径是下界）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodebuddyConfigDir } from '../../config/codebuddy-config.js';
import { scanJsonlLines } from '../common/jsonl.js';

/** 一条 assistant 请求的 usage 采样（input 已扣缓存，与 reader 口径一致）。 */
export interface CodebuddyUsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export function emptyCodebuddyUsageSample(): CodebuddyUsageSample {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function addCodebuddyUsageSample(
  target: CodebuddyUsageSample,
  sample: CodebuddyUsageSample,
): void {
  target.input += sample.input;
  target.output += sample.output;
  target.cacheRead += sample.cacheRead;
  target.cacheCreation += sample.cacheCreation;
}

/** 逐请求日志汇总结果。 */
export interface CodebuddyLogUsage {
  /** 末个 turn 内所有请求之和（本 run flow）。 */
  turn: CodebuddyUsageSample;
  /** 会话全量。 */
  cum: CodebuddyUsageSample;
  /** 末条请求（context 水位来源）。 */
  latest: CodebuddyUsageSample;
}

/** `agent.model_call.completed` 行里本模块消费的字段。 */
interface CodebuddyCallRow {
  event_name?: unknown;
  conversation_id?: unknown;
  conversation_request_id?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_read_tokens?: unknown;
  cached_write_tokens?: unknown;
}

const CALL_EVENT = '"event_name":"agent.model_call.completed"';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isDateDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

/**
 * CodeBuddy 日志文件名：`<cwd basename>__<md5(cwd)>.log`（真机实测命名）。
 * 同一项目同一天的所有进程 append 到同一个文件。
 */
function codebuddyLogFileName(cwd: string): string {
  const hash = createHash('md5').update(cwd).digest('hex');
  return `${path.basename(cwd)}__${hash}.log`;
}

/** 与 cwd 匹配的日志文件（按日期升序）；目录不存在/无匹配返回 []。 */
function codebuddyLogFiles(cwd: string, configDir?: string): string[] {
  const root = path.join(resolveCodebuddyConfigDir(configDir), 'logs');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const fileName = codebuddyLogFileName(cwd);
  const files: string[] = [];
  for (const entry of entries) {
    if (!isDateDir(entry)) continue;
    const filePath = path.join(root, entry, fileName);
    try {
      if (fs.statSync(filePath).isFile()) files.push(filePath);
    } catch {
      // 该日期没有这个项目的日志：正常情况
    }
  }
  return files.sort();
}

/**
 * 从一行日志解析调用记录。只有完整 JSON 且 `conversation_id` 命中目标
 * session 才返回；半写入行、旧格式、其他 session 的行一律跳过。
 */
function parseCallRow(line: string, sessionId: string): CodebuddyCallRow | undefined {
  if (!line.includes(CALL_EVENT) || !line.includes(sessionId)) return undefined;
  const start = line.indexOf('{"model":');
  if (start < 0) return undefined;
  let row: CodebuddyCallRow;
  try {
    row = JSON.parse(line.slice(start).trim()) as CodebuddyCallRow;
  } catch {
    return undefined;
  }
  if (row.event_name !== 'agent.model_call.completed') return undefined;
  if (row.conversation_id !== sessionId) return undefined;
  if (typeof row.conversation_request_id !== 'string' || !row.conversation_request_id) {
    return undefined;
  }
  return row;
}

/** 日志行 → 采样。input_tokens 含缓存，按非缓存口径扣掉 cached_read_tokens。 */
function sampleFromCallRow(row: CodebuddyCallRow): CodebuddyUsageSample | undefined {
  const inputRaw = num(row.input_tokens);
  const output = num(row.output_tokens);
  const cacheRead = num(row.cached_read_tokens);
  const cacheCreation = num(row.cached_write_tokens);
  if (inputRaw === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
    return undefined;
  }
  return {
    input: Math.max(0, inputRaw - cacheRead),
    output,
    cacheRead,
    cacheCreation,
  };
}

/**
 * 汇总某个会话的逐请求用量。日志跨日期目录读取；全部文件都读不到时返回
 * undefined。`turn` 取日志里最后出现的 `conversation_request_id`（同一会话
 * 的 turn 串行，日志顺序即时间顺序）。
 */
export function readCodebuddyLogUsage(
  sessionId: string,
  cwd: string,
  opts: { configDir?: string } = {},
): CodebuddyLogUsage | undefined {
  const files = codebuddyLogFiles(cwd, opts.configDir);
  if (files.length === 0) return undefined;

  const cum = emptyCodebuddyUsageSample();
  const turns = new Map<string, { sample: CodebuddyUsageSample; order: number }>();
  let latest: CodebuddyUsageSample | undefined;
  let order = 0;
  let found = false;

  for (const file of files) {
    scanJsonlLines(file, (line) => {
      const row = parseCallRow(line.trim(), sessionId);
      if (!row) return;
      const sample = sampleFromCallRow(row);
      if (!sample) return;
      found = true;
      order += 1;
      addCodebuddyUsageSample(cum, sample);
      const turnId = row.conversation_request_id as string;
      const existing = turns.get(turnId);
      if (existing) {
        addCodebuddyUsageSample(existing.sample, sample);
        existing.order = order;
      } else {
        turns.set(turnId, { sample: { ...sample }, order });
      }
      latest = sample;
    });
  }

  if (!found || !latest) return undefined;

  let flow: CodebuddyUsageSample | undefined;
  let flowOrder = -1;
  for (const entry of turns.values()) {
    if (entry.order > flowOrder) {
      flow = entry.sample;
      flowOrder = entry.order;
    }
  }
  if (!flow) return undefined;

  return { turn: flow, cum, latest };
}
