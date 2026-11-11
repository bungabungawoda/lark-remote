import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonlLines as readJsonlLinesShared, readLastNJsonlLines } from '../common/jsonl.js';
import { cumulativeUsageFields } from '../common/usage-accumulator.js';
import { throwSessionListError } from '../common/throw-session-list-error.js';
import { getLogger } from '../../logger/index.js';
import { logNonEnoentDebug } from '../session-store.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
} from '../../session-contract.js';

import { isStale } from '../common/constants.js';
import { safeRealpath, samePath } from '../../platform/path.js';
import { capEvents, paginate } from '../common/pagination.js';
import { newestOf, sortByRecencyDesc } from '../common/recency.js';
import { TtlCache } from '../../common/ttl-cache.js';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';
import { truncateToolInput } from '../common/content-blocks.js';

/** Default Kimi config directory */
function defaultKimiDir(): string {
  return path.join(os.homedir(), '.kimi-code');
}

// --- Kimi session index entry ---
interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

// --- Kimi session state ---
export interface KimiSessionState {
  version?: number; // schema version: undefined = v1, 2 = v2 (kimi-code renamed workDir→cwd)
  createdAt: string | number; // v1: string (ISO), v2: number (epoch ms)
  updatedAt: string | number; // v1: string (ISO), v2: number (epoch ms)
  title?: string; // v2 omits this when no custom title set
  isCustomTitle?: boolean; // v2 may omit
  workDir?: string; // schema v1 (absent in v2)
  cwd?: string; // schema v2 (absent in v1)
  lastPrompt?: string; // v2 omits this
}

// --- Kimi wire.jsonl event types ---
interface KimiContextAppendLoopEvent {
  type: 'context.append_loop_event';
  event: {
    type: 'step.begin' | 'step.end' | 'content.part' | 'tool.call' | 'tool.result';
    step?: number;
    part?: {
      type: 'think' | 'text';
      text?: string;
    };
    // tool.call fields (verified against real ~/.kimi-code wire.jsonl)
    name?: string;
    args?: Record<string, unknown>;
    toolCallId?: string;
    // tool.result field: { output }, { output, note }, or { isError, output }
    result?: {
      output?: string;
      isError?: boolean;
      note?: string;
    };
    usage?: {
      inputOther: number;
      output: number;
      inputCacheRead: number;
      inputCacheCreation: number;
    };
  };
  time: number;
}

interface KimiUsageRecordEvent {
  type: 'usage.record';
  model: string;
  // Fields are optional: kimi's protocol evolves (usageScope etc. were added
  // later), so old/truncated wire.jsonl records may lack fields or even the
  // whole usage object. Aggregation treats missing fields as 0.
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  time: number;
}

interface KimiTurnPromptEvent {
  type: 'turn.prompt';
  input: Array<{ type: 'text'; text: string }>;
  origin: { kind: string };
  time: number;
}

/**
 * Compaction completion record in wire.jsonl (§6.3 / kimi-code wire-manifest).
 *
 * REAL shape（真实 wire.jsonl + kimi-code 源码）：
 * - `context.apply_compaction`：带 `compactedCount` / `tokensBefore` /
 *   `tokensAfter`（以及 summary 等）；
 * - `full_compaction.complete`：只有 `{type, time}`。
 * `messagesCompacted` 是死字段，真实 record 里不存在——禁止再写。
 */
interface KimiCompactionRecord {
  type:
    | 'full_compaction.begin'
    | 'full_compaction.complete'
    | 'full_compaction.cancel'
    | 'context.apply_compaction';
  /** 压缩来源（仅 full_compaction.begin 携带）：'manual' | 'auto'。 */
  source?: string;
  /** 压缩掉的消息条数（仅 context.apply_compaction 携带）。 */
  compactedCount?: number;
  /** 压缩前上下文 token 水位（仅 context.apply_compaction 携带）。 */
  tokensBefore?: number;
  /** 压缩后上下文 token 水位（仅 context.apply_compaction 携带）。 */
  tokensAfter?: number;
  time: number;
}

type KimiJsonlEntry =
  | KimiContextAppendLoopEvent
  | KimiUsageRecordEvent
  | KimiTurnPromptEvent
  | KimiCompactionRecord
  | { type: string; [key: string]: unknown };

/** union 含 catch-all 成员，普通 `===` 判窄不生效，用显式守卫收窄（替代 as unknown as）。 */
function isAppendLoopEvent(entry: KimiJsonlEntry): entry is KimiContextAppendLoopEvent {
  return entry.type === 'context.append_loop_event';
}

function isUsageRecord(entry: KimiJsonlEntry): entry is KimiUsageRecordEvent {
  return entry.type === 'usage.record';
}

function isTurnPrompt(entry: KimiJsonlEntry): entry is KimiTurnPromptEvent {
  return entry.type === 'turn.prompt';
}

function isCompactionComplete(entry: KimiJsonlEntry): entry is KimiCompactionRecord {
  return entry.type === 'full_compaction.complete' || entry.type === 'context.apply_compaction';
}

/** full_compaction.begin：压缩开始（手动 /compact 或自动触发都写）。 */
function isCompactionBegin(entry: KimiJsonlEntry): entry is KimiCompactionRecord {
  return entry.type === 'full_compaction.begin';
}

/** 压缩终态：完成（complete/apply）或失败/取消（cancel）共用 cancel 记录。 */
function isCompactionTerminal(entry: KimiJsonlEntry): entry is KimiCompactionRecord {
  return (
    entry.type === 'full_compaction.complete' ||
    entry.type === 'context.apply_compaction' ||
    entry.type === 'full_compaction.cancel'
  );
}

/** 单行 wire 记录 → 压缩记录（只保留契约字段）；非压缩行返回 undefined。 */
function parseCompactionLine(line: string): KimiCompactionRecord | undefined {
  let entry: KimiJsonlEntry;
  try {
    entry = JSON.parse(line) as KimiJsonlEntry;
  } catch {
    return undefined;
  }
  if (!isCompactionBegin(entry) && !isCompactionTerminal(entry)) return undefined;
  return {
    type: entry.type,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(entry.compactedCount !== undefined ? { compactedCount: entry.compactedCount } : {}),
    ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
    ...(entry.tokensAfter !== undefined ? { tokensAfter: entry.tokensAfter } : {}),
    time: entry.time,
  };
}

/** runCompact 轮询用的增量压缩记录追踪器（见 createCompactionRecordTracker）。 */
interface KimiCompactionRecordTracker {
  /** 首调返回全量历史，之后返回「历史 + 增量」的累积列表（同一数组引用）。 */
  records(): KimiCompactionRecord[];
}

/**
 * 从 `startOffset` 字节起流式读 wire.jsonl，把新增的压缩记录追加进 `sink`，
 * 返回下次读取的字节偏移。只消费**完整行**（以 `\n` 结尾）；无换行符的尾部
 * 字节不计入偏移，留待下次读到完整后再解析——部分写入的行不会被丢弃。
 * 逐行解析失败跳过（与全量扫描口径一致）；open 失败返回原 offset。
 */
function appendCompactionRecordsFrom(
  wirePath: string,
  startOffset: number,
  sink: KimiCompactionRecord[],
): number {
  let fd: number;
  try {
    fd = fs.openSync(wirePath, 'r');
  } catch {
    return startOffset;
  }
  const CHUNK_SIZE = 65536;
  const chunk = Buffer.alloc(CHUNK_SIZE);
  let buf = Buffer.alloc(0);
  let position = startOffset;
  let consumed = 0;
  try {
    for (;;) {
      const nread = fs.readSync(fd, chunk, 0, CHUNK_SIZE, position);
      if (nread === 0) break;
      buf = Buffer.concat([buf, chunk.subarray(0, nread)]);
      position += nread;
      const nl = buf.lastIndexOf(0x0a);
      if (nl === -1) continue;
      const complete = buf.subarray(0, nl);
      consumed += nl + 1;
      buf = buf.subarray(nl + 1);
      for (const line of complete.toString('utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = parseCompactionLine(trimmed);
        if (record) sink.push(record);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return startOffset + consumed;
}

/**
 * Max lines scanned backwards when looking for the last loop event.
 * Bounds the tail scan so huge wire files are not fully parsed.
 */
const LOOP_EVENT_SCAN_LIMIT = 20;

/**
 * Determine whether the last context.append_loop_event in a wire.jsonl is a
 * step.end (turn completed). kimi writes usage.record AFTER step.end at turn
 * completion, so judging by the raw last line never sees the step.end — scan
 * backwards from the tail, skipping non-loop entries (usage.record etc.),
 * until the last loop event is found. Returns false when no loop event is
 * found within the scan window (conservative: caller keeps the session
 * considered active).
 */
function lastLoopEventIsStepEnd(lines: readonly string[]): boolean {
  for (
    let i = lines.length - 1, scanned = 0;
    i >= 0 && scanned < LOOP_EVENT_SCAN_LIMIT;
    i--, scanned++
  ) {
    try {
      const entry = JSON.parse(lines[i]) as KimiJsonlEntry;
      if (!isAppendLoopEvent(entry)) continue;
      return entry.event.type === 'step.end';
    } catch {
      // Skip malformed lines and keep scanning backwards
      continue;
    }
  }
  return false;
}

/** Cache for JSONL file contents to avoid repeated full reads */
const jsonlCache = new TtlCache<string, { mtime: number; lines: string[] }>(5_000, 32);

/**
 * Read lines from a JSONL file with caching.
 * Delegates to the shared readJsonlLines for the actual file read,
 * but wraps it with a TTL-based mtime cache to avoid redundant I/O.
 */
function readJsonlLines(filePath: string): Iterable<string> {
  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    // TTL 由 TtlCache 按缓存写入时间判定（不是文件 mtime），命中即 LRU 刷新；
    // mtime 变化视为失效（文件被改写后不得返回旧行）。
    const cached = jsonlCache.get(filePath);
    if (cached && mtime === cached.mtime) {
      return cached.lines;
    }

    const lines = readJsonlLinesShared(filePath);

    jsonlCache.set(filePath, { mtime, lines });

    return lines;
  } catch (err) {
    // ENOENT = 会话文件在扫描间隙被清理（正常）；其余 errno 留痕，否则该会话
    // 静默从 /resume 消失。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().warn(
        `[kimi-session-reader] cannot read ${filePath}: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    return [];
  }
}

/** Detect schema version from state.json content */
export function detectSchemaVersion(state: KimiSessionState): 1 | 2 {
  if (state.version === 2) return 2;
  // Heuristic: v2 has `cwd` field and no `workDir`
  if (state.cwd !== undefined && state.workDir === undefined) return 2;
  return 1;
}

/**
 * Extract the working directory from state.json, version-aware.
 * v1 uses `workDir`, v2 uses `cwd`. Returns undefined when neither field is present.
 */
export function extractWorkDir(state: KimiSessionState): string | undefined {
  const version = detectSchemaVersion(state);
  if (version === 2) return state.cwd;
  return state.workDir;
}

/** Cwd guard result: verified / failed / unverifiable */
type CwdGuardResult = 'verified' | 'failed' | 'unverifiable';

/**
 * Three-state cwd guard. Distinguishes:
 * - verified: session's workDir matches realCwd
 * - failed: session has a workDir but it doesn't match realCwd
 * - unverifiable: session has no workDir field (cannot verify)
 *
 * Unverifiable sessions are handled by the caller: when no cwd source can
 * verify the session, it is rejected (fail-closed), aligned with claude's
 * cwd guard semantics.
 */
export function checkCwdGuard(state: KimiSessionState, realCwd: string): CwdGuardResult {
  const sessionWorkDir = extractWorkDir(state);
  if (sessionWorkDir === undefined) return 'unverifiable';
  if (samePath(sessionWorkDir, realCwd)) return 'verified';
  return 'failed';
}

// --- readSessionContent 装配函数（纯函数 / 只读：产生结果、依赖入参、不改外部状态） ---

/** 逐字段 token 累计（usage.record 的四个分量；缺字段按 0 计）。 */
interface KimiUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function emptyKimiTotals(): KimiUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** kimi 主 wire usage 扫描累积器结果（纯数据）。 */
interface KimiWireUsageScan {
  /** 会话累计：主 wire 全部 usage.record 逐字段求和（子 agent 由调用方并入）。 */
  totals: KimiUsageTotals;
  /**
   * 末个 turn（最后一个 turn.prompt 之后）的主 wire 记录之和（本 run flow）；
   * 整份 wire 无 turn.prompt（旧数据/截断）= undefined，由装配段回退全会话。
   */
  turn: KimiUsageTotals | undefined;
  /** 主 wire 末条 usage.record 的上下文水位（§9.21；子 agent 独立窗口不进）。 */
  mainContextLength: number;
  /** §6.3 展示计数：只数 context.apply_compaction（一次手动 /compact 只写一条）。 */
  compactCount: number;
  /** 最近一次压缩的 tokensBefore 水位。 */
  compactPreContextLength: number | undefined;
  /** 主 wire 出现过 usage.record（畸形 record 也算有数据，全零照实返回）。 */
  hasUsageRecord: boolean;
}

/**
 * kimi 主 wire usage 扫描累积器（纯函数）：单遍解析，产出会话累计、末 turn
 * flow、上下文水位与压缩统计。
 *
 * 产生：KimiWireUsageScan。依赖：入参 lines（已解析前的原始行）。不改任何
 * 外部状态；畸形行跳过，畸形 usage.record 按字段 0 计但记为「有数据」。
 */
export function scanKimiUsage(lines: readonly string[]): KimiWireUsageScan {
  const totals = emptyKimiTotals();
  let turn: KimiUsageTotals | undefined;
  // contextLength is only from the main wire's last usage.record
  // (subagent context is an independent window).
  let mainContextLength = 0;
  // §6.3: Compaction stats — count compact events, track last pre-compact context.
  let compactCount = 0;
  let compactPreContextLength: number | undefined;
  // Distinguish "no usage.record in any wire file" (no data → usage:
  // undefined, downstream omits the token block) from "records exist but
  // are all zero / malformed" (real data → aggregate with ?? 0 and return
  // the zeros as-is). A malformed record (usage.record line with missing
  // usage object/fields) still counts as data.
  let hasUsageRecord = false;

  for (const line of lines) {
    let entry: KimiJsonlEntry;
    try {
      entry = JSON.parse(line) as KimiJsonlEntry;
    } catch {
      continue;
    }

    if (isUsageRecord(entry)) {
      hasUsageRecord = true;
      // Malformed records (missing usage object or missing fields) must
      // not poison the accumulators with NaN: count missing fields as 0.
      const inputOther = entry.usage?.inputOther ?? 0;
      const output = entry.usage?.output ?? 0;
      const inputCacheRead = entry.usage?.inputCacheRead ?? 0;
      const inputCacheCreation = entry.usage?.inputCacheCreation ?? 0;
      totals.input += inputOther;
      totals.output += output;
      totals.cacheRead += inputCacheRead;
      totals.cacheCreation += inputCacheCreation;
      if (turn) {
        turn.input += inputOther;
        turn.output += output;
        turn.cacheRead += inputCacheRead;
        turn.cacheCreation += inputCacheCreation;
      }
      // unified contract (§9.21): input + output + cacheRead + cacheCreation.
      // 末轮 output 已进入历史、下一 prompt 全量携带——与 compact postTokens
      // 水位同语义（此前漏加 output 会系统性低估长收尾 turn）。
      mainContextLength = inputOther + output + inputCacheRead + inputCacheCreation;
      continue;
    }

    // §6.3: Count compaction events and track pre-compact context length.
    // 展示计数只计 context.apply_compaction：一次手动 /compact 会同时写
    // full_compaction.complete + context.apply_compaction 两条（2026-08-16
    // 实弹 wire.jsonl），双计会把一次压缩虚报成 2 次。full_compaction.complete
    // 仅作 runCompact 轮询的完成信号（readCompactionRecords 仍返回两种）。
    if (isCompactionComplete(entry) && entry.type === 'context.apply_compaction') {
      compactCount++;
      // Capture context length before this compaction as the pre-compact
      // watermark (the most recent one is most relevant for display).
      if (entry.tokensBefore !== undefined) {
        compactPreContextLength = entry.tokensBefore;
      }
      continue;
    }

    // turn.prompt 是 turn 的起点：本 turn 的 flow 从这里重新累计。
    if (isTurnPrompt(entry)) {
      turn = emptyKimiTotals();
      continue;
    }
  }

  return { totals, turn, mainContextLength, compactCount, compactPreContextLength, hasUsageRecord };
}

/** kimi 子 agent wire usage 扫描结果（纯数据）。 */
interface KimiSubagentUsageScan {
  /** 兄弟 wire 的 usage.record 逐字段求和（只进会话累计）。 */
  totals: KimiUsageTotals;
  /** 子 agent wire 出现过 usage.record。 */
  hasUsageRecord: boolean;
}

/**
 * kimi 子 agent wire usage 扫描（只读 I/O）：agents/<name>/wire.jsonl（main
 * 以外的兄弟目录）与主会话同属同一计费实体，token 消耗必须并入会话累计；
 * contextLength/展示事件不取子 agent。目录不可读或文件缺失静默跳过。
 *
 * 产生：KimiSubagentUsageScan。依赖：文件系统（agentsDir 只读）。不改外部状态。
 */
function scanKimiSubagentUsage(agentsDir: string): KimiSubagentUsageScan {
  const totals = emptyKimiTotals();
  let hasUsageRecord = false;
  try {
    for (const dirent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name === 'main') {
        continue;
      }
      const subWirePath = path.join(agentsDir, dirent.name, 'wire.jsonl');
      if (!fs.existsSync(subWirePath)) {
        continue;
      }
      for (const subLine of readJsonlLines(subWirePath)) {
        try {
          const subEntry = JSON.parse(subLine) as KimiJsonlEntry;
          if (isUsageRecord(subEntry)) {
            hasUsageRecord = true;
            totals.input += subEntry.usage?.inputOther ?? 0;
            totals.output += subEntry.usage?.output ?? 0;
            totals.cacheRead += subEntry.usage?.inputCacheRead ?? 0;
            totals.cacheCreation += subEntry.usage?.inputCacheCreation ?? 0;
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    // agents dir unreadable — fall back to main-only usage
  }
  return { totals, hasUsageRecord };
}

/**
 * kimi usage 装配（tail 装配段，纯函数）：末 turn flow + 会话累计（主 wire +
 * 子 agent）+ 主 wire 水位 + 压缩统计 → AgentSessionUsage。
 *
 * 有 turn.prompt 时本 run = 末个 turn 的 flow；末 turn 还没有记录时
 * turn 为全 0。整份 wire 都没有 turn.prompt（旧数据/截断）时无从分段，
 * 沿用「整份文件 = 一个 turn」的旧口径（含子 agent wire）。
 */
function assembleKimiUsage(main: KimiWireUsageScan, sub: KimiSubagentUsageScan): AgentSessionUsage {
  const totals: KimiUsageTotals = {
    input: main.totals.input + sub.totals.input,
    output: main.totals.output + sub.totals.output,
    cacheRead: main.totals.cacheRead + sub.totals.cacheRead,
    cacheCreation: main.totals.cacheCreation + sub.totals.cacheCreation,
  };
  const flow = main.turn ?? totals;
  // Kimi semantics: preserve 0 values (not undefined) for cache fields to match original
  return {
    inputTokens: flow.input,
    outputTokens: flow.output,
    contextLength: main.mainContextLength,
    cacheReadTokens: flow.cacheRead > 0 ? flow.cacheRead : 0,
    cacheCreationTokens: flow.cacheCreation > 0 ? flow.cacheCreation : 0,
    totalTokens: flow.input + flow.output + flow.cacheRead + flow.cacheCreation,
    // Cumulative (session-wide): sums every usage.record across all turns
    // (subagent wires included) — the "累计" line, never the per-run value.
    ...cumulativeUsageFields(totals),
    // §6.3: compaction stats from wire.jsonl
    compactCount: main.compactCount,
    ...(main.compactPreContextLength !== undefined
      ? { compactPreContextLength: main.compactPreContextLength }
      : {}),
  };
}

/** kimi 主 wire 展示扫描结果（纯数据）。 */
interface KimiEventScan {
  /** 展示事件（主 wire 全量；maxEvents 尾切由调用方 capEvents 做）。 */
  events: AgentSessionContentEvent[];
  /** displayTitle：最后一条 turn.prompt 的首段文本（最近的用户输入）。 */
  displayTitle: string | undefined;
}

/**
 * kimi 主 wire 展示装配（纯函数）：turn.prompt 提取 displayTitle，loop event
 * 映射为展示事件。tool.call/tool.result 是**独立的 loop event**（对照真实
 * wire.jsonl 验证过的结构，勿合并/改形）。
 *
 * 产生：KimiEventScan。依赖：入参 lines。不改任何外部状态。
 */
function scanKimiEvents(lines: readonly string[]): KimiEventScan {
  const events: AgentSessionContentEvent[] = [];
  let displayTitle: string | undefined;

  for (const line of lines) {
    let entry: KimiJsonlEntry;
    try {
      entry = JSON.parse(line) as KimiJsonlEntry;
    } catch {
      continue;
    }

    // displayTitle + display events now scan ALL lines (not a
    // line-slice), then `events.slice(-maxEvents)` keeps the LAST N
    // EVENTS. Previously `lines.slice(-maxEvents)` cut raw lines, but
    // usage.record / step.begin / turn.prompt lines produce no display
    // event, so "last 5 lines" could yield only 1~2 visible events —
    // and `slice(-0)` returned the full array. displayTitle takes the
    // last turn.prompt across the whole session (the most recent user
    // prompt), which is the correct catch-up title.
    // Extract display title from turn.prompt
    if (isTurnPrompt(entry)) {
      if (entry.input && entry.input.length > 0) {
        displayTitle = entry.input[0].text;
      }
      continue;
    }

    // Convert loop events to content events
    if (isAppendLoopEvent(entry)) {
      const evt = entry.event;

      if (evt.type === 'content.part' && evt.part) {
        if (evt.part.type === 'think') {
          // Skip thinking blocks for display
          continue;
        } else if (evt.part.type === 'text' && evt.part.text) {
          events.push({
            type: 'text',
            content: evt.part.text,
          });
        }
      } else if (evt.type === 'tool.call' && evt.name) {
        // 复用 content-blocks 的 200 字符截断：大 args（整段文件内容
        // 写入、长 prompt）原文进事件会把 resume 卡顶到 28KB 预算之外
        // （2026-08-08 extreme_fallback 故障的推手之一）。
        const inputStr = truncateToolInput(JSON.stringify(evt.args ?? {}));
        events.push({
          type: 'tool_use',
          content: `${evt.name}(${inputStr})`,
        });
      } else if (evt.type === 'tool.result') {
        // result is { output }, { output, note }, or { isError, output }
        // 对齐 opencode reader 的预折叠：单条 tool_result 上限
        // TOOL_RESULT_MAX_BYTES，病理级输出（如 51KB 文件读取）不会
        // 撑爆 resume 卡，也约束 events[] 内存占用。
        const rawOut = evt.result?.output ?? `[tool result for ${evt.toolCallId}]`;
        events.push({
          type: 'tool_result',
          content: truncateUtf8(rawOut, TOOL_RESULT_MAX_BYTES),
        });
      }
    }
  }

  return { events, displayTitle };
}

/**
 * Kimi Session Reader
 * Reads session history from ~/.kimi-code/
 */
export class KimiSessionReader implements AgentSessionReader {
  private readonly kimiDir: string;

  constructor(kimiDir?: string) {
    this.kimiDir = kimiDir ?? defaultKimiDir();
  }

  /**
   * Scan the session index and return all parsed entries.
   * Returns an empty array when the index file doesn't exist or is unreadable.
   */
  private scanSessionIndex(): KimiSessionIndexEntry[] {
    const indexPath = path.join(this.kimiDir, 'session_index.jsonl');
    if (!fs.existsSync(indexPath)) return [];
    const entries: KimiSessionIndexEntry[] = [];
    for (const line of readJsonlLines(indexPath)) {
      try {
        entries.push(JSON.parse(line) as KimiSessionIndexEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  /**
   * Find a single index entry by sessionId, or undefined if not found.
   */
  private findSessionIndexEntry(sessionId: string): KimiSessionIndexEntry | undefined {
    return this.scanSessionIndex().find((e) => e.sessionId === sessionId);
  }

  /**
   * List all sessions for a given working directory
   */
  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    try {
      // 归一失败（陈旧/无权限 cwd）回退原样输入，让逐条 samePath 比较去决定
      // 空态——一次 realpathSync 抛错不得把整张列表清掉（与 opencode 同口径）。
      const realCwd = safeRealpath(cwd, logKimiRealpathFailure.bind(null, cwd));
      const sessions: AgentSession[] = [];
      for (const entry of this.scanSessionIndex()) {
        const row = collectKimiSession(entry, realCwd);
        if (row) sessions.push(row);
      }

      // Sort by mtime descending; same-mtime ties use a deterministic
      // secondary key so ordering is stable across scans.
      sortByRecencyDesc(sessions, kimiRowMtime, kimiRowId);

      const { items, total } = paginate(sessions, opts ?? {});
      return {
        sessions: items,
        total,
      };
    } catch (error) {
      // ENOENT（cwd 已删除）：陈旧 cwd 保持优雅空态。
      // 其余失败：error 日志 + 上抛，router 显示「列表失败」——静默 [] 会让
      // 用户误以为没有 session，与真空不可区分（与 opencode 同口径）。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { sessions: [], total: 0 };
      }
      throwSessionListError('kimi', error);
    }
  }

  /**
   * Get the newest session for a given working directory
   */
  getNewestSession(cwd: string): AgentSession | null {
    return newestOf(this, cwd);
  }

  /**
   * Read session content (events + usage)
   *
   * 编排：cwd 守卫定位主 wire（resolveSessionWirePath，与 isSessionActive
   * 共用 verifySessionCwd 单源）→ 主 wire 两遍只读扫描（scanKimiEvents 出
   * 展示流 + displayTitle，scanKimiUsage 出累计/flow/水位/压缩统计）→ 子
   * agent wire 只进 usage 累计 → assembleKimiUsage 组装。
   */
  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    const wirePath = this.resolveSessionWirePath(sessionId, cwd);
    if (wirePath === null) {
      return { events: [] };
    }

    try {
      const lines = Array.from(readJsonlLines(wirePath));

      const { events, displayTitle } = scanKimiEvents(lines);
      const mainUsage = scanKimiUsage(lines);

      // Subagent wire files (agents/<name>/wire.jsonl, e.g. Task-derived
      // agent-0..N) belong to the same session and the same billing entity:
      // their token cost must be summed into the session-wide usage.
      // contextLength stays main-only (subagent context is an independent
      // window). Display events/title also stay main-only. Any unreadable
      // directory or missing/corrupt wire file is skipped silently.
      // wirePath = <sessionDir>/agents/main/wire.jsonl → agents dir is two
      // levels up (siblings of main hold subagent wires).
      const agentsDir = path.dirname(path.dirname(wirePath));
      const subUsage = scanKimiSubagentUsage(agentsDir);

      return {
        events: capEvents(events, opts?.maxEvents),
        usage:
          mainUsage.hasUsageRecord || subUsage.hasUsageRecord
            ? assembleKimiUsage(mainUsage, subUsage)
            : undefined,
        displayTitle,
      };
    } catch (error) {
      getLogger().error(`[kimi-session-reader] readSessionContent error: ${error}`);
      return { events: [] };
    }
  }

  /**
   * Read the compaction records (full_compaction.begin / complete / cancel /
   * context.apply_compaction) from a session's wire.jsonl.
   *
   * Same cwd guard as readSessionContent. Used by KimiAcpRunner.runCompact
   * to wait for the background compaction terminal before ending the run, and
   * by readCompactionState to detect an in-flight compaction.
   */
  readCompactionRecords(sessionId: string, cwd: string): KimiCompactionRecord[] {
    const wirePath = this.resolveSessionWirePath(sessionId, cwd);
    if (wirePath === null) {
      return [];
    }
    const records: KimiCompactionRecord[] = [];
    try {
      for (const line of readJsonlLines(wirePath)) {
        const record = parseCompactionLine(line);
        if (record) records.push(record);
      }
    } catch (error) {
      getLogger().error(`[kimi-session-reader] readCompactionRecords error: ${error}`);
      return [];
    }
    return records;
  }

  /**
   * 压缩记录增量追踪器：runCompact 轮询专用。
   *
   * `records()` 首调全量扫描（语义与 readCompactionRecords 一致，覆盖 baseline
   * 捕获与 prompt fire 之间落地的记录），之后每次只从上次消费的字节偏移读增量，
   * 只对新增行 JSON.parse。压缩期间 wire.jsonl 每秒都在追加（mtime 不断变化，
   * readJsonlLines 的 mtime 缓存必然失效），旧路径每秒全量读 + 全量 parse 整个
   * 文件；增量后每秒成本 = O(新增字节)。
   *
   * 文件被截断/重写（size < offset）时自动从头重建，语义不漂移。
   * 返回 null = 会话 wire 定位失败，调用方回退一次性读取。
   */
  createCompactionRecordTracker(
    sessionId: string,
    cwd: string,
  ): KimiCompactionRecordTracker | null {
    const wirePath = this.resolveSessionWirePath(sessionId, cwd);
    if (wirePath === null) {
      return null;
    }
    let offset = 0;
    let primed = false;
    const records: KimiCompactionRecord[] = [];
    return {
      records(): KimiCompactionRecord[] {
        try {
          const size = fs.statSync(wirePath).size;
          if (!primed || size < offset) {
            // 首调全量；文件被截断/重写也从头重建（append-only 之外的形态不猜）。
            records.length = 0;
            offset = 0;
            primed = true;
          }
          offset = appendCompactionRecordsFrom(wirePath, offset, records);
        } catch (error) {
          getLogger().error(`[kimi-session-reader] compaction tracker error: ${error}`);
          // 保留已积累记录；下一轮从原 offset 重试。
        }
        return records;
      },
    };
  }

  /**
   * 由 begin/terminal 记录重建压缩状态机：最后一次 begin 无更新的 terminal
   * 记录 = 在途。崩溃墓碑由 kimi resume
   * 时补写 full_compaction.cancel，天然闭合。
   */
  readCompactionState(
    sessionId: string,
    cwd: string,
  ): {
    inFlight: boolean;
    /** 在途 begin 的 time（epoch ms）。 */
    inFlightSince?: number;
    records: KimiCompactionRecord[];
  } {
    const records = [...this.readCompactionRecords(sessionId, cwd)].sort((a, b) => a.time - b.time);
    let pendingBeginAt: number | undefined;
    for (const record of records) {
      if (isCompactionBegin(record)) {
        pendingBeginAt = record.time;
      } else {
        // 终态（complete/apply/cancel）闭合当前在途压缩。
        pendingBeginAt = undefined;
      }
    }
    return {
      inFlight: pendingBeginAt !== undefined,
      ...(pendingBeginAt !== undefined ? { inFlightSince: pendingBeginAt } : {}),
      records,
    };
  }

  /**
   * 单源：resolveSessionWirePath 与 isSessionActive 共用的 cwd 守卫
   * （realpathSync → state.json workDir/cwd 三态 → index workDir 兜底 →
   * fail-closed）。返回 sessionDir；会话未知或守卫不过返回 null。
   */
  private verifySessionCwd(sessionId: string, cwd: string): { sessionDir: string } | null {
    // Find session directory from index (also retrieve index entry for
    // fallback cwd guard when state.json is missing or unparseable)
    const indexEntry = this.findSessionIndexEntry(sessionId);
    const sessionDir = indexEntry?.sessionDir ?? null;
    if (!sessionDir) {
      return null;
    }

    let realCwd: string;
    try {
      realCwd = fs.realpathSync(cwd);
    } catch {
      getLogger().warn(
        `[kimi-session-reader] fs.realpathSync failed for cwd=${cwd} (session ${sessionId}), returning empty`,
      );
      return null;
    }
    let cwdGuardPassed = false;
    const statePath = path.join(sessionDir, 'state.json');
    try {
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as KimiSessionState;
        const guardResult = checkCwdGuard(state, realCwd);
        if (guardResult === 'failed') {
          return null;
        }
        if (guardResult === 'verified') {
          cwdGuardPassed = true;
        } else {
          getLogger().warn(
            `[kimi-session-reader] state.json has no workDir/cwd field for session ${sessionId}, falling back to index workDir`,
          );
          // Fall through to index-based guard below
        }
      }
    } catch {
      // state.json unparseable — fall through to index-based guard
      getLogger().warn(
        `[kimi-session-reader] state.json parse failed for session ${sessionId}, falling back to index workDir`,
      );
    }

    // Fallback: when state.json is missing, unparseable, or has no workDir/cwd,
    // use the workDir from the session index entry as a secondary guard.
    // This prevents /resume <id> from accessing a session belonging to a
    // different cwd when state.json is unavailable.
    if (!cwdGuardPassed) {
      const indexWorkDir = indexEntry?.workDir;
      if (indexWorkDir && !samePath(indexWorkDir, realCwd)) {
        return null;
      }
      // v2 sessions have empty index workDir (v1-only field) and may lack
      // state.json cwd. When no cwd source can verify the session belongs to
      // the requested cwd, fail-closed to prevent cross-workspace access
      // (aligned with claude's fail-closed cwd guard).
      if (!indexWorkDir) {
        getLogger().warn(
          `[kimi-session-reader] no cwd source (state.json + index) for session ${sessionId}, rejecting (fail-closed)`,
        );
        return null;
      }
    }

    return { sessionDir };
  }

  /**
   * Resolve the main wire.jsonl path for a session after passing the cwd
   * guard (state.json + session index fallback). Returns null when the
   * session is unknown, fails the guard, or has no wire file.
   */
  private resolveSessionWirePath(sessionId: string, cwd: string): string | null {
    const verified = this.verifySessionCwd(sessionId, cwd);
    if (!verified) return null;

    const wirePath = path.join(verified.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(wirePath)) {
      return null;
    }
    return wirePath;
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(sessionId: string, cwd: string): boolean {
    // cwd 守卫与 resolveSessionWirePath 共用 verifySessionCwd（单源）。
    const verified = this.verifySessionCwd(sessionId, cwd);
    if (!verified) return false;

    const wirePath = path.join(verified.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(wirePath)) {
      return false;
    }

    try {
      const stat = fs.statSync(wirePath);
      const now = Date.now();

      // Check mtime freshness
      if (isStale(stat.mtimeMs, now)) {
        return false;
      }

      // Read the tail to check for active indicators. kimi appends
      // usage.record after step.end at turn completion, so the last loop
      // event (not the last line) decides whether the session is complete.
      // `lastLoopEventIsStepEnd` only scans backwards up to
      // LOOP_EVENT_SCAN_LIMIT lines, so we read only that many trailing lines
      // via the tail-only helper instead of full-slurping the whole wire log
      // (which can be multi-MB) into a string[].
      const lines = readLastNJsonlLines(wirePath, LOOP_EVENT_SCAN_LIMIT);
      if (lines.length === 0) {
        return false;
      }

      // Consider the session inactive when its last loop event is step.end
      return !lastLoopEventIsStepEnd(lines);
    } catch (err) {
      getLogger().debug('[kimi-session-reader] isSessionActive failed:', err);
      return false;
    }
  }
}

// --- listSessions 装配原语（模块级命名函数 + 显式传参） ---
// 纯结构拆分：listSessions 只做 realpath / 遍历 / 排序分页 / 错误降级，
// 单条会话的 state 读取、cwd 守卫、summary 三级回退、mtime 回退全部下沉到
// 这些模块级函数。文案、跳过条件、排序键、分页口径逐项保持。

/** realpath 归一化失败（非 ENOENT）留痕；ENOENT 静默沿用原 cwd。 */
function logKimiRealpathFailure(cwd: string, err: unknown): void {
  logNonEnoentDebug(
    err,
    (m) => `[kimi-session-reader] realpath ${cwd} failed, using the path as given: ${m}`,
  );
}

interface KimiStateRead {
  state: KimiSessionState | null;
  stateParsed: boolean;
}

/** state.json 一次读取共用（cwd 兜底 + summary），I/O 减半。 */
function readKimiState(sessionDir: string, sessionId: string): KimiStateRead {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) return { state: null, stateParsed: false };
  try {
    return {
      state: JSON.parse(fs.readFileSync(statePath, 'utf-8')) as KimiSessionState,
      stateParsed: true,
    };
  } catch (err) {
    // 解析失败 = 无法判 cwd → 不 continue，留给 index workDir 兜底。
    getLogger().debug(
      `[kimi-session-reader] corrupt state.json skipped session=${sessionId}: ${
        (err as Error)?.message ?? String(err)
      }`,
    );
    return { state: null, stateParsed: false };
  }
}

/** index workDir 优先，缺失时回退 state.json 的 workDir/cwd。 */
function resolveKimiEntryWorkDir(
  entry: KimiSessionIndexEntry,
  read: KimiStateRead,
): string | undefined {
  let entryWorkDir: string | undefined = entry.workDir;
  if (!entryWorkDir && read.stateParsed && read.state) {
    entryWorkDir = extractWorkDir(read.state);
  }
  return entryWorkDir;
}

/**
 * 从 wire.jsonl 末段提取最后一条 turn.prompt。
 * v2 state.json 省略 title/lastPrompt 时作为 summary 兜底；只扫尾部 50 行。
 */
function extractLastPromptFromWire(wirePath: string): string | undefined {
  try {
    if (!fs.existsSync(wirePath)) return undefined;
    // Scan backwards from the tail — turn.prompt is typically near the end
    // of a completed turn (before content.part / step.end / usage.record).
    const lines = readLastNJsonlLines(wirePath, 50);
    let lastPrompt: string | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as KimiJsonlEntry;
        if (isTurnPrompt(entry)) {
          if (entry.input && entry.input.length > 0) {
            lastPrompt = entry.input[0].text;
          }
        }
      } catch {
        continue;
      }
    }
    return lastPrompt?.substring(0, 200);
  } catch {
    return undefined;
  }
}

/** summary：state.title / lastPrompt → wire turn.prompt → 'New Session'。 */
function kimiSessionSummary(sessionDir: string, read: KimiStateRead): string {
  let summary = 'New Session';
  if (read.stateParsed && read.state) {
    // v1: state.title / state.lastPrompt; v2: these fields may be absent
    summary = read.state.title || read.state.lastPrompt || '';
  }
  if (!summary) {
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    summary = extractLastPromptFromWire(wirePath) || 'New Session';
  }
  return summary;
}

/**
 * 排序用 mtime：wire.jsonl 优先（run 期间持续写入），缺失回退会话目录
 * mtime；目录也不可读（非 ENOENT 留痕）返回 null，由调用方跳过该条。
 */
function kimiSessionMtime(sessionDir: string): number | null {
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  try {
    return fs.statSync(wirePath).mtimeMs;
  } catch {
    try {
      return fs.statSync(sessionDir).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLogger().warn(
          `[kimi-session-reader] cannot stat ${sessionDir}: ${
            (err as Error)?.message ?? String(err)
          }`,
        );
      }
      // 会话目录已不存在（或被清理）：跳过该条，别让它拖垮整张列表。
      return null;
    }
  }
}

/** 单条 index entry → 列表行；cwd 不匹配 / 目录不可读时返回 null（跳过）。 */
function collectKimiSession(entry: KimiSessionIndexEntry, realCwd: string): AgentSession | null {
  const read = readKimiState(entry.sessionDir, entry.sessionId);
  const entryWorkDir = resolveKimiEntryWorkDir(entry, read);
  if (entryWorkDir === undefined || !samePath(entryWorkDir, realCwd)) {
    return null;
  }
  const summary = kimiSessionSummary(entry.sessionDir, read);
  const mtimeMs = kimiSessionMtime(entry.sessionDir);
  if (mtimeMs === null) return null;
  return {
    sessionId: entry.sessionId,
    summary,
    mtime: mtimeMs,
  };
}

/** 排序键（模块级：不把回调决策点算回 listSessions）。 */
function kimiRowMtime(s: AgentSession): number {
  return s.mtime;
}

function kimiRowId(s: AgentSession): string {
  return s.sessionId;
}
