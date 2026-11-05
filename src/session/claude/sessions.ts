import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findJsonlLine, readLastJsonlLine } from '../common/jsonl.js';
import { isStale } from '../common/constants.js';
import { samePath, encodeProjectDirName } from '../../platform/path.js';
import { extractContentBlocks } from '../common/content-blocks.js';
import { scanJsonlOnce, tailOffsetAfter, scanTailEvents } from '../common/two-pass.js';
import { getLogger } from '../../logger/index.js';
import { logNonEnoentDebug } from '../session-store.js';
import {
  UsageAccumulator,
  contextWindowOccupancy,
  cumulativeUsageFields,
} from '../common/usage-accumulator.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionUsage,
} from '../../session-contract.js';
import {
  SessionIndex,
  extractText,
  isTaskNotificationText,
  CLAUDE_MAPPING,
} from './session-index.js';

/**
 * Directory Claude Code uses to store session transcripts for a given cwd.
 * Claude encodes the cwd by replacing `/` with `-` (e.g.
 * `/Users/x/proj` -> `-Users-x-proj`). Underscores are also replaced with `-`.
 * win32 上 `\` 同样是分隔符、`:` 是非法文件名字符，一并归一为 `-`
 * （`C:\Users\x\proj` -> `C--Users-x-proj`）；见 encodeProjectDirName。
 *
 * Note: this encoding is LOSSY (`my_data/foo` and `my-data/foo` both encode to
 * `my-data-foo`). It is only safe to use the result to **locate** files; never
 * to **decode** a directory name back to a cwd. The cwd must always be read
 * from the JSONL content (regression: /resume & /cd 路径错乱).
 */
function projectDirForCwd(cwd: string, projectsDir: string): string {
  return path.join(projectsDir, encodeProjectDirName(cwd));
}

/**
 * cwd guard for the index-miss fallback (readSessionContent /
 * isClaudeSessionActive / findSessionFileInProjects): the project-dir
 * encoding is lossy (N-to-N), so a file located by directory must be verified
 * to actually belong to the requested cwd. A relocated session contains
 * MULTIPLE cwd values (pre- and post-relocate) — accept when ANY `cwd` field
 * matches. Early-stops on the first match (findJsonlLine), keeping the
 * single-pass parse-count anchors intact on the fallback path.
 * Needed for EnterWorktree relocate.
 */
function fileContainsCwd(filePath: string, cwd: string): boolean {
  return (
    findJsonlLine(filePath, (l) => {
      try {
        const obj = JSON.parse(l) as { cwd?: unknown };
        // PathKit.samePath：darwin/win32 大小写不敏感 + 尾分隔符不敏感，linux 严格
        return typeof obj.cwd === 'string' && samePath(obj.cwd, cwd);
      } catch {
        return false; // skip malformed line
      }
    }) !== null
  );
}

function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * EnterWorktree relocate support: Claude Code MOVES the
 * transcript file to the new cwd's project dir mid-session, so the file may
 * not exist under the requested cwd's encoded dir. Fall back to locating
 * `<sessionId>.jsonl` across all project dirs. Deterministic: entries are
 * sorted, first match wins; the cwd guard in `readSessionContent` still
 * validates the file afterwards.
 */
function findSessionFileInProjects(
  sessionId: string,
  projectsDir: string,
  cwd?: string,
): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().debug(
        `[claude-session-reader] cannot read projects dir ${projectsDir}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    }
    return undefined;
  }
  const name = `${sessionId}.jsonl`;
  const candidates: string[] = [];
  for (const entry of entries.sort()) {
    const candidate = path.join(projectsDir, entry, name);
    if (fs.existsSync(candidate)) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  // Multiple copies: prefer the one whose jsonl contains the requested cwd
  // (handles EnterWorktree relocate where the same sessionId exists in
  // multiple project dirs). Fall back to the first sorted candidate.
  if (cwd) {
    for (const candidate of candidates) {
      if (fileContainsCwd(candidate, cwd)) return candidate;
    }
  }
  return candidates[0];
}

/**
 * Lazily-created in-memory session index per projectsDir (session-index.ts).
 * First list/read query builds it (full scan); afterwards refresh() is
 * throttled to a 5s on-demand incremental rescan — no background polling.
 * Keep-alive across calls so the index is actually reused.
 */
const sessionIndexByProjectsDir = new Map<string, SessionIndex>();

function ensureSessionIndex(projectsDir: string): SessionIndex {
  let index = sessionIndexByProjectsDir.get(projectsDir);
  if (!index) {
    index = new SessionIndex(projectsDir);
    sessionIndexByProjectsDir.set(projectsDir, index);
  }
  return index;
}

/**
 * List Claude Code sessions for a given cwd, newest first. Each entry has
 * the sessionId (= jsonl filename stem), a one-line summary extracted from
 * the first user message, and the file mtime. Returns an empty array when
 * the project directory doesn't exist or no jsonl has a matching cwd field.
 */
export function listClaudeSessions(
  cwd: string,
  opts: { limit?: number; projectsDir?: string } = {},
): AgentSession[] {
  // 不传 limit = 返回全集不切片；仅显式传值才 slice
  // reader 拿全集算 total 后再自己按 offset/limit 切片。
  const limit = opts.limit;
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const index = ensureSessionIndex(projectsDir);
  // 首次调用延迟全量建索引；之后 5s 按需节流增量刷新（拍板 3）。
  index.refresh();
  // 统一 parser 的完整 cwd 集合 → A→B→C 任意中间 cwd 都可列出（核心 bug 修复）。
  // readdir 失败时索引保留旧快照（首次失败则为空），与旧扫描的 readdir 兜底等价。
  const sessions = index.listByCwd(cwd).map((e) => ({
    sessionId: e.sessionId,
    summary: e.summary,
    mtime: e.mtimeMs,
  }));
  // 空列表 + 上次扫描是非 ENOENT 失败 → 是「读不到」而非「真的没有」。
  // 与 opencode/kimi/pi 同口径：router 显示「列表失败」，别假装空态。
  if (sessions.length === 0 && index.lastScanError !== undefined) {
    const err = index.lastScanError;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`claude session list 读取失败: ${msg}`, { cause: err });
  }
  return limit === undefined ? sessions : sessions.slice(0, limit);
}

/** Get the newest session for a given cwd. Returns undefined if none exist. */
export function getNewestSession(
  cwd: string,
  opts: { projectsDir?: string } = {},
): AgentSession | undefined {
  const sessions = listClaudeSessions(cwd, { ...opts, limit: 1 });
  return sessions[0];
}

/**
 * Check if a session is still active. Two signals combined:
 *
 * 1. **mtime freshness** (authoritative): an active claude process flushes
 *    JSONL output continuously. A file whose mtime is older than
 *    `STALE_MS` cannot be from a running process. This catches the
 *    common Claude CLI 2.x case where the tail is `last-prompt` / `mode`
 *    (no `type:"result"`) and the process exited long ago.
 *
 * 2. **last-line terminal marker**: if the last JSON line is `result`
 *    (older CLI) or any explicit terminal event, the session is done
 *    regardless of mtime.
 *
 * Override `now` for tests.
 */

/** 末行是这些类型之一 = 会话已收尾（模块级：逐文件判定不必每次重建 Set）。 */
const CLAUDE_TERMINAL_TYPES = new Set(['result', 'last-prompt', 'mode', 'permission-mode']);

/**
 * 文件侧的活跃判定：mtime 新鲜 + 末行没有终态标记。
 *
 * 刻意不叫 `isSessionActive`——那是 reader 契约上的方法名，语义各家自己定；
 * 本函数只看这一个文件，两者同名不同义曾让人把「最近有写入」当成「turn 在跑」。
 */
function hasRecentFileActivity(
  filePath: string,
  mtimeMs: number,
  now: number = Date.now(),
): boolean {
  // Hard signal: file untouched for over an hour → can't be from a live process
  if (isStale(mtimeMs, now)) return false;

  const lastLine = readLastJsonlLine(filePath);
  if (!lastLine) return false;

  try {
    const obj = JSON.parse(lastLine);
    // Explicit terminal markers — regardless of mtime. Claude CLI 2.x uses
    // `last-prompt` / `mode` (no `result` event) to mark turn end, so a
    // 24-minute-old session with a last-prompt tail is already done
    // (previously falsely reported as active).
    if (typeof obj.type === 'string' && CLAUDE_TERMINAL_TYPES.has(obj.type)) return false;
  } catch {
    // ignore parse errors
  }
  return true;
}

/**
 * stat 失败：ENOENT = 文件在两次查询之间消失（正常竞态）；其余 errno 必须留痕，
 * 否则「文件不可读」会被当成「会话不活跃」。
 */
function logStatFailure(filePath: string, err: unknown): void {
  logNonEnoentDebug(err, (m) => `[claude-session-reader] stat ${filePath} failed: ${m}`);
}

/**
 * Check if a Claude session (by sessionId + cwd) is still active.
 * Public wrapper around the internal `hasRecentFileActivity(filePath, mtimeMs, now)`
 * for use by `ClaudeSessionReader` and the multi-agent adapter layer.
 *
 * Resolves the jsonl path via `projectDirForCwd`, stats it for mtime, then
 * applies the same mtime-freshness + terminal-marker heuristic
 * used for session-active detection. Returns false if the file doesn't exist.
 */
export function isClaudeSessionActive(
  sessionId: string,
  cwd: string,
  opts: { projectsDir?: string } = {},
): boolean {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const index = ensureSessionIndex(projectsDir);
  if (index.isBuilt) {
    // 索引定位: findBySessionIdAndCwd 内部 re-stat 比 fingerprint（拍板 3），
    // cwdSet 匹配即守卫通过，无需再全文件扫一遍。
    index.refresh();
    const entry = index.findBySessionIdAndCwd(sessionId, cwd);
    if (entry) {
      try {
        const st = fs.statSync(entry.path);
        return hasRecentFileActivity(entry.path, st.mtimeMs);
      } catch (err) {
        logStatFailure(entry.path, err);
        return false;
      }
    }
  }

  // 索引 miss / 未构建 / 降级 → 精确 sessionId 全目录 fallback + cwd 守卫
  {
    const dir = projectDirForCwd(cwd, projectsDir);
    let filePath = path.join(dir, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) {
      // EnterWorktree relocate: transcript moved to the new cwd's project dir.
      const relocated = findSessionFileInProjects(sessionId, projectsDir, cwd);
      if (!relocated) return false;
      filePath = relocated;
    }

    // Verify the jsonl belongs to the requested cwd (any cwd field may match).
    if (!fileContainsCwd(filePath, cwd)) return false;

    try {
      const st = fs.statSync(filePath);
      return hasRecentFileActivity(filePath, st.mtimeMs);
    } catch (err) {
      logStatFailure(filePath, err);
      return false;
    }
  }
}

/**
 * First-pass scan result for readSessionContent.
 * previously readSessionContent parsed allLines 3-4 times (usage,
 * findLastUser, events, title/recap). Now a first pass (scalarScan) parses
 * each line once to collect all metadata + the index of the last user
 * message; a second pass only re-parses the TAIL (events after the last user
 * message) so memory is O(tail) rather than O(whole-file) for parsed
 * objects. Total parses ≈ 1.x × line count (replaced a parsed[]
 * array that retained every line's object for the function lifetime).
 *
 * the index is now a **byte offset** (`tailOffset`) of the line
 * AFTER the last user message, captured during a streaming scan that
 * materializes no `string[]`. The second pass re-reads only the tail from
 * that offset via `readJsonlLinesFromOffset`, so raw line-string memory is
 * O(tail) too — not just the parsed objects. When there is no user message,
 * `tailOffset` stays -1 and the caller re-reads the whole file (the known
 * no-user asymptotic case).
 */
interface ScanResult {
  /** Byte offset where the tail begins (start of the line after the last
   *  user message), or -1 if no user message was found. */
  tailOffset: number;
  /** Aggregated usage from all assistant messages. */
  usage: AgentSessionUsage;
  /** Last ai-title string found, or undefined. */
  aiTitle: string | undefined;
  /** Last compact-summary content found, or undefined. */
  recap: string | undefined;
  /** Last real user text input (non-meta, non-tool-result, non-summary). */
  lastUserMessage: string | undefined;
}

/**
 * 是否是“真人发起新 turn”的 user 行。
 *
 * 只用于 turn 边界，不用于展示标题。排除：tool_result、compact summary、
 * isMeta（skill/命令注入）、task notification、sidechain（子 agent prompt）。
 * 不要求有可展示文本——attachment-only 的输入同样是一次真人 turn。
 */
function isRealUserPrompt(obj: Record<string, unknown>): boolean {
  if (obj.type !== 'user' || obj.isCompactSummary === true || obj.isMeta === true) {
    return false;
  }
  if (obj.isSidechain === true) return false;
  const msg = obj.message as Record<string, unknown> | undefined;
  if (msg?.role !== 'user' || msg.content === undefined) return false;
  const content = msg.content;
  if (
    Array.isArray(content) &&
    content.some((block) => (block as Record<string, unknown> | undefined)?.type === 'tool_result')
  ) {
    return false;
  }
  const text = extractText(content);
  if (text && isTaskNotificationText(text)) return false;
  return true;
}

/** claude wire 一条 assistant 行携带的原始 usage 字段（可选，缺按 0 计）。 */
interface ClaudeRawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** per-message-id 合并后的 usage 采样（四个分量 + 采集时的真人 turn 序号）。 */
export interface ClaudePerMessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** 该 message 属于第几个真人 turn（0 = 还没有真人 prompt）。 */
  turn: number;
}

/**
 * 两条采样逐字段取 max（纯函数；UsageAccumulator 的 per-field max 语义）。
 *
 * RED LINE（token 口径单源的一部分）：一条 streaming assistant 消息跨多行
 * jsonl、共享同一 message id；部分后端（第三方网关，如 DeepSeek）在早期占位
 * 行（空 thinking 块）写全零 usage，真实用量只在带 stop_reason 的末行。
 * first-occurrence-wins 会把零记录钉死、丢掉真实用量（regression 2026-08-19：
 * auto-resume 卡 per-run 统计全 0）。逐字段 max 与行序无关地重建完整用量；
 * 官方 API 每行重复相同 usage，max 是 no-op。
 *
 * 产生：合并后的一条采样。依赖：入参。不改任何外部状态。
 */
export function maxUsageRecord(
  prev: ClaudePerMessageUsage | undefined,
  usage: ClaudeRawUsage,
  turnSeq: number,
): ClaudePerMessageUsage {
  return {
    input: Math.max(prev?.input ?? 0, usage.input_tokens ?? 0),
    output: Math.max(prev?.output ?? 0, usage.output_tokens ?? 0),
    cacheRead: Math.max(prev?.cacheRead ?? 0, usage.cache_read_input_tokens ?? 0),
    cacheCreation: Math.max(prev?.cacheCreation ?? 0, usage.cache_creation_input_tokens ?? 0),
    turn: prev?.turn ?? turnSeq,
  };
}

/**
 * usage 装配（纯函数）：每个 message id 一条最优记录、按首次出现顺序喂
 * UsageAccumulator（Map 保序），acc.last = 末条 message 的完整用量，totals
 * 让每条 API 响应恰好多计一次。per-run flow 只取末个真人 turn 的记录——
 * 工具往返的 turn 有多条 assistant 消息（一次模型请求一条），只取 `last`
 * 会低报。
 *
 * 产生：AgentSessionUsage。依赖：入参 records + 标量。不改任何外部状态
 * （UsageAccumulator 在函数内新建）。
 */
export function buildClaudeUsage(
  records: Iterable<ClaudePerMessageUsage>,
  opts: { turnSeq: number; lastPostTokens: number; compactCount: number },
): AgentSessionUsage {
  const acc = new UsageAccumulator();
  const turn = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const record of records) {
    acc.add(record);
    if (opts.turnSeq > 0 && record.turn === opts.turnSeq) {
      turn.input += record.input;
      turn.output += record.output;
      turn.cacheRead += record.cacheRead;
      turn.cacheCreation += record.cacheCreation;
    }
  }

  // Build usage result (same logic as old aggregateSessionUsage)
  const t = acc.totals;
  const l = acc.last;
  // 没有真人 user prompt（旧数据/截断文件）→ 无法划分 turn，回退末条采样，
  // 与 dsh/codex「无 turn 标记退回末条」一致；不能把整份文件当成一轮。
  if (opts.turnSeq === 0 && l) {
    turn.input = l.input;
    turn.output = l.output;
    turn.cacheRead = l.cacheRead;
    turn.cacheCreation = l.cacheCreation;
  }
  // contextLength = current context-window occupancy. Prefer compact_boundary
  // postTokens (the precise post-compact size); otherwise fall back to the
  // last turn's input + cacheRead + cacheCreation (unified
  // contract — excludes output/reasoning, which are generated, not part of
  // the input window). Take the max so a pre-compact turn larger than the
  // post-compact size is not under-reported.
  const lastWindow = l ? contextWindowOccupancy(l) : 0;
  let contextLength = opts.lastPostTokens;
  if (contextLength === 0 || lastWindow > contextLength) {
    contextLength = lastWindow;
  }

  // 非累计字段 = 末轮（本 run）scope，累计字段 = session 总和（所有 run）。
  // 对齐 codex reader 语义（§9.21：`last_token_usage`=单 turn 增量、
  // `total_token_usage`=session 累计）——否则 jsonl 兜底路径会把 session 累计
  // 当成"本 run"显示，与卡片"本 run ≤ 累计"不变量冲突（累计反而更小）。
  const lastTotal = turn.input + turn.output + turn.cacheRead + turn.cacheCreation;
  return {
    inputTokens: turn.input,
    outputTokens: turn.output,
    contextLength,
    compactCount: opts.compactCount,
    cacheReadTokens: turn.cacheRead > 0 ? turn.cacheRead : undefined,
    cacheCreationTokens: turn.cacheCreation > 0 ? turn.cacheCreation : undefined,
    totalTokens: lastTotal,
    ...cumulativeUsageFields(t),
  };
}

/**
 * first-pass scan: stream the file once via `scanJsonlLines`
 * (no `string[]` materialized), parse each line exactly once, and collect
 * all metadata needed by readSessionContent (usage, tailOffset, aiTitle,
 * recap, lastUserMessage). Does NOT retain parsed objects — the events tail
 * is re-parsed separately by `extractEventsFromTail` so memory for both raw
 * line strings and parsed objects is O(tail), not O(whole file).
 *
 * 主体是分发表：每类行只收集自己的标量（assistant → usage 并表、
 * compact_boundary → 计数 + postTokens、user → tail 定位/标题、ai-title）；
 * usage 的逐字段 max 合并（maxUsageRecord）与装配（buildClaudeUsage）已
 * 独立成纯函数。
 */
/** first-pass 累积状态（显式传给各模块级收集器，替代外层闭包变量）。 */
interface ScalarScanState {
  /** Per-message-id best usage record (per-field max). */
  usageByMessageId: Map<string, ClaudePerMessageUsage>;
  lastPostTokens: number;
  compactCount: number;
  tailOffset: number;
  /** 真人 prompt 序号；末个 turn = 当前值。sidechain/注入/工具结果不递增。 */
  turnSeq: number;
  lastAiTitle?: string;
  lastRecap?: string;
  lastUserMessage?: string;
}

function newScalarScanState(): ScalarScanState {
  // Per-message-id best usage record (per-field max). A streaming assistant
  // message spans multiple jsonl lines sharing the same message id; some
  // backends (third-party gateways, e.g. DeepSeek) write all-zero usage on
  // the early placeholder lines (empty thinking block) and the real usage
  // only on the final line carrying stop_reason. First-occurrence-wins dedup
  // would pin the zero record and discard the real one (auto-resume card
  // per-run stats all 0). Per-field max reconstructs the full usage
  // regardless of line order — on the official API every line repeats
  // identical usage, so max is a no-op there.
  return {
    usageByMessageId: new Map<string, ClaudePerMessageUsage>(),
    lastPostTokens: 0,
    compactCount: 0,
    tailOffset: -1,
    turnSeq: 0,
  };
}

/** assistant 行 → 按 message id 逐字段 max 合并 usage（was aggregateSessionUsage）。 */
function collectAssistantUsage(state: ScalarScanState, obj: Record<string, unknown>): void {
  if (obj.type !== 'assistant') return;
  const msg = obj.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as ClaudeRawUsage | undefined;
  if (!usage) return;
  const msgId = msg?.id as string | undefined;
  if (!msgId) return;
  state.usageByMessageId.set(
    msgId,
    maxUsageRecord(state.usageByMessageId.get(msgId), usage, state.turnSeq),
  );
}

/** compact_boundary → 计数 + 压缩后 token 水位。 */
function collectCompactBoundary(state: ScalarScanState, obj: Record<string, unknown>): void {
  if (obj.type !== 'system' || obj.subtype !== 'compact_boundary') return;
  state.compactCount++;
  const cm = obj.compactMetadata as { postTokens?: number } | undefined;
  if (cm?.postTokens) {
    state.lastPostTokens = cm.postTokens;
  }
}

/** 记录 tail 起点：本 user 行之后的下一行字节偏移（见 tailOffsetAfter）。 */
function collectTailOffset(
  state: ScalarScanState,
  obj: Record<string, unknown>,
  line: string,
  offset: number,
): void {
  if (obj.type !== 'user') return;
  const msg = obj.message as Record<string, unknown> | undefined;
  if (msg?.role === 'user') {
    state.tailOffset = tailOffsetAfter(line, offset);
  }
}

/** ai-title：最后一条生效。 */
function collectAiTitle(state: ScalarScanState, obj: Record<string, unknown>): void {
  if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
    state.lastAiTitle = obj.aiTitle as string;
  }
}

/** recap：最后一条 isCompactSummary 生效。 */
function collectRecap(state: ScalarScanState, obj: Record<string, unknown>): void {
  if (obj.type !== 'user' || obj.isCompactSummary !== true) return;
  const msg = obj.message as Record<string, unknown> | undefined;
  if (!msg?.content) return;
  const recapContent = extractText(msg.content);
  if (recapContent) {
    state.lastRecap = recapContent;
  }
}

/** displayTitle 用的最近真人输入：跳过 tool_result / recap / isMeta / 任务通知。 */
function collectLastUserMessage(state: ScalarScanState, obj: Record<string, unknown>): void {
  if (obj.type !== 'user' || obj.isCompactSummary || obj.isMeta) return;
  const msg = obj.message as Record<string, unknown> | undefined;
  if (msg?.role !== 'user' || !msg.content) return;
  const content = msg.content;
  const isToolResult =
    Array.isArray(content) &&
    content.length > 0 &&
    (content[0] as Record<string, unknown>)?.type === 'tool_result';
  if (isToolResult) return;
  const userContent = extractText(content);
  if (userContent && !isTaskNotificationText(userContent)) {
    state.lastUserMessage = userContent;
  }
}

/** 真人 prompt 开启新 turn；注入/工具结果/sidechain 不递增。 */
function countRealUserPrompt(state: ScalarScanState, obj: Record<string, unknown>): void {
  if (isRealUserPrompt(obj)) state.turnSeq++;
}

/**
 * 单行分派：收集器调用顺序与原回调逐字一致（尤其 turnSeq 在最后递增，
 * 保证 assistant usage 记录归属的是「本行之前」的 turn）。
 */
function scanScalarLine(
  state: ScalarScanState,
  obj: Record<string, unknown>,
  line: string,
  offset: number,
): void {
  collectAssistantUsage(state, obj);
  collectCompactBoundary(state, obj);
  collectTailOffset(state, obj, line, offset);
  collectAiTitle(state, obj);
  collectRecap(state, obj);
  collectLastUserMessage(state, obj);
  countRealUserPrompt(state, obj);
}

function scalarScan(filePath: string): ScanResult {
  const state = newScalarScanState();
  scanJsonlOnce(filePath, scanScalarLine.bind(null, state));
  return {
    tailOffset: state.tailOffset,
    usage: buildClaudeUsage(state.usageByMessageId.values(), {
      turnSeq: state.turnSeq,
      lastPostTokens: state.lastPostTokens,
      compactCount: state.compactCount,
    }),
    aiTitle: state.lastAiTitle,
    recap: state.lastRecap,
    lastUserMessage: state.lastUserMessage,
  };
}

/**
 * second-pass tail mapper: expand one parsed tail line into
 * content-block events. Re-parses only tail lines (scanTailEvents does the
 * offset re-read + line filtering), so both raw line-string memory and
 * parsed-object memory are O(tail), not O(whole file) —.
 *
 * `maxEvents` capping (unified "last N events" contract across
 * all readers) is applied by scanTailEvents.
 */
function mapClaudeTailLine(obj: Record<string, unknown>): AgentSessionContentEvent[] {
  const message = obj.message as { content?: unknown; role?: string } | undefined;

  // Expand all content blocks from this message into separate events.
  const blocks = extractContentBlocks(message?.content, CLAUDE_MAPPING);
  const role = message?.role ?? (obj.type as string | undefined) ?? 'unknown';
  const timestamp = obj.timestamp as string | undefined;
  const events: AgentSessionContentEvent[] = [];
  for (const block of blocks) {
    events.push({ type: block.type, content: block.content, timestamp });
  }

  // If message has no content blocks (e.g., metadata-only lines like last-prompt),
  // still emit an event with the raw type so users see what happened
  if (blocks.length === 0 && message?.role) {
    events.push({ type: role, content: `(${role} event)`, timestamp });
  }
  return events;
}

export function readSessionContent(
  sessionId: string,
  cwd: string,
  opts: { projectsDir?: string; maxEvents?: number } = {},
): {
  events: AgentSessionContentEvent[];
  usage?: AgentSessionUsage;
  aiTitle?: string;
  recap?: string;
  displayTitle?: string;
} {
  const { maxEvents } = opts;
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  let filePath: string | undefined;

  const index = ensureSessionIndex(projectsDir);
  if (index.isBuilt) {
    // 索引定位: findBySessionIdAndCwd 内部 re-stat 比 fingerprint（拍板 3），
    // cwdSet 匹配即守卫通过，无需再全文件扫一遍（不许在指纹一致时全扫）。
    index.refresh();
    const entry = index.findBySessionIdAndCwd(sessionId, cwd);
    if (entry) filePath = entry.path;
  }

  if (filePath === undefined) {
    // 索引 miss / 未构建 / 降级 → 旧 fallback（精确 sessionId 全目录扫描 + cwd 守卫）
    const dir = projectDirForCwd(cwd, projectsDir);
    const direct = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) {
      filePath = direct;
    } else {
      // EnterWorktree relocate: transcript moved to the new cwd's project dir.
      const relocated = findSessionFileInProjects(sessionId, projectsDir, cwd);
      if (!relocated) return { events: [] };
      filePath = relocated;
    }

    // Verify the jsonl actually belongs to the requested cwd (dir encoding is
    // lossy). ANY cwd field may match: relocated sessions contain multiple.
    if (!fileContainsCwd(filePath, cwd)) {
      return { events: [] };
    }
  }

  // Two-pass 扫描（pass 1 流式收标量 + pass 2 只重读 tail）的口径与解析比
  // 见 `src/session/common/two-pass.ts` 头注释；claude 侧只多一项：索引 miss
  // 时的 fallback 守卫另有固定 ~2 次早停解析，与行数无关。
  const scan = scalarScan(filePath);

  // 有 usage 即返回：非累计字段已是末轮 scope，命中判定用 session 累计兜底
  // （末轮可能 input/output 为 0 而仍有 cacheRead，累计口径不会被末轮遮挡）。
  const usage: AgentSessionUsage | undefined =
    (scan.usage.cumulativeTotalTokens ?? 0) > 0 ? scan.usage : undefined;

  // Extract events AFTER the last user message by re-reading + re-parsing
  // only the tail. If no user message was found (tailOffset === -1), fall
  // back to re-reading the whole file so the card still has something to
  // show.
  const events = scanTailEvents(filePath, scan.tailOffset, mapClaudeTailLine, maxEvents);

  // Use aiTitle if available, otherwise fallback to last user message.
  // Truncation is deferred to the consumer (router card building).
  const displayTitle = scan.aiTitle ?? scan.lastUserMessage ?? undefined;

  return {
    events,
    usage,
    aiTitle: scan.aiTitle,
    recap: scan.recap,
    displayTitle,
  };
}
