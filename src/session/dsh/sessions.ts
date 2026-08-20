/**
 * DshSessionReader — AgentSessionReader backed by the DSH Web Host over HTTP.
 *
 * The AgentSessionReader contract is fully synchronous (file-style readers),
 * but DSH exposes only async HTTP. The reader therefore bridges with
 * `spawnSync('curl', ...)` for its unary calls (session.list / session.history)
 * — a synchronous HTTP round-trip to the local DSH host. This keeps the
 * router/bridge interface contract intact without touching any upstream logic.
 *
 * listSessions: session.list → filter by cwd → sort by updatedAt desc → local
 *   pagination (DSH v1 has no cursor pagination).
 * readSessionContent: session.history → map SessionEvents to display events +
 *   session-wide usage accumulation (assistant/message.usage).
 */

import { spawnSync } from 'node:child_process';
import { getLogger } from '../../logger/index.js';
import { DEFAULT_DSH_HOST } from '../../config/index.js';
import type {
  AgentSession,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
  AgentSessionContentEvent,
} from '../../runner/index.js';
import type {
  DshSessionEvent,
  DshSessionHistoryValue,
  DshSessionListValue,
  DshTokenUsage,
} from '../../runner/dsh/types.js';
import { capEvents, paginate } from '../common/pagination.js';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';

/**
 * CC-05: history 拉取上限。DSH session.history 的 maxMessages 同时限制返回条数，
 * 若用它同时充当展示截断，>50 事件的会话累计 usage 会少算。这里拉取一个足够大的
 * 上限保证 usage 累加覆盖整个会话；展示仍由 capEvents(opts?.maxEvents ?? 50) 截断。
 * （若 DSH 支持分页 cursor 可改成分页，当前用有界大拉取，见 review-fix-plan-cc.md）
 */
const DSH_HISTORY_FETCH_LIMIT = 10_000;

interface DshSessionReaderOptions {
  host?: string;
  /** 每次调用时解析当前 host（/config 修改 host 后 runner 重建、reader 也跟随新 host）。
   *  优先于固定的 `host`。 */
  hostProvider?: () => string | undefined;
  /** Injectable synchronous unary transport. Defaults to spawnSync curl. */
  syncRequest?: (baseUrl: string, method: string, payload: unknown) => unknown;
}

/** Synchronous unary POST via curl (the reader interface is synchronous). */
function defaultSyncRequest(baseUrl: string, method: string, payload: unknown): unknown {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    method,
    payload,
  });
  const res = spawnSync(
    'curl',
    [
      '-s',
      '-X',
      'POST',
      `${baseUrl}/api/${method}`,
      '-H',
      'content-type: application/json',
      '--data',
      body,
    ],
    { encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error || res.status !== 0) {
    throw new Error(`DSH ${method} failed: ${(res.error?.message ?? res.stderr) || 'unknown'}`);
  }
  let parsed: { result?: { ok?: boolean; value?: unknown; error?: { message?: string } } };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch (err) {
    throw new Error(`DSH ${method} returned non-JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (parsed.result?.ok !== true) {
    throw new Error(parsed.result?.error?.message ?? `DSH ${method} failed`);
  }
  return parsed.result.value;
}

export class DshSessionReader implements AgentSessionReader {
  private readonly hostProvider: () => string | undefined;
  private readonly syncRequest: (baseUrl: string, method: string, payload: unknown) => unknown;

  constructor(opts: DshSessionReaderOptions = {}) {
    const fixed = (opts.host ?? DEFAULT_DSH_HOST).replace(/\/$/, '');
    this.hostProvider = opts.hostProvider ?? (() => fixed);
    this.syncRequest = opts.syncRequest ?? defaultSyncRequest;
  }

  /** 解析当前 host（hostProvider 优先，允许 /config 热改 host）。 */
  private resolveBaseUrl(): string {
    const host = this.hostProvider();
    return (host && host.length > 0 ? host : DEFAULT_DSH_HOST).replace(/\/$/, '');
  }

  private unary(method: string, payload: unknown): unknown {
    return this.syncRequest(this.resolveBaseUrl(), method, payload);
  }

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    try {
      const value = this.unary('session.list', {}) as DshSessionListValue;
      const items = value.items ?? [];
      const filtered = items
        .filter((i) => i.cwd === cwd)
        .sort(
          (a, b) =>
            b.updatedAt - a.updatedAt || String(a.sessionId).localeCompare(String(b.sessionId)),
        )
        .map((i) => ({
          sessionId: String(i.sessionId),
          summary: '',
          mtime: i.updatedAt,
          ...(i.agentPreset ? { agentPreset: i.agentPreset } : {}),
        }));
      const { items: page, total } = paginate(filtered, opts ?? {});
      return { sessions: page, total };
    } catch (error) {
      getLogger().error(`[dsh-session-reader] listSessions error: ${(error as Error).message}`);
      return { sessions: [], total: 0 };
    }
  }

  getNewestSession(cwd: string): AgentSession | null {
    return this.listSessions(cwd, { limit: 1 }).sessions[0] ?? null;
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    try {
      const value = this.unary('session.history', {
        sessionId,
        maxMessages: DSH_HISTORY_FETCH_LIMIT,
      }) as DshSessionHistoryValue;
      const events: AgentSessionContentEvent[] = [];
      let displayTitle: string | undefined;
      let cumInput = 0;
      let cumOutput = 0;
      let cumCacheRead = 0;
      let cumCacheWrite = 0;
      let lastUsage: DshTokenUsage | undefined;

      for (const entry of value.events ?? []) {
        const ev = entry.event;
        if (!ev) continue;
        const contentEvents = mapEvent(ev);
        events.push(...contentEvents.events);
        if (contentEvents.title) displayTitle = contentEvents.title;
        const u = contentEvents.usage;
        if (u) {
          // Cumulative (session-wide): sum across ALL assistant/message usage.
          cumInput += u.inputTokens ?? 0;
          cumOutput += u.outputTokens ?? 0;
          cumCacheRead += u.cacheReadTokens ?? 0;
          cumCacheWrite += u.cacheWriteTokens ?? 0;
          // Per-turn "current window" fields reflect the LAST assistant/message
          // with usage (ccusage/`last_token_usage` 口径, AGENTS.md §9.21) — a
          // multi-turn session's current context water-mark is the last turn's,
          // not the accumulated total.
          lastUsage = u;
        }
      }

      let sessionUsage: AgentSessionUsage | undefined;
      if (lastUsage) {
        const input = lastUsage.inputTokens ?? 0;
        const output = lastUsage.outputTokens ?? 0;
        const cacheRead = lastUsage.cacheReadTokens ?? 0;
        const cacheWrite = lastUsage.cacheWriteTokens ?? 0;
        sessionUsage = {
          inputTokens: input,
          outputTokens: output,
          contextLength: input + cacheRead + cacheWrite,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheWrite,
          totalTokens: input + output + cacheRead + cacheWrite,
          cumulativeTotalTokens: cumInput + cumOutput + cumCacheRead + cumCacheWrite,
          cumulativeInputTokens: cumInput,
          cumulativeOutputTokens: cumOutput,
          cumulativeCacheReadTokens: cumCacheRead,
          cumulativeCacheCreationTokens: cumCacheWrite,
        };
      }

      return {
        // CC-05: 展示仍按 maxEvents 尾截断（默认 50，保持原行为），usage 已在上面基于
        // 完整 history 累加。
        events: capEvents(events, opts?.maxEvents ?? 50),
        ...(sessionUsage ? { usage: sessionUsage } : {}),
        ...(displayTitle ? { displayTitle } : {}),
      };
    } catch (error) {
      getLogger().error(
        `[dsh-session-reader] readSessionContent error: ${(error as Error).message}`,
      );
      return { events: [] };
    }
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    try {
      const value = this.unary('session.list', {}) as DshSessionListValue;
      const found = (value.items ?? []).find(
        (i) => String(i.sessionId) === sessionId && i.cwd === cwd,
      );
      return found?.running === true;
    } catch (error) {
      getLogger().error(`[dsh-session-reader] isSessionActive error: ${(error as Error).message}`);
      return false;
    }
  }
}

interface MappedEvent {
  events: AgentSessionContentEvent[];
  title?: string;
  usage?: DshTokenUsage;
}

/** Map one DSH SessionEvent to display content events (+ title/usage side effects). */
function mapEvent(ev: DshSessionEvent): MappedEvent {
  const out: MappedEvent = { events: [] };
  switch (ev.type) {
    case 'user/message': {
      const content = (ev.data.content as { type?: string; text?: string }[] | undefined) ?? [];
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      out.events.push({ type: 'user', content: text, timestamp: new Date(ev.time).toISOString() });
      break;
    }
    case 'assistant/message': {
      const content =
        (ev.data.message as { content?: { type?: string; text?: string }[] } | undefined)
          ?.content ?? [];
      const text = content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (text)
        out.events.push({
          type: 'assistant',
          content: text,
          timestamp: new Date(ev.time).toISOString(),
        });
      const usage = ev.data.usage as DshTokenUsage | undefined;
      if (usage && typeof usage === 'object') out.usage = usage;
      break;
    }
    case 'tool/call': {
      const name = String(ev.data.name ?? '');
      const args = typeof ev.data.arguments === 'string' ? ev.data.arguments : '';
      out.events.push({
        type: 'tool_use',
        content: `${name}(${truncateUtf8(args, 200)})`,
        timestamp: new Date(ev.time).toISOString(),
      });
      break;
    }
    case 'tool/result': {
      const msg = ev.data.message as { content?: unknown } | undefined;
      const raw = stringifyContent(msg?.content);
      out.events.push({
        type: 'tool_result',
        content: truncateUtf8(raw, TOOL_RESULT_MAX_BYTES),
        timestamp: new Date(ev.time).toISOString(),
      });
      break;
    }
    default:
      break;
  }
  return out;
}

function stringifyContent(content: unknown): string {
  if (content == null) return '[tool result]';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && 'text' in c
          ? String((c as { text: unknown }).text)
          : JSON.stringify(c),
      )
      .join('');
  }
  return JSON.stringify(content);
}
