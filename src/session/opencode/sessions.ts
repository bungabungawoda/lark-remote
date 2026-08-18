/**
 * OpencodeSessionReader: CLI-based session reader using `opencode session list` and `opencode export`.
 *
 * Design:
 * - Uses official CLI commands instead of HTTP API.
 * - `opencode session list --format json` returns sessions with `directory` field (first-class citizen).
 * - `opencode export <sessionID>` returns full session content.
 * - Independent of runner (no setRunner circular dependency).
 *
 * Key features:
 * - listSessions: filter by directory field (the canonical session metadata).
 * - readSessionContent: extract catch-up tail from export messages.
 * - isSessionActive: use `updated` timestamp with 1 hour stale window.
 * - Simple memory cache with TTL.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { silentlyUnlink } from '../../common/fs.js';
import os from 'node:os';
import path from 'node:path';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';
import { getLogger } from '../../logger/index.js';
import type {
  AgentSession,
  AgentSessionReader,
  SessionContent,
  AgentSessionContentEvent,
  AgentSessionUsage,
} from '../../runner/index.js';

interface OpencodeSessionReaderOptions {
  /** Cache TTL for session list (ms). Default: 10_000. */
  cacheTtlMs?: number;
  /**
   * Override the raw `opencode export <id>` capture (returns the JSON string).
   * Default routes stdout to a temp file fd to bypass opencode's ~128KB pipe
   * truncation on large sessions (L1). Injectable for testing.
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
    title: string;
    directory: string;
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

import { STALE_MS } from '../common/constants.js';
import { paginate, capEvents } from '../common/pagination.js';

export class OpencodeSessionReader implements AgentSessionReader {
  private readonly binary: string;
  private readonly cacheTtlMs: number;
  /** Optional raw-export capture override (testing / alt transport). */
  private readonly captureExportOverride?: (sessionId: string) => string;
  /** Cache keyed by cwd - each cwd has its own cache entry */
  /** cwd → 列表缓存（public：测试直接断言缓存形状，替代 as unknown as）。 */
  listCache = new Map<string, { ts: number; data: OpencodeSessionListEntry[] }>();

  constructor(opts: OpencodeSessionReaderOptions = {}) {
    this.binary = 'opencode';
    this.cacheTtlMs = opts.cacheTtlMs ?? 10_000;
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
    const filtered = entries.filter((e) => e.directory === realCwd);

    // Sort by updated descending; same-updated ties use id as a deterministic
    // secondary key so CLI/list-cache rebuilds never reorder the page.
    filtered.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));

    // Compute total over the full sorted set, then paginate.
    const { items, total } = paginate(filtered, opts ?? {});

    return {
      sessions: items.map((e) => ({
        sessionId: e.id,
        // CLI title 字段形状不保证恒为 string（null/缺字段时 router 的
        // s.summary.trim() 会 TypeError）——非 string 给空串（Review R3 P3-3）。
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
    return this.listSessions(cwd, { limit: 1 }).sessions[0] ?? null;
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

    // L1/L3: capture raw export via the injectable seam, then parse. Distinguish
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
    let data: OpencodeExportData;
    try {
      data = JSON.parse(trimmed) as OpencodeExportData;
    } catch (err) {
      getLogger().warn(
        `[opencode-session-reader] export JSON parse failed (truncated/corrupt?), raw bytes=${trimmed.length}: ${err}`,
      );
      return { events: [] };
    }

    try {
      if (data.info.directory !== realCwd) {
        return { events: [] };
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
              // L2: pre-fold pathological tool_results (e.g. a 500KB file
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
            // contextLength = input + cacheRead + cacheCreation (excludes
            // output/reasoning) — the unified context-window occupancy
            // contract across all five readers (review P2-8).
            if ((part.tokens.total ?? 0) !== 0) {
              usage = {
                inputTokens: part.tokens.input,
                outputTokens: part.tokens.output,
                contextLength:
                  part.tokens.input +
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
      if (usage) {
        usage.cumulativeTotalTokens = cumTotal;
        usage.cumulativeInputTokens = cumInput;
        usage.cumulativeOutputTokens = cumOutput;
        usage.cumulativeCacheReadTokens = cumCacheRead;
        usage.cumulativeCacheCreationTokens = cumCacheWrite;
      } else if (cumInput || cumOutput || cumTotal || cumCacheRead || cumCacheWrite) {
        usage = {
          inputTokens: 0,
          outputTokens: 0,
          contextLength: 0,
          cumulativeTotalTokens: cumTotal,
          cumulativeInputTokens: cumInput,
          cumulativeOutputTokens: cumOutput,
          cumulativeCacheReadTokens: cumCacheRead,
          cumulativeCacheCreationTokens: cumCacheWrite,
        };
      }

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
   * Check if a session is active (updated within 1 hour).
   * Passes cwd to fetchSessionList so it returns sessions for the correct directory.
   */
  isSessionActive(sessionId: string, cwd: string): boolean {
    const realCwd = this.realpath(cwd);

    try {
      const entries = this.fetchSessionList(realCwd);
      const entry = entries.find((e) => e.id === sessionId && e.directory === realCwd);
      if (!entry) return false;

      // Check if updated within STALE_MS
      return Date.now() - entry.updated < STALE_MS;
    } catch {
      return false;
    }
  }
  // --- Private helpers ---

  /** realpath 归一化（public：测试直接调用，替代 as unknown as）。 */
  realpath(cwd: string): string {
    try {
      return fs.realpathSync(cwd);
    } catch {
      return cwd;
    }
  }

  private fetchSessionList(cwd: string): OpencodeSessionListEntry[] {
    const realCwd = this.realpath(cwd);

    const cached = this.listCache.get(realCwd);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      // Pass cwd to execFileSync so opencode CLI returns sessions for the correct directory
      const output = execFileSync(this.binary, ['session', 'list', '--format', 'json'], {
        encoding: 'utf-8',
        timeout: 10000,
        // P1-15: default maxBuffer is 1MiB — a large session list (>1MiB JSON)
        // throws ENOBUFS, which the catch below silently turns into [] and the
        // user sees "no sessions" even though the CLI returned healthy data.
        maxBuffer: 64 * 1024 * 1024,
        cwd: realCwd, // Key fix: pass user cwd to CLI
      }).trim();
      // CLI returns empty string when no sessions exist - treat as empty array
      if (!output) {
        return [];
      }
      const data = JSON.parse(output) as OpencodeSessionListEntry[];

      // Update cache keyed by cwd
      this.listCache.set(realCwd, { ts: Date.now(), data });

      return data;
    } catch (err) {
      // P1-15: 区分「读取失败」与「真空/陈旧 cwd」。
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
   * Capture raw `opencode export <sessionId>` output (JSON string). Injectable
   * via the constructor; the default routes stdout to a temp file fd to bypass
   * opencode's ~128KB pipe truncation on large sessions (L1).
   */
  /** 导出会话内容（public：测试直接调用，替代 as unknown as）。 */
  captureExport(sessionId: string): string {
    if (this.captureExportOverride) return this.captureExportOverride(sessionId);
    return this.captureExportViaFileFd(sessionId);
  }

  /**
   * L1 default transport: run `opencode export` with stdout pointed at a
   * regular-file fd (NOT a pipe). opencode truncates piped stdout at ~128KB for
   * large sessions (huge tool_results), breaking JSON.parse; a file fd receives
   * the full output (verified: 1.3MB parses OK). execFileSync returns null when
   * stdout is not a pipe, so we read the file instead.
   */
  private captureExportViaFileFd(sessionId: string): string {
    const tmp = path.join(
      os.tmpdir(),
      `opencode-export-${sessionId}-${process.pid}-${Date.now()}.json`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'w');
      execFileSync(this.binary, ['export', sessionId], {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', fd, 'pipe'],
        // P1-15: stderr is piped here; without maxBuffer a chatty CLI (>1MiB
        // stderr) would throw ENOBUFS and lose the export. Keep the default
        // stdout file-fd transport unaffected by raising the pipe cap.
        maxBuffer: 64 * 1024 * 1024,
      });
      return fs.readFileSync(tmp, 'utf-8');
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      silentlyUnlink(tmp);
    }
  }
}
