/**
 * OpencodeSessionReader: CLI-based session reader using `opencode session list`
 * and `opencode session export` (v2) / `opencode export` (v1).
 *
 * Design:
 * - Uses official CLI commands instead of HTTP API.
 * - `opencode session list --format json` returns sessions with `directory` field (first-class citizen).
 * - `opencode session export <sessionID>` (v2) or `opencode export <sessionID>`
 *   (v1) returns full session content.
 * - Independent of runner (no setRunner circular dependency).
 *
 * Key features:
 * - listSessions: filter by directory field (the canonical session metadata).
 * - readSessionContent: extract catch-up tail from export messages.
 * - isSessionActive: use `updated` timestamp with 1 hour stale window.
 * - Simple memory cache with TTL.
 */

import { spawnProcessSync } from '../../platform/spawn.js';
import fs from 'node:fs';
import { bestEffortUnlink } from '../../common/fs.js';
import os from 'node:os';
import path from 'node:path';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';
import { isStale } from '../common/constants.js';
import { safeRealpath, samePath } from '../../platform/path.js';
import { paginate, capEvents } from '../common/pagination.js';
import { newestOf, sortByRecencyDesc } from '../common/recency.js';
import { TtlCache } from '../../common/ttl-cache.js';
import { getLogger } from '../../logger/index.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
} from '../../session-contract.js';

interface OpencodeSessionReaderOptions {
  /** Path to the opencode binary. Defaults to `opencode`. */
  binary?: string;
  /** Cache TTL for session list (ms). Default: 10_000. */
  cacheTtlMs?: number;
  /**
   * Override the raw export capture (returns the JSON string).
   * Default routes stdout to a temp file fd to bypass opencode's ~128KB pipe
   * truncation on large sessions. Injectable for testing.
   */
  captureExport?: (sessionId: string) => string;
}

interface OpencodeSessionListEntry {
  id: string;
  title: string;
  updated: number;
  created: number;
  projectId: string;
  directory: string;
}

interface OpencodeExportMessage {
  info: {
    role: 'user' | 'assistant';
    time?: { created: number };
    id: string;
    sessionID: string;
  };
  parts: Array<{
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: {
      status: string;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
    };
    reason?: string;
    tokens?: {
      total: number;
      input: number;
      output: number;
      reasoning: number;
      cache?: { read: number; write: number };
    };
  }>;
}

interface OpencodeExportData {
  info: {
    id: string;
    title?: string;
    /** v1 export shape. */
    directory?: string;
    /** v2 export shape. */
    location?: { directory?: string };
    agent?: string;
    model?: { id: string; providerID: string };
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache?: { read: number; write: number };
    };
    time: { created: number; updated: number };
  };
  messages: OpencodeExportMessage[];
}

/**
 * v2 `session export` messages are flattened: `{type, text, content}` rather
 * than v1's `{info, parts}` envelope. Keep the v2 types local to this reader —
 * they are an external JSON contract, not an internal model.
 */
interface OpencodeV2Message {
  id?: string;
  type: string;
  time?: { created?: number; completed?: number };
  text?: string;
  content?: Array<OpencodeV2ContentPart>;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
  error?: { type?: string; message?: string };
  command?: string;
  output?: string;
  callID?: string;
  summary?: string;
}

interface OpencodeV2ContentPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  state?: {
    status?: string;
    input?: unknown;
    content?: Array<{ type?: string; text?: string; content?: { type?: string; text?: string } }>;
    error?: { type?: string; message?: string } | string;
    result?: unknown;
  };
}

interface OpencodeV2ExportData {
  info: {
    title?: string;
    location?: { directory?: string };
    directory?: string;
  };
  messages: OpencodeV2Message[];
}

/** v2 CLI defaults `session list` to 100 entries; keep the reader's historical
 *  "all sessions in this cwd" contract by asking for a high explicit limit. */
const MAX_SESSION_LIST_COUNT = 10_000;

function isV2Export(data: OpencodeExportData | OpencodeV2ExportData): data is OpencodeV2ExportData {
  if (data.info && 'location' in data.info) return true;
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) =>
      m !== null &&
      typeof m === 'object' &&
      typeof (m as { type?: unknown }).type === 'string' &&
      !('info' in (m as object)),
  );
}

/** v1 stores the cwd at `info.directory`; v2 moved it under `info.location`. */
function exportDirectory(data: OpencodeExportData | OpencodeV2ExportData): string | undefined {
  const info = data.info as OpencodeExportData['info'] | OpencodeV2ExportData['info'] | undefined;
  return info?.directory ?? info?.location?.directory;
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** v2 export tool state carries results in `content[]` (text parts) or
 *  `error.message`; `result` is model/tool-specific and only used as a
 *  last-resort string. */
function v2ToolOutput(state: OpencodeV2ContentPart['state']): string | undefined {
  if (!state) return undefined;
  const texts: string[] = [];
  for (const item of Array.isArray(state.content) ? state.content : []) {
    if (typeof item?.text === 'string') {
      texts.push(item.text);
    } else if (item?.content?.type === 'text' && typeof item.content.text === 'string') {
      texts.push(item.content.text);
    }
  }
  if (texts.length > 0) return texts.join('\n');
  if (typeof state.error === 'string') return state.error;
  if (state.error && typeof state.error.message === 'string') return state.error.message;
  if (typeof state.result === 'string') return state.result;
  return undefined;
}

interface OpencodeCliResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}

/**
 * 把会话级累计 token 落到 usage 上（v1 export 与 v2 export 两条读取路径共用）。
 *
 * 已有 usage 就地补累计字段；没有 usage 但累计非零（例如只有 cache 计数）时，
 * 构造一条只带累计的，避免"会话有消耗却显示无 usage"。
 */
function withCumulativeUsage(
  usage: AgentSessionUsage | undefined,
  cum: {
    total: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): AgentSessionUsage | undefined {
  if (usage) {
    usage.cumulativeTotalTokens = cum.total;
    usage.cumulativeInputTokens = cum.input;
    usage.cumulativeOutputTokens = cum.output;
    usage.cumulativeCacheReadTokens = cum.cacheRead;
    usage.cumulativeCacheCreationTokens = cum.cacheWrite;
    return usage;
  }
  if (!(cum.input || cum.output || cum.total || cum.cacheRead || cum.cacheWrite)) {
    return undefined;
  }
  return {
    inputTokens: 0,
    outputTokens: 0,
    contextLength: 0,
    cumulativeTotalTokens: cum.total,
    cumulativeInputTokens: cum.input,
    cumulativeOutputTokens: cum.output,
    cumulativeCacheReadTokens: cum.cacheRead,
    cumulativeCacheCreationTokens: cum.cacheWrite,
  };
}

export class OpencodeSessionReader implements AgentSessionReader {
  private readonly binary: string;
  private readonly cacheTtlMs: number;
  /** Optional raw-export capture override (testing / alt transport). */
  private readonly captureExportOverride?: (sessionId: string) => string;
  /** cwd → 列表缓存（TTL 由 cacheTtlMs 决定）。 */
  private listCache: TtlCache<string, OpencodeSessionListEntry[]>;

  constructor(opts: OpencodeSessionReaderOptions = {}) {
    this.binary = opts.binary ?? 'opencode';
    this.cacheTtlMs = opts.cacheTtlMs ?? 10_000;
    this.listCache = new TtlCache(this.cacheTtlMs);
    this.captureExportOverride = opts.captureExport;
  }

  /**
   * List sessions in a given cwd, using directory field for matching.
   * Uses realpath for macOS /tmp -> /private/tmp compatibility.
   * Passes user cwd to execFileSync so opencode CLI returns sessions for the correct directory.
   */
  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    const realCwd = this.realpath(cwd);
    const entries = this.fetchSessionList(realCwd);

    // Filter by directory === realpath(cwd)
    const filtered = entries.filter((e) => samePath(e.directory, realCwd));

    // Sort by updated descending; same-updated ties use id as a deterministic
    // secondary key so CLI/list-cache rebuilds never reorder the page.
    sortByRecencyDesc(
      filtered,
      (s) => s.updated,
      (s) => s.id,
    );

    // Compute total over the full sorted set, then paginate.
    const { items, total } = paginate(filtered, opts ?? {});

    return {
      sessions: items.map((e) => ({
        sessionId: e.id,
        // CLI title 字段形状不保证恒为 string（null/缺字段时 router 的
        // s.summary.trim() 会 TypeError）——非 string 给空串（Review）。
        summary: typeof e.title === 'string' ? e.title : '',
        mtime: e.updated,
      })),
      total,
    };
  }

  /**
   * Get the newest session in a given cwd.
   */
  getNewestSession(cwd: string): AgentSession | null {
    return newestOf(this, cwd);
  }

  /**
   * Read session content: extract catch-up tail (last user message + everything after).
   */
  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    const realCwd = this.realpath(cwd);

    // capture raw export via the injectable seam, then parse. Distinguish
    // a truly-missing session (empty capture) from a truncated/corrupt one
    // (non-empty but unparseable) so we never show the misleading "未找到" for
    // a session whose content is merely too large to pipe through stdout.
    let raw: string;
    try {
      raw = this.captureExport(sessionId);
    } catch (err) {
      getLogger().warn(`[opencode-session-reader] captureExport failed: ${err}`);
      return { events: [] };
    }
    const trimmed = raw?.trim() ?? '';
    if (!trimmed) {
      return { events: [] };
    }
    let data: OpencodeExportData | OpencodeV2ExportData;
    try {
      data = JSON.parse(trimmed) as OpencodeExportData | OpencodeV2ExportData;
    } catch (err) {
      getLogger().warn(
        `[opencode-session-reader] export JSON parse failed (truncated/corrupt?), raw bytes=${trimmed.length}: ${err}`,
      );
      return { events: [] };
    }

    try {
      // 与 listSessions 的过滤同口径（PathKit.samePath）：export 里的 directory
      // 形态由 opencode 自行记录，裸 !== 会让会话列得出却读不出（win32 常态）
      const directory = exportDirectory(data);
      if (!directory || !samePath(directory, realCwd)) {
        return { events: [] };
      }

      if (isV2Export(data)) {
        return this.readV2SessionContent(data, opts);
      }

      const events: AgentSessionContentEvent[] = [];
      let usage: AgentSessionUsage | undefined;
      let aiTitle: string | undefined;
      let displayTitle: string | undefined;

      // Find the last user message position (for catch-up tail).
      // messages are already parsed objects — scan directly.
      let lastUserIndex = -1;
      for (let i = 0; i < data.messages.length; i++) {
        if (data.messages[i].info.role === 'user') {
          lastUserIndex = i;
        }
      }

      // Process messages from last user message onwards (catch-up tail)
      const startIndex = lastUserIndex >= 0 ? lastUserIndex : 0;
      for (let i = startIndex; i < data.messages.length; i++) {
        const msg = data.messages[i];
        const timestamp = msg.info.time?.created
          ? new Date(msg.info.time.created).toISOString()
          : undefined;

        for (const part of msg.parts) {
          if (part.type === 'text') {
            // First user text after last user message is displayTitle
            if (msg.info.role === 'user' && part.text && !displayTitle) {
              displayTitle = part.text;
            }
            events.push({
              type: 'text',
              content: part.text ?? '',
              timestamp,
            });
          } else if (part.type === 'reasoning') {
            events.push({
              type: 'thinking',
              content: part.text ?? '',
              timestamp,
            });
          } else if (part.type === 'tool') {
            // Tool use
            if (part.callID && part.state?.input) {
              events.push({
                type: 'tool_use',
                content: JSON.stringify({
                  id: part.callID,
                  name: part.tool,
                  input: part.state.input,
                }),
                timestamp,
              });
            }
            // Tool result (completed or error)
            if (part.callID && part.state?.output) {
              const isError = part.state.status === 'error';
              const rawOut = isError
                ? (part.state.error ?? part.state.output)
                : (part.state.output ?? '');
              // pre-fold pathological tool_results (e.g. a 500KB file
              // listing) via the shared truncateUtf8 primitive, reusing the
              // same …（已截断） suffix as the live renderer / card budget.
              events.push({
                type: 'tool_result',
                content: truncateUtf8(rawOut, TOOL_RESULT_MAX_BYTES),
                timestamp,
              });
            }
          }
        }

        // Track usage from step-finish parts
        for (const part of msg.parts) {
          if (part.type === 'step-finish' && part.tokens) {
            // Use the last NON-EMPTY step-finish tokens. A long autonomous run
            // can end on a degenerate step (model cut off mid-reasoning) whose
            // step-finish reports all-zero tokens; trusting it would wipe out
            // the run's real per-turn usage (contextLength/input/output/total
            // all render 0). Skip zero-total steps so per-turn usage reflects
            // the last step that actually consumed tokens.
            // ccusage-aligned: cache.write -> cacheCreationTokens.
            // contextLength = input + output + cacheRead + cacheCreation —
            // the unified context-window occupancy contract across all readers
            // (§9.21：末轮 output 已进入历史、下一 prompt 全量携带，与 compact
            // postTokens 水位同语义).
            if ((part.tokens.total ?? 0) !== 0) {
              usage = {
                inputTokens: part.tokens.input,
                outputTokens: part.tokens.output,
                contextLength:
                  (part.tokens.input ?? 0) +
                  (part.tokens.output ?? 0) +
                  (part.tokens.cache?.read ?? 0) +
                  (part.tokens.cache?.write ?? 0),
                cacheReadTokens: part.tokens.cache?.read,
                cacheCreationTokens: part.tokens.cache?.write,
                totalTokens: part.tokens.total,
              };
            }
          }
        }
      }

      // Cumulative (session-wide): sum input/output/total across ALL step-finish
      // parts in the whole session. The catch-up loop above only scans from
      // the last user message (= last run) for per-turn usage; cumulative
      // needs a full scan so multi-run sessions report the true total.
      let cumInput = 0;
      let cumOutput = 0;
      let cumTotal = 0;
      let cumCacheRead = 0;
      let cumCacheWrite = 0;
      for (const msg of data.messages) {
        for (const part of msg.parts) {
          if (part.type === 'step-finish' && part.tokens) {
            cumInput += part.tokens.input ?? 0;
            cumOutput += part.tokens.output ?? 0;
            cumTotal += part.tokens.total ?? 0;
            cumCacheRead += part.tokens.cache?.read ?? 0;
            cumCacheWrite += part.tokens.cache?.write ?? 0;
          }
        }
      }
      usage = withCumulativeUsage(usage, {
        total: cumTotal,
        input: cumInput,
        output: cumOutput,
        cacheRead: cumCacheRead,
        cacheWrite: cumCacheWrite,
      });

      // Use info.title as aiTitle
      if (data.info.title) {
        aiTitle = data.info.title;
      }

      // If no displayTitle yet, use first user text as fallback
      if (!displayTitle) {
        for (const msg of data.messages) {
          if (msg.info.role === 'user') {
            for (const part of msg.parts) {
              if (part.type === 'text' && part.text) {
                displayTitle = part.text;
                break;
              }
            }
          }
          if (displayTitle) break;
        }
      }

      // Apply maxEvents cap: keep the LAST N events (most recent), matching
      // CodexSessionReader's slice(-maxEvents). maxEvents limits the catch-up
      // tail so auto-resume cards don't load the entire session.
      const cappedEvents = capEvents(events, opts?.maxEvents);

      return {
        events: cappedEvents,
        usage,
        // opencode run doesn't have background tasks
        aiTitle,
        displayTitle,
      };
    } catch (err) {
      getLogger().warn(`[opencode-session-reader] readSessionContent build failed: ${err}`);
      return { events: [] };
    }
  }

  /**
   * v2 export: messages are flat (`type` + `text`/`content`) and assistant
   * usage lives on the message instead of a `step-finish` part. Keep this
   * mapping isolated from the v1 parser so v1 behaviour stays unchanged.
   */
  private readV2SessionContent(
    data: OpencodeV2ExportData,
    opts?: { maxEvents?: number },
  ): SessionContent {
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const events: AgentSessionContentEvent[] = [];
    const aiTitle =
      typeof data.info.title === 'string' && data.info.title.length > 0
        ? data.info.title
        : undefined;
    let displayTitle: string | undefined;

    let lastUserIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.type === 'user') lastUserIndex = i;
    }
    const startIndex = lastUserIndex >= 0 ? lastUserIndex : 0;

    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg.type !== 'string') continue;
      const timestamp = msg.time?.created ? new Date(msg.time.created).toISOString() : undefined;

      if (msg.type === 'user') {
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          if (!displayTitle) displayTitle = msg.text;
          events.push({ type: 'text', content: msg.text, timestamp });
        }
        continue;
      }

      if (msg.type === 'assistant') {
        for (const part of Array.isArray(msg.content) ? msg.content : []) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            events.push({ type: 'text', content: part.text, timestamp });
            continue;
          }
          if (part?.type === 'reasoning' && typeof part.text === 'string') {
            events.push({ type: 'thinking', content: part.text, timestamp });
            continue;
          }
          if (part?.type === 'tool') {
            const toolId = part.id;
            const toolName = part.name ?? '';
            const input = parseToolInput(part.state?.input);
            if (toolId) {
              events.push({
                type: 'tool_use',
                content: JSON.stringify({ id: toolId, name: toolName, input }),
                timestamp,
              });
            }

            const output = v2ToolOutput(part.state);
            if (toolId && output !== undefined) {
              events.push({
                type: 'tool_result',
                content: truncateUtf8(output, TOOL_RESULT_MAX_BYTES),
                timestamp,
              });
            }
          }
        }
        continue;
      }

      // User-invoked shell messages are a first-class message type in v2.
      if (msg.type === 'shell' && typeof msg.command === 'string') {
        events.push({
          type: 'tool_use',
          content: JSON.stringify({
            id: msg.callID ?? msg.id ?? 'shell',
            name: 'bash',
            input: { command: msg.command },
          }),
          timestamp,
        });
        if (typeof msg.output === 'string') {
          events.push({
            type: 'tool_result',
            content: truncateUtf8(msg.output, TOOL_RESULT_MAX_BYTES),
            timestamp,
          });
        }
        continue;
      }

      // Keep the compact summary visible in the catch-up tail; other control
      // messages (system/synthetic/agent-switched/model-switched) are noise.
      if (msg.type === 'compaction' && typeof msg.summary === 'string' && msg.summary) {
        events.push({ type: 'text', content: msg.summary, timestamp });
      }
    }

    // If the last user message had no text (e.g. attachment-only), fall back to
    // the first human text anywhere in the session for the card title.
    if (!displayTitle) {
      for (const msg of messages) {
        if (msg?.type === 'user' && typeof msg.text === 'string' && msg.text.length > 0) {
          displayTitle = msg.text;
          break;
        }
      }
    }

    let latest: AgentSessionUsage | undefined;
    let cumInput = 0;
    let cumOutput = 0;
    let cumTotal = 0;
    let cumCacheRead = 0;
    let cumCacheWrite = 0;

    for (const msg of messages) {
      if (msg?.type !== 'assistant' || !msg.tokens) continue;
      const tokens = msg.tokens;
      const cacheRead = tokens.cache?.read ?? 0;
      const cacheWrite = tokens.cache?.write ?? 0;
      const total = tokens.input + tokens.output + tokens.reasoning + cacheRead + cacheWrite;

      cumInput += tokens.input;
      cumOutput += tokens.output;
      cumTotal += total;
      cumCacheRead += cacheRead;
      cumCacheWrite += cacheWrite;

      // A long autonomous run can end on a degenerate assistant message with
      // zero tokens; skip it so the card reflects the last real step.
      if (total !== 0) {
        latest = {
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          // §9.21 口径：含末轮 output（与 postTokens 水位同语义）。
          contextLength: tokens.input + tokens.output + cacheRead + cacheWrite,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheWrite,
          totalTokens: total,
        };
      }
    }

    latest = withCumulativeUsage(latest, {
      total: cumTotal,
      input: cumInput,
      output: cumOutput,
      cacheRead: cumCacheRead,
      cacheWrite: cumCacheWrite,
    });

    return {
      events: capEvents(events, opts?.maxEvents),
      usage: latest,
      aiTitle,
      displayTitle,
    };
  }

  /**
   * Check if a session is active (updated within 1 hour).
   * Passes cwd to fetchSessionList so it returns sessions for the correct directory.
   */
  isSessionActive(sessionId: string, cwd: string): boolean {
    const realCwd = this.realpath(cwd);

    try {
      const entries = this.fetchSessionList(realCwd);
      const entry = entries.find((e) => e.id === sessionId && samePath(e.directory, realCwd));
      if (!entry) return false;

      // Check if updated within STALE_MS
      return !isStale(entry.updated);
    } catch (err) {
      getLogger().debug(
        `[opencode-session-reader] isSessionActive failed session=${sessionId}: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
      return false;
    }
  }
  // --- Private helpers ---

  /** realpath 归一化（public：测试直接调用，替代 as unknown as）。 */
  realpath(cwd: string): string {
    return safeRealpath(cwd, (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      getLogger().debug(
        `[opencode-session-reader] realpath ${cwd} failed, using the path as given: ${
          (err as Error)?.message ?? String(err)
        }`,
      );
    });
  }

  private fetchSessionList(cwd: string): OpencodeSessionListEntry[] {
    const realCwd = this.realpath(cwd);

    const cached = this.listCache.get(realCwd);
    if (cached) {
      return cached;
    }

    try {
      // spawnProcessSync（cross-spawn）而非 execFileSync：opencode 是 npm 安装
      // 的 .cmd 垫片，win32 上 execFileSync 不做 PATHEXT 解析会直接 ENOENT，
      // 会话列表永远为空；cross-spawn 走与 runner spawn 相同的垫片执行路径
      // （posix 为 child_process.spawnSync 直通，行为不变）。
      // Pass cwd to the CLI so opencode returns sessions for the correct directory.
      //
      // v2 runs CLI commands through a shared daemon and defaults the list to
      // 100 entries. `--standalone` keeps this read-only path independent from
      // the user's daemon state; `--max-count` preserves the reader's "all
      // sessions in this cwd" contract. v1 accepts the same list/flags but not
      // `--standalone`, so a failed first attempt falls back to the bare form.
      const listOpts = {
        encoding: 'utf-8',
        timeout: 10000,
        // default maxBuffer is 1MiB — a large session list (>1MiB JSON)
        // throws ENOBUFS, which the catch below silently turns into [] and the
        // user sees "no sessions" even though the CLI returned healthy data.
        maxBuffer: 64 * 1024 * 1024,
        cwd: realCwd, // Key fix: pass user cwd to CLI
        windowsHide: true, // opencode 是 npm .cmd 垫片：不隐藏会闪 cmd.exe 控制台
      } as const;
      const v2Args = [
        'session',
        'list',
        '--format',
        'json',
        '--max-count',
        String(MAX_SESSION_LIST_COUNT),
        '--standalone',
      ];
      const v1Args = [
        'session',
        'list',
        '--format',
        'json',
        '--max-count',
        String(MAX_SESSION_LIST_COUNT),
      ];

      let res = spawnProcessSync(this.binary, v2Args, listOpts) as OpencodeCliResult;
      // `--standalone` is v2-only and can also fail if the private server is
      // temporarily unavailable. Retry once without it: this is the exact v1
      // command shape and also uses the shared daemon on v2.
      if (res.error || res.status !== 0) {
        res = spawnProcessSync(this.binary, v1Args, listOpts) as OpencodeCliResult;
      }
      if (res.error) {
        const enoent = (res.error as NodeJS.ErrnoException).code === 'ENOENT';
        if (enoent) return [];
        throw res.error;
      }
      if (res.status !== 0) {
        const stderr = String(res.stderr ?? '').trim();
        throw new Error(`exit ${res.status}${stderr ? `: ${stderr}` : ''}`);
      }
      const output = String(res.stdout ?? '').trim();
      // CLI returns empty string when no sessions exist - treat as empty array
      if (!output) {
        return [];
      }
      const data = JSON.parse(output) as OpencodeSessionListEntry[];

      // Update cache keyed by cwd
      this.listCache.set(realCwd, data);

      return data;
    } catch (err) {
      // 区分「读取失败」与「真空/陈旧 cwd」。
      // - ENOENT（cwd 已删除或 binary 缺失）：沿用既有契约返回 []——/resume 对
      //   陈旧 cwd 保持优雅（sessions.test.ts「Stale-cwd coverage gap」+ round10
      //   探针的跨 reader 空目录不变量都钉死此行为）。
      // - 其余失败（exit≠0 / ENOBUFS / JSON 解析错误）：上抛可诊断错误，router
      //   显示「读取失败」——静默 [] 会让用户误以为没有 session，与真空不可区分。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      getLogger().error(`[opencode-session-reader] session list failed: ${err}`);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`opencode session list 读取失败: ${msg}`, { cause: err });
    }
  }

  /**
   * Capture raw export output (JSON string). Injectable
   * via the constructor; the default routes stdout to a temp file fd to bypass
   * opencode's ~128KB pipe truncation on large sessions.
   */
  /** 导出会话内容（public：测试直接调用，替代 as unknown as）。 */
  captureExport(sessionId: string): string {
    if (this.captureExportOverride) return this.captureExportOverride(sessionId);
    return this.captureExportViaFileFd(sessionId);
  }

  /**
   * default transport: run the version-appropriate export command with stdout
   * pointed at a
   * regular-file fd (NOT a pipe). opencode truncates piped stdout at ~128KB for
   * large sessions (huge tool_results), breaking JSON.parse; a file fd receives
   * the full output (verified: 1.3MB parses OK). spawnProcessSync returns null
   * stdout when it is redirected to a file fd, so we read the file instead.
   */
  private captureExportViaFileFd(sessionId: string): string {
    // sessionId 经 path.basename 净化：它来自用户 /resume <id> 输入或畸形 CLI
    // 数据，含 / 或 .. 时 path.join 会归一化出 tmpdir 之外的路径（写入内容为
    // CLI stdout，可能截断/覆盖目标文件）。
    const safeId = path.basename(sessionId);
    const tmp = path.join(
      os.tmpdir(),
      `opencode-export-${safeId}-${process.pid}-${Date.now()}.json`,
    );
    let fd: number | undefined;
    try {
      const exportOpts = {
        encoding: 'utf-8',
        timeout: 30000,
        // stderr is piped here; without maxBuffer a chatty CLI (>1MiB
        // stderr) would throw ENOBUFS and lose the export. Keep the default
        // stdout file-fd transport unaffected by raising the pipe cap.
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      } as const;

      const run = (args: string[]): OpencodeCliResult => {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
        fd = fs.openSync(tmp, 'w');
        return spawnProcessSync(this.binary, args, {
          ...exportOpts,
          stdio: ['ignore', fd, 'pipe'],
        }) as OpencodeCliResult;
      };

      // v2 moved export under `session`; v1 only has the top-level command.
      let res = run(['session', 'export', '--standalone', sessionId]);
      if (res.error || res.status !== 0) {
        // v2 without a private server may still work through the shared
        // daemon; on v1 this is another unknown-subcommand response.
        res = run(['session', 'export', sessionId]);
      }
      // Last resort: v1's top-level command. Skip only when the server has
      // already told us the session does not exist (a syntax fallback cannot
      // help and would only add another spawn).
      if ((res.error || res.status !== 0) && !/Session not found/i.test(String(res.stderr ?? ''))) {
        res = run(['export', sessionId]);
      }
      if (res.error) {
        throw res.error;
      }
      if (res.status !== 0) {
        const stderr = String(res.stderr ?? '').trim();
        getLogger().warn(
          `[opencode-session-reader] session export exited ${res.status}${stderr ? `: ${stderr}` : ''}`,
        );
      }
      return fs.readFileSync(tmp, 'utf-8');
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      bestEffortUnlink(tmp);
    }
  }
}
