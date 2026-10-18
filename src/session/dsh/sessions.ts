/**
 * DshSessionReader — AgentSessionReader backed by the DSH Web Host over HTTP.
 *
 * The AgentSessionReader contract is fully synchronous (file-style readers),
 * but DSH exposes only async HTTP. The reader therefore bridges with
 * `spawnSync('curl', ...)` for its unary calls (session/list / session/page)
 * — a synchronous HTTP round-trip to the local DSH host. This keeps the
 * router/bridge interface contract intact without touching any upstream logic.
 *
 * listSessions: session/list → filter by cwd → sort by updatedAt desc → local
 *   pagination (DSH v1 has no cursor pagination).
 * readSessionContent: session/projections → session/page → map SessionEvents +
 *   session-wide usage accumulation (assistant/message.usage).
 */

import { spawnProcessSync } from '../../platform/spawn.js';
import { cumulativeUsageFields } from '../common/usage-accumulator.js';
import { sortByRecencyDesc } from '../common/recency.js';
import { getLogger } from '../../logger/index.js';
import { DEFAULT_DSH_HOST } from '../../config/index.js';
import { samePath } from '../../platform/path.js';
import { isWin32 } from '../../platform/select.js';
import type {
  AgentSession,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
  AgentSessionContentEvent,
} from '../../runner/index.js';
import type {
  DshSessionEvent,
  DshSessionListValue,
  DshSessionPageValue,
  DshSessionSummary,
  DshTokenUsage,
} from '../../runner/dsh/types.js';
import { dshArgs, extractDshToken } from '../../runner/dsh/client.js';
import {
  DSH_COOKIE_LIFETIME_MS,
  isDshCredentialsNotFound,
  mintDshBrowserCookie,
  readDshBrowserSecretSync,
  resolveDshCredentialsFile,
} from '../../runner/dsh/auth.js';
import { capEvents, paginate } from '../common/pagination.js';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';

/**
 * history 拉取上限。DSH session/page 的 maxMessages 同时限制返回条数，
 * 若用它同时充当展示截断，>50 事件的会话累计 usage 会少算。这里拉取一个足够大的
 * 上限保证 usage 累加覆盖整个会话；展示仍由 capEvents(opts?.maxEvents ?? 50) 截断。
 * （若 DSH 支持分页 cursor 可改成分页，当前用有界大拉取）
 */
const DSH_HISTORY_FETCH_LIMIT = 10_000;

interface DshSessionReaderOptions {
  host?: string;
  /** Configured DSH home; selects `.credentials.yaml` when credentialsFile is unset. */
  dshHomeProvider?: () => string | undefined;
  /** `dsh web` launch token (or its startup URL). */
  token?: string;
  /** DSH credentials file with the durable browser-session signing secret. */
  credentialsFile?: string;
  /** Resolve the credentials file on every call (hot /config change). */
  credentialsFileProvider?: () => string | undefined;
  /** Injectable synchronous credentials reader (tests). */
  readCredentials?: (file: string) => Buffer;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Lifetime of minted browser cookies. */
  cookieLifetimeMs?: number;
  /** Resolve the current token on every call (hot /config change). */
  tokenProvider?: () => string | undefined;
  /** 每次调用时解析当前 host（/config 修改 host 后 runner 重建、reader 也跟随新 host）。
   *  优先于固定的 `host`。 */
  hostProvider?: () => string | undefined;
  /** Injectable synchronous unary transport. Defaults to spawnSync curl. */
  syncRequest?: (baseUrl: string, method: string, payload: unknown, cookie?: string) => unknown;
  /** Injectable synchronous launch-token bootstrap (tests). */
  syncConnect?: (baseUrl: string, token: string) => string;
}

/** Synchronous unary POST via curl (the reader interface is synchronous). */
function defaultSyncRequest(
  baseUrl: string,
  method: string,
  payload: unknown,
  cookie?: string,
): unknown {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    method,
    payload: { args: dshArgs(method, payload) },
  });
  const res = spawnProcessSync(
    'curl',
    [
      '-s',
      '-X',
      'POST',
      `${baseUrl}/api/${method}`,
      '-H',
      'content-type: application/json',
      ...(cookie ? ['-H', `Cookie: ${cookie}`] : []),
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
    parsed = JSON.parse(String(res.stdout)) as typeof parsed;
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

/** Synchronous index bootstrap; returns the v1 `name=value` cookie pair. */
function defaultSyncConnect(baseUrl: string, token: string): string {
  const url = `${baseUrl}/?token=${encodeURIComponent(token)}`;
  const res = spawnProcessSync(
    'curl',
    ['-sS', '-D', '-', '-o', isWin32() ? 'NUL' : '/dev/null', '--max-time', '5', url],
    { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  if (res.error || res.status !== 0) {
    throw new Error(`DSH auth failed: ${(res.error?.message ?? res.stderr) || 'unknown'}`);
  }
  const header = String(res.stdout);
  const match = header.match(/^set-cookie:\s*(.+)$/im);
  const cookie = match?.[1]?.split(';')[0]?.trim();
  if (!cookie) throw new Error('DSH auth failed: index handshake did not return a cookie');
  return cookie;
}

export class DshSessionReader implements AgentSessionReader {
  private readonly hostProvider: () => string | undefined;
  private readonly dshHomeProvider: () => string | undefined;
  private readonly tokenProvider: () => string | undefined;
  private readonly credentialsFileProvider: () => string | undefined;
  private readonly readCredentials: (file: string) => Buffer;
  private readonly now: () => number;
  private readonly cookieLifetimeMs: number;
  private readonly syncRequest: (
    baseUrl: string,
    method: string,
    payload: unknown,
    cookie?: string,
  ) => unknown;
  private readonly syncConnect: (baseUrl: string, token: string) => string;
  private readonly cookieCache = new Map<string, string>();

  constructor(opts: DshSessionReaderOptions = {}) {
    const fixed = (opts.host ?? DEFAULT_DSH_HOST).replace(/\/$/, '');
    this.hostProvider = opts.hostProvider ?? (() => fixed);
    this.dshHomeProvider = opts.dshHomeProvider ?? (() => undefined);
    const fixedToken = opts.token;
    this.tokenProvider = opts.tokenProvider ?? (() => fixedToken);
    const fixedCredentialsFile = opts.credentialsFile;
    this.credentialsFileProvider = opts.credentialsFileProvider ?? (() => fixedCredentialsFile);
    this.readCredentials = opts.readCredentials ?? readDshBrowserSecretSync;
    this.now = opts.now ?? Date.now;
    this.cookieLifetimeMs = opts.cookieLifetimeMs ?? DSH_COOKIE_LIFETIME_MS;
    this.syncRequest = opts.syncRequest ?? defaultSyncRequest;
    this.syncConnect = opts.syncConnect ?? defaultSyncConnect;
  }

  /** 解析当前 host（hostProvider 优先，允许 /config 热改 host）。 */
  private resolveBaseUrl(): string {
    const host = this.hostProvider();
    return (host && host.length > 0 ? host : DEFAULT_DSH_HOST).replace(/\/$/, '');
  }

  private resolveCredentialsFile(): string {
    return (
      this.credentialsFileProvider()?.trim() ||
      resolveDshCredentialsFile(process.env, this.dshHomeProvider())
    );
  }

  private unary(method: string, payload: unknown): unknown {
    const baseUrl = this.resolveBaseUrl();
    try {
      return this.syncRequest(baseUrl, method, payload, this.resolveCookie());
    } catch {
      // DSH may have restarted while lark-remote cached a token-derived cookie.
      // Re-read the credentials file and retry once with a fresh cookie.
      this.cookieCache.clear();
      return this.syncRequest(baseUrl, method, payload, this.resolveCookie());
    }
  }

  /** Mint from the durable secret, or bootstrap and cache a token cookie. */
  private resolveCookie(): string | undefined {
    const baseUrl = this.resolveBaseUrl();
    const fromCredentials = this.cookieFromCredentials(baseUrl);
    if (fromCredentials) return fromCredentials;
    const token = extractDshToken(this.tokenProvider());
    if (!token) return undefined;
    const key = `${baseUrl}\u0000${token}`;
    const cached = this.cookieCache.get(key);
    if (cached) return cached;
    const cookie = this.syncConnect(baseUrl, token);
    this.cookieCache.set(key, cookie);
    return cookie;
  }

  private cookieFromCredentials(baseUrl: string): string | undefined {
    const credentialsFile = this.resolveCredentialsFile();
    try {
      const secret = this.readCredentials(credentialsFile);
      return mintDshBrowserCookie(baseUrl, secret, this.now(), this.cookieLifetimeMs);
    } catch (err) {
      if (isDshCredentialsNotFound(err)) return undefined;
      if (extractDshToken(this.tokenProvider())) {
        getLogger().warn(
          `[dsh-session-reader] cannot use DSH credentials file ${credentialsFile}: ` +
            `${(err as Error).message}; falling back to the launch token`,
        );
        return undefined;
      }
      throw new Error(`DSH auth credentials file ${credentialsFile}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    try {
      const value = this.unary('session/list', {}) as DshSessionListValue;
      const items = value.items ?? [];
      const filtered = items
        .filter((i) => i.cwd !== undefined && samePath(i.cwd, cwd))
        .map((i) => ({
          sessionId: String(i.sessionId),
          summary: '',
          mtime: i.updatedAt,
          ...sessionPreset(i),
        }));
      sortByRecencyDesc(
        filtered,
        (i) => i.mtime,
        (i) => i.sessionId,
      );
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
      // cwd 守卫：sessionId 可能属于另一个 workspace。
      // 只按 id 查 history 会让 /resume 把 cwd A 的卡片绑到 cwd B 的会话上，
      // agent 实际在 B 操作文件、resume.compact 还会压缩别人的会话。与
      // Claude/Kimi/Pi 的 cwd 守卫同口径：找不到同 cwd 的会话 → 空内容（fail-closed）。
      const session = this.resolveSession(sessionId, cwd);
      if (!session) {
        getLogger().warn(
          `[dsh-session-reader] readSessionContent: session ${sessionId} not found in cwd ${cwd}, refusing cross-workspace read`,
        );
        return { events: [] };
      }
      const throughSeq = this.resolveThroughSeq(sessionId, session);
      const value = this.unary('session/page', {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages: DSH_HISTORY_FETCH_LIMIT,
      }) as DshSessionPageValue;
      const events: AgentSessionContentEvent[] = [];
      let displayTitle: string | undefined;
      let cumInput = 0;
      let cumOutput = 0;
      let cumCacheRead = 0;
      let cumCacheWrite = 0;
      let lastUsage: DshTokenUsage | undefined;

      for (const entry of value.records ?? []) {
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
          // with usage (ccusage/`last_token_usage` 口径, 架构文档 §9.21) — a
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
          ...cumulativeUsageFields({
            input: cumInput,
            output: cumOutput,
            cacheRead: cumCacheRead,
            cacheCreation: cumCacheWrite,
          }),
        };
      }

      return {
        // 展示仍按 maxEvents 尾截断（默认 50，保持原行为），usage 已在上面基于
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
      return this.resolveSession(sessionId, cwd)?.running === true;
    } catch (error) {
      getLogger().error(`[dsh-session-reader] isSessionActive error: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Find the session row in `session/list` that matches BOTH id and cwd.
   * Returns undefined when the id belongs to another workspace (or is unknown) —
   * every caller treats that as "not usable here".
   */
  private resolveSession(sessionId: string, cwd: string): DshSessionSummary | undefined {
    const value = this.unary('session/list', {}) as DshSessionListValue;
    return (value.items ?? []).find(
      (i) => String(i.sessionId) === sessionId && i.cwd !== undefined && samePath(i.cwd, cwd),
    );
  }

  /** `session/page` needs an inclusive cursor; projections carry the watermark. */
  private resolveThroughSeq(sessionId: string, known?: DshSessionSummary): number {
    const projection = this.unary('session/projections', { sessionId }) as {
      asOfSeq?: number;
    } | null;
    if (typeof projection?.asOfSeq === 'number') return projection.asOfSeq;
    const row =
      known ??
      (this.unary('session/list', {}) as DshSessionListValue).items?.find(
        (item) => String(item.sessionId) === sessionId,
      );
    return typeof row?.projections?.asOfSeq === 'number' ? row.projections.asOfSeq : -1;
  }
}

/** Preset moved from the summary top level to projections in DSH 0.2.x. */
function sessionPreset(item: {
  agentPreset?: string;
  projections?: { values?: { agentPreset?: string | null } };
}): {
  agentPreset?: string;
} {
  const preset = item.projections?.values?.agentPreset ?? item.agentPreset;
  return preset ? { agentPreset: preset } : {};
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
