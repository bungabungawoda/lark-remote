/**
 * DshSessionReader — AgentSessionReader backed by the DSH Web Host over HTTP.
 *
 * The AgentSessionReader contract is fully synchronous (file-style readers),
 * but DSH exposes only async HTTP. The reader therefore bridges with
 * `spawnSync('curl', ...)` for its unary calls (session/list / session/page)
 * — a synchronous HTTP round-trip to the local DSH host. This keeps the
 * router/bridge interface contract intact without touching any upstream logic.
 *
 * listSessions: session/list → 排除 subagent 派生会话 → filter by cwd → sort by
 *   updatedAt desc → local pagination (DSH v1 has no cursor pagination).
 * readSessionContent: session/projections → session/page → map SessionEvents +
 *   session-wide usage accumulation (assistant/message.usage)；本 run 的 flow
 *   字段 = 末个 turn（turn/start–turn/end）内所有采样之和，与 codex 同口径。
 */

import { spawnProcessSync } from '../../platform/spawn.js';
import { cumulativeUsageFields } from '../common/usage-accumulator.js';
import { newestOf, sortByRecencyDesc } from '../common/recency.js';
import { getLogger } from '../../logger/index.js';
import { DEFAULT_DSH_HOST } from '../../config/index.js';
import { samePath } from '../../platform/path.js';
import { isWin32 } from '../../platform/select.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionReader,
  AgentSessionUsage,
  SessionContent,
  SessionSummary,
} from '../../session-contract.js';
import type {
  DshSessionEvent,
  DshSessionListValue,
  DshSessionPageValue,
  DshSessionSummary,
  DshTokenUsage,
} from '../../dsh/types.js';
import { dshArgs, extractDshToken } from '../../dsh/protocol.js';
import {
  DSH_COOKIE_LIFETIME_MS,
  isDshCredentialsNotFound,
  mintDshBrowserCookie,
  readDshBrowserSecretSync,
  resolveDshCredentialsFile,
} from '../../dsh/auth.js';
import { capEvents, paginate } from '../common/pagination.js';
import { truncateUtf8, TOOL_RESULT_MAX_BYTES } from '../../common/truncate.js';
import { summarizeToolInput } from '../../common/tool-summary.js';

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

/** spawnProcessSync 的返回形态（两个默认传输共用）。 */
type DshSpawnResult = ReturnType<typeof spawnProcessSync>;

/** curl 传输层失败（spawn error / 非零退出）→ 统一错误；成功返回 undefined。 */
function dshSpawnFailure(prefix: string, res: DshSpawnResult): Error | undefined {
  if (res.error || res.status !== 0) {
    return new Error(`${prefix}: ${(res.error?.message ?? res.stderr) || 'unknown'}`);
  }
  return undefined;
}

/** 从 curl stdout 拆出末尾 HTTP 状态码与 body（`--write-out \n%{http_code}`）。 */
function splitDshHttpResponse(raw: string): { httpStatus?: number; bodyText: string } {
  const statusMatch = /\n(\d{3})$/.exec(raw);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  const bodyText = statusMatch ? raw.slice(0, statusMatch.index) : raw;
  return { httpStatus, bodyText };
}

/** 解析 result 信封；非 JSON / ok!==true 按原文案抛错。 */
function parseDshResult(method: string, bodyText: string): unknown {
  let parsed: { result?: { ok?: boolean; value?: unknown; error?: { message?: string } } };
  try {
    parsed = JSON.parse(bodyText) as typeof parsed;
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

/** 从 `-D -` 响应头里取第一条 set-cookie 的 name=value 段。 */
function firstSetCookie(header: string): string | undefined {
  const match = header.match(/^set-cookie:\s*(.+)$/im);
  return match?.[1]?.split(';')[0]?.trim();
}

/** 重试仍失败：二次错为 cause，首错（cookie 失效）作为根因写进 message。 */
function cookieRefreshFailure(method: string, first: unknown, second: unknown): Error {
  const firstMsg = (first as Error)?.message ?? String(first);
  const secondMsg = (second as Error)?.message ?? String(second);
  // 重试仍失败：首错（cookie 失效）才是根因。`cause` 必须是本次捕获的 err
  // （lint preserve-caught-error），所以根因写进 message 一并留痕。
  return new Error(
    `DSH ${method} failed after cookie refresh: ${secondMsg} (root cause: ${firstMsg})`,
    { cause: second },
  );
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
      // 末尾追加 HTTP 状态码：401/403 要与「偶发失败」区分（cookie 失效才值得重试）。
      '--write-out',
      '\n%{http_code}',
    ],
    { encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const failure = dshSpawnFailure(`DSH ${method} failed`, res);
  if (failure) throw failure;
  const { httpStatus, bodyText } = splitDshHttpResponse(String(res.stdout));
  if (httpStatus === 401 || httpStatus === 403) {
    throw new Error(`DSH ${method} unauthorized (HTTP ${httpStatus})`);
  }
  return parseDshResult(method, bodyText);
}

/** Synchronous index bootstrap; returns the v1 `name=value` cookie pair. */
function defaultSyncConnect(baseUrl: string, token: string): string {
  const url = `${baseUrl}/?token=${encodeURIComponent(token)}`;
  const res = spawnProcessSync(
    'curl',
    ['-sS', '-D', '-', '-o', isWin32() ? 'NUL' : '/dev/null', '--max-time', '5', url],
    { encoding: 'utf-8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const failure = dshSpawnFailure('DSH auth failed', res);
  if (failure) throw failure;
  const cookie = firstSetCookie(String(res.stdout));
  if (!cookie) throw new Error('DSH auth failed: index handshake did not return a cookie');
  return cookie;
}

/** Cookie 失效的判定：HTTP 401/403 或服务端回报 unauthorized/forbidden。 */
function isAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[ -]?cookie/i.test(msg);
}

/** 列表行 / `session/projections` 里本仓库消费的投影值。 */
type DshProjectionValues = NonNullable<DshSessionSummary['projections']>['values'];

export class DshSessionReader implements AgentSessionReader {
  /** DSH session/page 没有 compactCount；compact 收尾不应因此重试读取。 */
  readonly supportsCompactCount = false;
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
    } catch (first) {
      // 只有 cookie 失效值得清缓存重试。404/500/timeout 重试会让 /resume 延迟
      // 翻倍，且第二次错误会盖掉真正的根因。
      if (!isAuthFailure(first)) throw first;
      getLogger().warn(
        `[dsh-session-reader] ${method} auth failed, refreshing cookie and retrying: ${
          (first as Error)?.message ?? String(first)
        }`,
      );
      this.cookieCache.clear();
      try {
        return this.syncRequest(baseUrl, method, payload, this.resolveCookie());
      } catch (second) {
        throw cookieRefreshFailure(method, first, second);
      }
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
        .filter((i) => !isSubagentSession(i))
        .filter((i) => i.cwd !== undefined && samePath(i.cwd, cwd))
        .map((i) => ({
          sessionId: String(i.sessionId),
          mtime: i.updatedAt,
          ...sessionPreset(i),
          ...sessionPreview(i.projections?.values),
        }));
      sortByRecencyDesc(
        filtered,
        (i) => i.mtime,
        (i) => i.sessionId,
      );
      const { items: page, total } = paginate(filtered, opts ?? {});
      return { sessions: page, total };
    } catch (error) {
      // 远端 RPC 没有真空态：daemon 未启动 / cookie 失效 / 超时全是故障态。
      // error 日志 + 上抛，router 显示「列表失败」——静默 [] 会让用户误以为
      // 没有 session，与真空不可区分（与 kimi/opencode 同口径）。
      getLogger().error(`[dsh-session-reader] listSessions failed: ${error}`);
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`dsh session list 读取失败: ${msg}`, { cause: error });
    }
  }

  getNewestSession(cwd: string): AgentSession | null {
    return newestOf(this, cwd);
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
      // 服务端投影带来的标题与末轮输入：详情卡头部用它们，不必再从事件里猜。
      const preview = sessionPreview(session.projections?.values);
      const value = this.unary('session/page', {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages: DSH_HISTORY_FETCH_LIMIT,
      }) as DshSessionPageValue;
      return buildDshSessionContent(value, preview, opts);
    } catch (error) {
      // 降级为空卡（与 claude/pi 同口径），但完整错误对象入日志保留 stack，
      // 否则 wire 截断 / 权限问题只剩一句 message 无法定位。
      getLogger().error(`[dsh-session-reader] readSessionContent failed: ${error}`);
      return { events: [] };
    }
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    try {
      return this.resolveSession(sessionId, cwd)?.running === true;
    } catch (error) {
      getLogger().error(`[dsh-session-reader] isSessionActive failed: ${error}`);
      return false;
    }
  }

  /**
   * `/resume` 列表的每行预览（标题 + 末轮输入/输出），只读投影、不拉历史。
   *
   * DSH 0.2.2 起 `turnOutline` 声明了 `summary: false`，不再随 `session/list`
   * 下发；同一份值仍在 `session/projections` 里，所以这里按需单独取一次。
   * 与 `readSessionContent` 同口径做 cwd 守卫：跨 workspace 的会话一律不读。
   */
  readSessionSummary(sessionId: string, cwd: string): SessionSummary {
    try {
      const session = this.resolveSession(sessionId, cwd);
      if (!session) return {};
      const preview = sessionPreview(this.projectionValuesOf(sessionId));
      // 标题不回传：列表行本来就有，`/resume` 会把它当「近期取回的标题」重标成
      // 最近输入（resumeTitleParts 的标签口径），那样标题与末轮输入会重复一次。
      return {
        ...(preview.lastUserMessage ? { lastUserMessage: preview.lastUserMessage } : {}),
        ...(preview.lastAssistantMessage
          ? { lastAssistantMessage: preview.lastAssistantMessage }
          : {}),
      };
    } catch (error) {
      // 预览是展示增强：投影读不到时留空，别把整张 /resume 列表打成读取失败。
      getLogger().warn(`[dsh-session-reader] readSessionSummary failed for ${sessionId}: ${error}`);
      return {};
    }
  }

  /**
   * `session/projections` 的整份投影值，用于补齐列表行缺失的预览字段。
   * 读不到时返回 undefined：预览可缺省，不是故障（详情卡另有自己的错误路径）。
   */
  private projectionValuesOf(sessionId: string): DshProjectionValues | undefined {
    const value = this.unary('session/projections', { sessionId }) as {
      values?: unknown;
    } | null;
    const values = value?.values;
    return values && typeof values === 'object' && !Array.isArray(values)
      ? (values as DshProjectionValues)
      : undefined;
  }

  /**
   * Find the session row in `session/list` that matches BOTH id and cwd.
   * Returns undefined when the id belongs to another workspace (or is unknown) —
   * every caller treats that as "not usable here".
   *
   * subagent 派生会话也排除：它的 id + cwd 都能命中，但只能按
   * `{kind:'subagent', parentSessionId, childSessionId}` 寻址，按顶层会话读会被
   * 服务端拒绝（session/agent-busy）。在这里统一 fail-closed，比让每个调用方
   * 各自吃一次拒绝异常更省事（那异常会被 catch 成空事件列表 = 一张空卡）。
   */
  private resolveSession(sessionId: string, cwd: string): DshSessionSummary | undefined {
    const value = this.unary('session/list', {}) as DshSessionListValue;
    return (value.items ?? []).find(
      (i) =>
        !isSubagentSession(i) &&
        String(i.sessionId) === sessionId &&
        i.cwd !== undefined &&
        samePath(i.cwd, cwd),
    );
  }

  /** `session/page` needs an inclusive cursor; projections carry the watermark. */
  private resolveThroughSeq(sessionId: string, known: DshSessionSummary): number {
    const projection = this.unary('session/projections', { sessionId }) as {
      asOfSeq?: number;
    } | null;
    if (typeof projection?.asOfSeq === 'number') return projection.asOfSeq;
    return typeof known.projections?.asOfSeq === 'number' ? known.projections.asOfSeq : -1;
  }
}

/**
 * subagent 派生会话判定（DSH 0.2.x 起与顶层会话并列在 `session/list` 里）。
 *
 * 只认 `origin === 'subagent'`，别用更"顺手"的两个信号：
 * - **id 前缀**：顶层是 `session-<uuid>`、subagent 是裸 `<uuid>`，但 v0 老会话
 *   也是裸 uuid 且能正常读（`delegationDepth: 0`、无 `origin`）；
 * - **`parentSessionId` 非空**：fork 与 `session-btw-*` 旁支同样带 parent，却是
 *   可恢复的顶层会话。
 */
function isSubagentSession(item: { origin?: string }): boolean {
  return item.origin === 'subagent';
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

/**
 * 会话预览（列表卡上的「标题 / 最近输入 / 最后输出」）。
 *
 * 输入是投影值：`session/list` 的行投影或 `session/projections` 的整份值。
 * `title` 一直随列表行下发；`turnOutline`（每轮的 prompt/response）在 0.2.2
 * 起登记为 `summary: false`，只能从 `session/projections` 取——所以要预览就得
 * 额外读一次投影，不能指望行里有。
 *
 * 不拉 `session/page`：它按 `maxMessages=10000` 的上限拉整段历史，一页前 5 行
 * 就是 5 次这种大响应（把每行的 cwd 守卫与 projections 一起算，是 15 次同步
 * 请求）。`turnOutline` 的 prompt/response 由 DSH 侧按长度截断（结尾带 `…`），
 * 列表卡只做单行预览，直接复用即可。缺字段 / 类型不对时全部留空，不影响列表。
 */
function sessionPreview(values: DshProjectionValues | undefined): {
  summary: string;
  title?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
} {
  const rawTitle = values?.title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const outline = values?.turnOutline;
  const lastUserMessage = lastOutlineText(outline, 'prompt');
  const lastAssistantMessage = lastOutlineText(outline, 'response');
  return {
    // summary 同时填标题：只认 summary 的消费方（旧卡片路径、其他 agent 的
    // 统一逻辑）也能拿到可读文本，不必区分 agent。
    summary: title,
    ...(title ? { title } : {}),
    ...(lastUserMessage ? { lastUserMessage } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
  };
}

/**
 * 从 turnOutline 末条往回找第一个非空文本。
 *
 * 在途 turn 已经写进 outline，但 `response` 还是空串（实测末条
 * `{turn:6, prompt:"…", response:""}`）；直接取末条会让「最后输出」空掉，
 * 所以回溯到最近一条有内容的结果。
 */
function lastOutlineText(outline: unknown, key: 'prompt' | 'response'): string | undefined {
  if (!Array.isArray(outline)) return undefined;
  for (let i = outline.length - 1; i >= 0; i -= 1) {
    const entry = outline[i];
    if (!entry || typeof entry !== 'object') continue;
    const raw = (entry as Record<string, unknown>)[key];
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text) return text;
  }
  return undefined;
}

interface MappedEvent {
  events: AgentSessionContentEvent[];
  title?: string;
  usage?: DshTokenUsage;
  /**
   * 尚未配对的工具调用（`tool/call` 先记下，等 `tool/result` 到了合成一个面板）。
   * resume 卡里工具调用与结果是同一次交互，两个面板各占一屏没有意义。
   */
  pendingTool?: AgentSessionContentEvent;
}

/** 单个 turn 内各采样用量之和（input 为非缓存输入，与 ccusage 口径一致）。 */
interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * `user/message.source.kind` 里属于**纯上下文注入**的种类：没有回顾价值，且
 * 会挤掉真正的对话（5 条事件的窗口里被它们占满就什么都看不到了）。
 */
const CONTEXT_INJECTION_KINDS = new Set([
  'time-context',
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'compact-checkpoint',
]);

/** 系统通知（后台任务完成、目标变更）在回顾卡里的正文上限。 */
const NOTICE_MAX_BYTES = 400;

/** 单条思考在 resume 卡里的上限：过程信息，留头几百字即可。 */
const REASONING_MAX_BYTES = 800;
/** 单条 assistant 正文上限（最终答复通常最重要，给足空间）。 */
const TEXT_MAX_BYTES = 2_000;
/** 工具原始参数上限（标题已有摘要，正文只用于看完整命令）。 */
const TOOL_INPUT_MAX_BYTES = 600;

/** Map one DSH SessionEvent to display content events (+ title/usage side effects). */
/**
 * 单条畸形事件只跳过自己，不炸整张卡：DSH 服务端格式漂移时（time 非法、
 * content 非数组），旧实现会让异常冒到外层 catch 把整个 resume 卡变成空卡
 * （fail-whole）。时间戳缺失由卡片层兜底；content 非数组按无块处理。
 */
function safeEventTimestamp(time: unknown): string | undefined {
  if (typeof time !== 'string' && typeof time !== 'number') return undefined;
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function asBlocks(value: unknown): Array<{ type?: string; text?: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object');
}

type EventMapper = (ev: DshSessionEvent) => MappedEvent;

function mapUserMessage(ev: DshSessionEvent): MappedEvent {
  const out: MappedEvent = { events: [] };
  const content = asBlocks(ev.data.content);
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  if (!text.trim()) return out;
  // DSH 把上下文注入也写成 user/message，靠 `source.kind` 区分。真实会话里
  // 30 条 user/message 中只有 8 条是用户本人说的（其余是 time-context /
  // agent-instructions / skill-catalog / goal / tool-jobs…）——照单全收会让
  // 回顾卡里塞满"Time sampled while preparing turn…"，还把系统提示标成 👤 你。
  const source = ev.data.source as { kind?: string } | undefined;
  const kind = typeof source?.kind === 'string' ? source.kind : undefined;
  if (kind && CONTEXT_INJECTION_KINDS.has(kind)) return out;
  const isNotice = kind !== undefined && kind !== 'user';
  out.events.push({
    type: isNotice ? 'notice' : 'user',
    ...(isNotice ? { title: '🔔 通知' } : {}),
    content: isNotice ? truncateUtf8(text.trim(), NOTICE_MAX_BYTES) : text,
    timestamp: safeEventTimestamp(ev.time),
  });
  return out;
}

function mapAssistantMessage(ev: DshSessionEvent): MappedEvent {
  const out: MappedEvent = { events: [] };
  const content = asBlocks((ev.data.message as { content?: unknown } | undefined)?.content);
  const timestamp = safeEventTimestamp(ev.time);
  // DSH 的块类型是 text / reasoning / tool-call（不是 Anthropic 的
  // thinking）。只认 text 会让 resume 卡"只有工具调用、没有思考与输出"
  // （一个 31 turn 的会话里 reasoning 块 371 个、text 12 个，
  // 全被丢掉）。tool-call 块不在这里取——独立的 `tool/call` 事件带完整参数。
  for (const block of content) {
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    if (!text) continue;
    if (block.type === 'text') {
      out.events.push({
        type: 'assistant',
        content: truncateUtf8(text, TEXT_MAX_BYTES),
        timestamp,
      });
    } else if (block.type === 'reasoning') {
      out.events.push({
        type: 'thinking',
        // 思考是过程信息：resume 卡里留头几百字足够判断"当时在想什么"。
        content: truncateUtf8(text, REASONING_MAX_BYTES),
        timestamp,
      });
    }
  }
  const usage = ev.data.usage as DshTokenUsage | undefined;
  if (usage && typeof usage === 'object') out.usage = usage;
  return out;
}

function mapToolCall(ev: DshSessionEvent): MappedEvent {
  const out: MappedEvent = { events: [] };
  // 调用本身先不产出事件：DSH 的 tool/call 与 tool/result 是一对，resume 卡
  // 里合成一个面板（`🔧 bash — cmd` + 输出），而不是两个各占一屏。
  const name = String(ev.data.name ?? '');
  const args = typeof ev.data.arguments === 'string' ? ev.data.arguments : '';
  const summary = summarizeToolInput(name, args);
  out.pendingTool = {
    type: 'tool_use',
    title: summary ? `🔧 ${name} — ${summary}` : `🔧 ${name}`,
    content: truncateUtf8(args, TOOL_INPUT_MAX_BYTES),
    timestamp: safeEventTimestamp(ev.time),
  };
  return out;
}

function mapToolResult(ev: DshSessionEvent): MappedEvent {
  const out: MappedEvent = { events: [] };
  const msg = ev.data.message as { content?: unknown; isError?: unknown } | undefined;
  const raw = stringifyContent(msg?.content);
  const isError = msg?.isError === true;
  out.events.push({
    type: 'tool_result',
    title: isError ? '🔴 结果（失败）' : '🟢 结果',
    content: truncateUtf8(raw, TOOL_RESULT_MAX_BYTES),
    timestamp: safeEventTimestamp(ev.time),
  });
  return out;
}

/**
 * 事件类型 → 命名 handler。用 Map 而非对象字面量 / switch：`constructor` /
 * `toString` 这类外来 type 会命中 Object.prototype，查表会拿到非函数值。
 */
const EVENT_MAPPERS = new Map<string, EventMapper>([
  ['user/message', mapUserMessage],
  ['assistant/message', mapAssistantMessage],
  ['tool/call', mapToolCall],
  ['tool/result', mapToolResult],
]);

function mapEvent(ev: DshSessionEvent): MappedEvent {
  const mapper = EVENT_MAPPERS.get(ev.type);
  return mapper ? mapper(ev) : { events: [] };
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

// --- readSessionContent 装配原语（模块级命名函数 + 显式状态对象） ---
// 纯结构拆分：外层 readSessionContent 只做「解析会话 / unary / 错误降级」，
// 事件映射、用量累积、返回装配全部下沉到这些模块级命名函数，避免内部闭包
// 把决策点计回外层。字段顺序、截断长度、turn 口径、事件配对、
// displayTitle/aiTitle 来源逐项保持，不改任何行为。

interface DshContentAccumulator {
  events: AgentSessionContentEvent[];
  displayTitle?: string;
  cumInput: number;
  cumOutput: number;
  cumCacheRead: number;
  cumCacheWrite: number;
  lastUsage?: DshTokenUsage;
  /** 在途 turn 的采样累加；null = 历史里没有 turn 标记（旧数据/截断）。 */
  turnUsage: UsageTotals | null;
  lastTurnUsage: UsageTotals | null;
  /** 等结果的工具调用（见 MappedEvent.pendingTool）。 */
  pendingTool?: AgentSessionContentEvent;
}

function newDshContentAccumulator(): DshContentAccumulator {
  return {
    events: [],
    cumInput: 0,
    cumOutput: 0,
    cumCacheRead: 0,
    cumCacheWrite: 0,
    turnUsage: null,
    lastTurnUsage: null,
  };
}

/** turn 边界标记推进：turn/start 开新账本，turn/end 结算为「上一轮」。 */
function advanceTurnMarker(acc: DshContentAccumulator, ev: DshSessionEvent): void {
  if (ev.type === 'turn/start') {
    acc.turnUsage = emptyUsageTotals();
  } else if (ev.type === 'turn/end') {
    if (acc.turnUsage) acc.lastTurnUsage = acc.turnUsage;
    acc.turnUsage = null;
  }
}

/** 工具调用/结果配对：一对合成一个面板；未配对的分支按原顺序推入。 */
function pushMappedContentEvents(
  acc: DshContentAccumulator,
  ev: DshSessionEvent,
  contentEvents: MappedEvent,
): void {
  if (contentEvents.pendingTool) {
    // 未完成的工具调用最多同时一个（DSH 按 step 串行执行；并行调用时按
    // 到达顺序配对，最坏情况是两次调用共用一个面板，不会丢信息）。
    if (acc.pendingTool) acc.events.push(acc.pendingTool);
    acc.pendingTool = contentEvents.pendingTool;
  } else if (ev.type === 'tool/result' && acc.pendingTool && contentEvents.events[0]) {
    const result = contentEvents.events[0];
    // 标题沿用调用的 `🔧 name — summary`，失败改成 ❌（折叠态一眼看出结果）。
    const failed = result.title?.startsWith('🔴') === true;
    acc.events.push({
      type: 'tool_use',
      title: failed
        ? (acc.pendingTool.title ?? '❌ 工具').replace('🔧', '❌')
        : acc.pendingTool.title,
      content: result.content,
      timestamp: acc.pendingTool.timestamp,
    });
    acc.pendingTool = undefined;
  } else {
    acc.events.push(...contentEvents.events);
  }
}

/** 单条 usage：会话累计 + 在途 turn 累计 + 末次采样水位。 */
function accumulateUsage(acc: DshContentAccumulator, u: DshTokenUsage): void {
  // Cumulative (session-wide): sum across ALL assistant/message usage.
  acc.cumInput += u.inputTokens ?? 0;
  acc.cumOutput += u.outputTokens ?? 0;
  acc.cumCacheRead += u.cacheReadTokens ?? 0;
  acc.cumCacheWrite += u.cacheWriteTokens ?? 0;
  // 本 run 的 flow 字段 = 末个 turn 的采样之和；contextLength 用末次采样
  // 的窗口占用（input + cacheRead + cacheWrite，不含 output）。
  if (acc.turnUsage) {
    acc.turnUsage.input += u.inputTokens ?? 0;
    acc.turnUsage.output += u.outputTokens ?? 0;
    acc.turnUsage.cacheRead += u.cacheReadTokens ?? 0;
    acc.turnUsage.cacheWrite += u.cacheWriteTokens ?? 0;
  }
  acc.lastUsage = u;
}

/** 单条 record → 更新累积状态（无闭包留在 readSessionContent 内）。 */
function accumulateDshEvent(acc: DshContentAccumulator, ev: DshSessionEvent): void {
  advanceTurnMarker(acc, ev);
  const contentEvents = mapEvent(ev);
  pushMappedContentEvents(acc, ev, contentEvents);
  if (contentEvents.title) acc.displayTitle = contentEvents.title;
  if (contentEvents.usage) accumulateUsage(acc, contentEvents.usage);
}

/** 末轮 flow + 会话累计 → AgentSessionUsage（§9.21 口径）。 */
function finalizeDshSessionUsage(acc: DshContentAccumulator): AgentSessionUsage | undefined {
  const lastUsage = acc.lastUsage;
  if (!lastUsage) return undefined;
  const input = lastUsage.inputTokens ?? 0;
  const cacheRead = lastUsage.cacheReadTokens ?? 0;
  const cacheWrite = lastUsage.cacheWriteTokens ?? 0;
  // 在途 turn（turn/start 无 turn/end，run 进行中读历史）的采样优先于
  // 上一轮：旧实现只认已结算的 lastTurnUsage，mid-run 读取会把当前 turn
  // 已消耗的量显示成上一个完整 turn 的数字。
  const flow: UsageTotals = acc.turnUsage ??
    acc.lastTurnUsage ?? {
      input,
      output: lastUsage.outputTokens ?? 0,
      cacheRead,
      cacheWrite,
    };
  return {
    inputTokens: flow.input,
    outputTokens: flow.output,
    // §9.21 口径：context 是末次采样的窗口水位（input + 末次 output +
    // cache），不把整 turn 的 output 求和（前几步 output 已进入后续 input）。
    contextLength: input + (lastUsage.outputTokens ?? 0) + cacheRead + cacheWrite,
    cacheReadTokens: flow.cacheRead,
    cacheCreationTokens: flow.cacheWrite,
    totalTokens: flow.input + flow.output + flow.cacheRead + flow.cacheWrite,
    ...cumulativeUsageFields({
      input: acc.cumInput,
      output: acc.cumOutput,
      cacheRead: acc.cumCacheRead,
      cacheCreation: acc.cumCacheWrite,
    }),
  };
}

/** session/page 响应 + 服务端预览 → 详情卡内容（纯结构装配）。 */
function buildDshSessionContent(
  value: DshSessionPageValue,
  preview: ReturnType<typeof sessionPreview>,
  opts?: { maxEvents?: number },
): SessionContent {
  const acc = newDshContentAccumulator();
  for (const entry of value.records ?? []) {
    const ev = entry.event;
    if (!ev) continue;
    accumulateDshEvent(acc, ev);
  }
  const sessionUsage = finalizeDshSessionUsage(acc);
  // 中断/仍在执行的调用没有结果：把它当独立事件留下，别让这一条消失。
  if (acc.pendingTool) acc.events.push(acc.pendingTool);
  // 头部信息口径：最近输入优先用服务端末轮 prompt（事件里可能只是当前 turn
  // 的一部分），标题用服务端 title；两者都缺时保持原行为。
  const headerLastInput = preview.lastUserMessage ?? acc.displayTitle;
  return {
    // 展示仍按 maxEvents 尾截断（默认 50，保持原行为），usage 已在上面基于
    // 完整 history 累加。
    events: capEvents(acc.events, opts?.maxEvents ?? 50),
    ...(sessionUsage ? { usage: sessionUsage } : {}),
    ...(headerLastInput ? { displayTitle: headerLastInput } : {}),
    ...(preview.title ? { aiTitle: preview.title } : {}),
  };
}
