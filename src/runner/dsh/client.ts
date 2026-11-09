/**
 * DshClient — HTTP/WebSocket client for the DSH Web Host.
 *
 * DSH 0.2.x guardrails:
 *  1. `/api/*` and `/api/remote.mux` require a signed `dsh-auth-*` cookie.
 *     We mint the v1 cookie from DSH's durable browser-session secret; the
 *     launch token remains a fallback via `GET /?token=<launch token>`.
 *  2. Unary calls are POST `/api/<namespace>/<method>` envelopes whose
 *     `payload` is `{args:<request>}`.
 *  3. Live session data is a logical stream over `/api/remote.mux`:
 *     `{type:'open',streamId,endpoint:'session/follow',payload}` →
 *     `{type:'item',streamId,value}` / `{type:'end',streamId}`.
 *     The Gateway-owned `$events` stream carries answerable waterfalls:
 *     `approval/request` (tool permissions) and `user-questions/request`
 *     (`ask_user_question`); answers go back through `$events/result`.
 *
 * The client is stateless apart from the base URL and auth cookie: each
 * `run()` opens its own remote mux subscription and closes it on terminal.
 * `sessionEvents()` adds per-session filtering, reconnect + follow-snapshot
 * replay, and seq-based dedup.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import { dshArgs, extractDshToken } from '../../dsh/protocol.js';
import { getLogger } from '../../logger/index.js';
import {
  DSH_COOKIE_LIFETIME_MS,
  isDshCredentialsNotFound,
  mintDshBrowserCookie,
  readDshBrowserSecret,
  resolveDshCredentialsFile,
} from '../../dsh/auth.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../common/defaults.js';
import type {
  DshApprovalStreamItem,
  DshCommandResult,
  DshFollowFrame,
  DshFollowSnapshot,
  DshInboxItem,
  DshModelCatalogValue,
  DshModelSelection,
  DshOpenTurnState,
  DshPermissionCatalogValue,
  DshJobView,
  DshPresetListValue,
  DshProjectionItem,
  DshProjectionSnapshot,
  DshQuestion,
  DshQuestionOption,
  DshRemoteEventFrame,
  DshRemoteEventWaterfallFrame,
  DshRemoteEventOutcome,
  DshSessionEvent,
  DshSessionListValue,
  DshSessionPageValue,
  DshStreamItem,
} from '../../dsh/types.js';
import { goalFromLiveView, goalFromProjection } from './goal-view.js';
import type { GoalView } from '../types.js';
import { DshError, isDshTransientAvailabilityError } from './errors.js';
import { openMuxStream } from './mux-stream.js';

export { DshError } from './errors.js';

interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketOptions {
  headers?: Record<string, string>;
}

export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  /** Set by transports that expose an HTTP rejection before the handshake. */
  onunexpectedresponse?: ((event: { statusCode?: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string, options?: WebSocketOptions) => WebSocketLike;

function defaultWebSocketFactory(url: string, options?: WebSocketOptions): WebSocketLike {
  const socket = new WebSocket(url, {
    ...(options?.headers ? { headers: options.headers } : {}),
  }) as unknown as WebSocketLike;
  const raw = socket as unknown as WebSocket & {
    on(
      event: 'unexpected-response',
      listener: (request: unknown, response: { statusCode?: number }) => void,
    ): void;
  };
  raw.on('unexpected-response', (_request, response) => {
    socket.onunexpectedresponse?.({ statusCode: response.statusCode });
  });
  return socket;
}

function isDshAuthError(error: unknown): error is DshError {
  return (
    error instanceof DshError &&
    error.code === 'http' &&
    (error.details.status === 401 || error.details.status === 403)
  );
}

interface UnaryContext {
  signal: AbortSignal | undefined;
  timeoutSignal: AbortSignal | undefined;
  timeoutMs: number;
  rpcId: string;
}

/** 组合 abort/timeout signal 并生成本次 unary 的 rpcId（循环外一次算好）。 */
function prepareUnary(
  opts: { signal?: AbortSignal; timeoutMs?: number },
  requestTimeoutMs: number,
): UnaryContext {
  const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
  // 0/负数 = 不设超时（兼容「长请求不取消」的配置），其余走 AbortSignal.timeout。
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const signal =
    opts.signal && timeoutSignal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : (opts.signal ?? timeoutSignal);
  const rpcId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return { signal, timeoutSignal, timeoutMs, rpcId };
}

/** Distinguish "run stopped" (abort) from "server did not answer" (timeout). */
function abortErrorOf(
  method: string,
  err: unknown,
  runSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined,
  timeoutMs: number,
): DshError {
  if (runSignal?.aborted) {
    return new DshError('aborted', `DSH unary ${method} aborted`, { cause: err });
  }
  if (timeoutSignal?.aborted) {
    return new DshError('timeout', `DSH unary ${method} timed out after ${timeoutMs}ms`, {
      cause: err,
    });
  }
  return new DshError('aborted', `DSH unary ${method} aborted: ${(err as Error).message}`);
}

/** 单次 unary 尝试的结果：成功带 value，或需要重试（401 重新铸 cookie）。 */
type UnaryAttemptResult = { kind: 'done'; value: unknown } | { kind: 'retry' };

/** 校验 ok 响应并取 `result.value`；非 ok / 非 JSON / result 失败都抛 DshError。 */
async function readUnaryBody(method: string, res: Response): Promise<unknown> {
  if (!res.ok) {
    throw new DshError('http', `DSH HTTP ${res.status} for ${method}`, {
      status: res.status,
    });
  }
  let body: {
    result?: {
      ok?: boolean;
      value?: unknown;
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new DshError('protocol', `DSH ${method} returned non-JSON: ${(err as Error).message}`);
  }
  if (body.result?.ok !== true) {
    const err = body.result?.error;
    throw new DshError(
      err?.code ?? 'error',
      err?.message ?? `DSH ${method} failed`,
      err?.details ?? {},
    );
  }
  return body.result.value;
}

/**
 * session 服务就绪探测的默认预算。
 *
 * 0.2.2 的 HTTP/gateway 先于 `sessionController` 的异步 Service.init 就绪；
 * daemon 的端口探针看到的是「HTTP 已响应」，不是「session RPC 可用」。
 * 这段等待发生在 run 启动、任何 prompt 入队之前，宁可多等几秒也不能把
 * 启动竞态误报成 provider 配置错误。
 */
const DEFAULT_SERVICE_READY_TIMEOUT_MS = 30_000;
/** 单次就绪探测的 unary 预算：启动期的请求应该秒回或直接拒连。 */
const SERVICE_READY_PROBE_TIMEOUT_MS = 5_000;
const SERVICE_READY_BACKOFF_MS = 200;
const SERVICE_READY_BACKOFF_MAX_MS = 2_000;

/**
 * run 期间 session/follow 连续断开的上限。超过后以明确错误终止本轮，
 * 而不是像 0.2.2 升级那次一样挂 39 分钟等 idle 看门狗。
 *
 * 只统计「已断开且重连失败」的时间；连接正常但模型长时间不出帧不算。
 */
const DEFAULT_STREAM_DISCONNECT_TIMEOUT_MS = 90_000;

/** Backoff between mux reconnects to avoid a hot loop on a dropping server. */
const RECONNECT_BACKOFF_MS = 200;
/**
 * 重连退避上限。指数退避到该值后保持不变：宿主宕机/端口失效而 run 在途时，
 * 重连从固定 200ms 的 ~5 次/秒降到封顶后的 ~12 次/分钟——每次重连都是一次
 * WS 握手 + follow 快照重放（+ 凭据 stat），不能按秒级风暴打满。
 */
const RECONNECT_BACKOFF_MAX_MS = 5_000;

/**
 * 第 `attempt` 次重连（0 起）前的等待时长：200ms 起指数翻倍，封顶 5s。
 * attempt 在收到任何一帧数据后归零（连接恢复即恢复正常节奏）。
 */
export function reconnectBackoffMs(attempt: number): number {
  const backoff = RECONNECT_BACKOFF_MS * 2 ** Math.max(0, attempt);
  return Math.min(RECONNECT_BACKOFF_MAX_MS, backoff);
}

/**
 * `goals/get` 的探测预算。
 *
 * 它只是给 goal 状态补一维进程内 activation：宿主侧是一次内存读，正常毫秒级；
 * 慢或不可用时留空（渲染层按"可能续跑"保守处理），不能拖住 run 的启动/收尾。
 */
const GOAL_ACTIVATION_PROBE_TIMEOUT_MS = 1_500;

/**
 * Follow snapshot budget. `session/follow` also stays live after the snapshot.
 *
 * 语义（经 DSH 源码验证，packages/api/session-controller/src/history.ts
 * 的 paginate）：按**消息**计数——只有 user/assistant message 占预算，工具
 * 事件随所在消息组搭进快照。断连期间积压超过该预算时快照首条会越过
 * lastSeq，缺口经 {@link replaySnapshotGap} 用 session/page 回填。
 */
const FOLLOW_MAX_MESSAGES = 200;

/** 快照缺口回填的单页消息数（session/page 的 maxMessages）。 */
const FOLLOW_GAP_BACKFILL_PAGE_MESSAGES = 200;
/** 快照缺口回填的页数上限（×PAGE_MESSAGES = 单次重连最多回补 4000 条消息）。 */
const FOLLOW_GAP_BACKFILL_MAX_PAGES = 20;

/**
 * 只在 turn 内部落盘的会话事件类型：看到它们说明 turn 还没结束。
 * 名单刻意保守——`user/message`（压缩 checkpoint 会以 turn:null 落盘）、
 * `job/*`（后台任务可在 turn 外结算）、`turn/end`、`command/*` 等都不算，
 * 判不出来时宁可放行，让 DSH 自己拒绝。
 */
const IN_TURN_EVENT_TYPES = new Set([
  'step/start',
  'step/end',
  'assistant/chunk',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'request/header',
]);

/**
 * Parse the `inbox` projection into the pending items this repo consumes.
 *
 * The projection's items are wire data (typed `{}` by the server schema); keep
 * this defensive: one malformed row must not hide the others.
 */
function inboxItemsOf(values: Record<string, unknown>): DshInboxItem[] {
  const inbox = values.inbox;
  if (!inbox || typeof inbox !== 'object' || Array.isArray(inbox)) return [];
  const out: DshInboxItem[] = [];
  for (const target of ['next-turn', 'next-step'] as const) {
    const list = (inbox as Record<string, unknown>)[target];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as { id?: unknown; source?: unknown };
      if (typeof item.id !== 'string' || item.id.length === 0) continue;
      const source = item.source;
      const parsedSource =
        source && typeof source === 'object' && !Array.isArray(source)
          ? {
              ...(typeof (source as { kind?: unknown }).kind === 'string'
                ? { kind: (source as { kind: string }).kind }
                : {}),
              ...(typeof (source as { rpcId?: unknown }).rpcId === 'string'
                ? { rpcId: (source as { rpcId: string }).rpcId }
                : {}),
            }
          : undefined;
      out.push({ id: item.id, ...(parsedSource ? { source: parsedSource } : {}) });
    }
  }
  return out;
}

// =============================================================================
// approvalEvents 的模块级命名 handler（显式传 state / client，避免方法内闭包）
// =============================================================================

interface ApprovalStreamState {
  authRefreshAttempted: boolean;
  reconnectAttempts: number;
  sawReady: boolean;
  streamClientId?: string;
}

interface ApprovalFrameResult {
  items: DshApprovalStreamItem[];
  /** true 表示 yield 完 items 后应立即结束 generator。 */
  stop: boolean;
}

/** Hand one waterfall delivery back with `next` (another answerer owns it). */
function delegateWaterfall(
  client: DshClient,
  clientId: string,
  eventId: string,
  signal: AbortSignal,
): void {
  void client
    .answerRemoteEvent(clientId, eventId, { kind: 'next' }, { signal })
    .catch((err: unknown) => {
      if (!signal.aborted) {
        getLogger().warn(
          `[dsh] waterfall delegation failed eventId=${eventId}: ${(err as Error).message}`,
        );
      }
    });
}

/** 一个 waterfall 帧 → 要 yield 的 items（含 question/request 委托）。 */
function waterfallToItems(
  client: DshClient,
  clientId: string,
  frame: DshRemoteEventWaterfallFrame,
  sessionId: string,
  signal: AbortSignal,
): ApprovalFrameResult {
  if (frame.event === 'user-questions/request' && frame.agentId === sessionId) {
    if (isTimedQuestionRequest(frame.request)) {
      // The timed wait owns its own deadline (and the Web UI renders the
      // countdown); a card answer outside that window is lost.
      getLogger().info(
        `[dsh] timed user-questions/request delegated to the Web UI eventId=${frame.eventId}`,
      );
      delegateWaterfall(client, clientId, frame.eventId, signal);
      return { items: [], stop: false };
    }
    const questions = dshQuestionsOf(frame.request);
    if (questions) {
      return {
        items: [{ kind: 'question', eventId: frame.eventId, clientId, questions }],
        stop: false,
      };
    }
    // The Feishu card cannot answer this batch safely (malformed, or duplicate
    // texts — the coordinator keys answers by text).
    getLogger().warn(
      `[dsh] user-questions/request not relayable; delegating eventId=${frame.eventId}`,
    );
    delegateWaterfall(client, clientId, frame.eventId, signal);
    return { items: [], stop: false };
  }
  if (frame.event !== 'approval/request' || frame.agentId !== sessionId) {
    // Every owner answerer receives the waterfall. A non-owner of the session
    // must explicitly delegate, otherwise DSH waits.
    delegateWaterfall(client, clientId, frame.eventId, signal);
    return { items: [], stop: false };
  }
  const data = frame.request;
  const toolName = typeof data.toolName === 'string' ? data.toolName : '';
  const callId = typeof data.callId === 'string' ? data.callId : undefined;
  const reason = typeof data.reason === 'string' ? data.reason : undefined;
  return {
    items: [
      {
        kind: 'request',
        eventId: frame.eventId,
        clientId,
        toolName,
        ...(callId ? { callId } : {}),
        ...(reason ? { reason } : {}),
      },
    ],
    stop: false,
  };
}

/** 一个 `$events` 帧 → items（并按需更新 state）。 */
function processApprovalFrame(
  state: ApprovalStreamState,
  frame: DshRemoteEventFrame,
  sessionId: string,
  signal: AbortSignal,
  client: DshClient,
): ApprovalFrameResult {
  if (frame.type === 'ready') {
    state.authRefreshAttempted = false;
    // 成功建连后补充重连预算：goal 驱动的 turn 可跑数小时，DSH 重启 + 网络抖动
    // 累计掉线超过 3 次后旧实现会让 $events 永久 unavailable。
    state.reconnectAttempts = 0;
    state.sawReady = true;
    state.streamClientId = frame.clientId;
    return { items: [{ kind: 'ready', clientId: frame.clientId }], stop: false };
  }
  if (frame.type === 'waterfall') {
    if (!state.streamClientId) {
      return {
        items: [
          { kind: 'unavailable', message: 'DSH approval stream sent a waterfall before ready' },
        ],
        stop: true,
      };
    }
    return waterfallToItems(client, state.streamClientId, frame, sessionId, signal);
  }
  if (frame.type === 'cancel') {
    return { items: [{ kind: 'cancelled', eventId: frame.eventId }], stop: false };
  }
  return { items: [], stop: false };
}

type ApprovalErrorAction =
  | { kind: 'return' }
  | { kind: 'refresh-auth' }
  | { kind: 'reconnect'; attempt: number }
  | { kind: 'unavailable'; message: string };

/** 把 `$events` 流异常分类成 4 种动作（不改变重试/超时语义）。 */
function classifyApprovalStreamError(
  err: unknown,
  state: ApprovalStreamState,
  signal: AbortSignal,
): ApprovalErrorAction {
  if (signal.aborted) return { kind: 'return' };
  if (
    err instanceof DshError &&
    err.code === 'http' &&
    err.details.status === 401 &&
    !state.authRefreshAttempted
  ) {
    return { kind: 'refresh-auth' };
  }
  const message = err instanceof Error ? err.message : String(err);
  const forbidden =
    (err instanceof DshError &&
      (err.code === 'gateway/interactions-forbidden' ||
        (err.code === 'http' && err.details.status === 403))) ||
    message.includes('interactions-forbidden');
  if (!forbidden && state.reconnectAttempts < 3) {
    return { kind: 'reconnect', attempt: state.reconnectAttempts + 1 };
  }
  return { kind: 'unavailable', message };
}

type ApprovalTailAction = 'aborted' | 'reconnect' | 'ended';

/** 一次流正常结束（无异常）后的收尾决策。 */
function approvalStreamTail(state: ApprovalStreamState, signal: AbortSignal): ApprovalTailAction {
  if (signal.aborted) return 'aborted';
  if (state.sawReady && state.reconnectAttempts < 3) {
    state.reconnectAttempts += 1;
    return 'reconnect';
  }
  return 'ended';
}

function reconnectBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

// =============================================================================
// sessionEvents 的模块级命名 handler（显式传 state / client，避免方法内闭包）
// =============================================================================

interface SessionStreamState {
  lastSeq: number;
  owns: boolean;
  foreignTailReported: boolean;
  sessionId: string;
  promptRequestId: string | undefined;
  authRefreshAttempted: boolean;
}

/** Mark this run as the owner once its own prompt message is recorded. */
function ownsSessionEvent(state: SessionStreamState, ev: DshSessionEvent): boolean {
  if (state.owns) return true;
  if (ev.type !== 'user/message') return false;
  const source = (ev.data as { source?: { kind?: string; rpcId?: string } } | undefined)?.source;
  if (source?.kind === 'user' && source.rpcId === state.promptRequestId) {
    state.owns = true;
    return true;
  }
  return false;
}

function admitSessionEvent(state: SessionStreamState, ev: DshSessionEvent): boolean {
  if (ownsSessionEvent(state, ev)) return true;
  if (!state.foreignTailReported) {
    state.foreignTailReported = true;
    getLogger().info(
      `[dsh] prompt ${state.promptRequestId ?? '(none)'} is queued behind a running turn for session ${state.sessionId}; holding the card open until its own turn starts`,
    );
  }
  return false;
}

/** Translate one durable event into a stream item (approvals are surfaced
 *  separately; everything else is forwarded to the runner). */
function sessionEventItem(sessionId: string, event: DshSessionEvent): DshStreamItem | undefined {
  if (event.type === 'approval/asked') {
    const data = event.data as {
      id?: string;
      toolName?: string;
      callId?: string;
      reason?: string;
    };
    if (!data.id) return undefined;
    return {
      kind: 'approval',
      sessionId,
      approvalId: data.id,
      toolName: data.toolName ?? '',
      ...(data.callId ? { callId: data.callId } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
    };
  }
  return { kind: 'event', sessionId, event };
}

interface SessionEventStep {
  item: DshStreamItem | undefined;
  /** true 表示该事件是 turn/end，yield 完应结束整个 generator。 */
  done: boolean;
}

/** 单条事件的 seq 去重 / admit / item / turn-end 早退；undefined 表示跳过。 */
function advanceSessionEvent(
  state: SessionStreamState,
  ev: DshSessionEvent,
): SessionEventStep | undefined {
  if (ev.seq <= state.lastSeq) return undefined;
  state.lastSeq = ev.seq;
  if (!admitSessionEvent(state, ev)) return undefined;
  return { item: sessionEventItem(state.sessionId, ev), done: ev.type === 'turn/end' };
}

/** 一帧 follow → 待回放的 durable 事件（assistant-stream 不带 durable 事件）。 */
async function sessionFrameEvents(
  client: DshClient,
  state: SessionStreamState,
  frame: DshFollowFrame,
  signal: AbortSignal,
): Promise<DshSessionEvent[]> {
  if (frame.type === 'snapshot') {
    return client.replaySnapshotGap(state.sessionId, signal, state.lastSeq, frame);
  }
  if (frame.type === 'event') return [frame.event];
  return [];
}

type SessionErrorAction =
  { kind: 'return' } | { kind: 'refresh-auth' } | { kind: 'rethrow' } | { kind: 'reconnect' };

/** 把 follow 流异常分类成 4 种动作（不改变重试/超时语义）。 */
function classifySessionStreamError(
  err: unknown,
  state: SessionStreamState,
  signal: AbortSignal,
): SessionErrorAction {
  if (signal.aborted) return { kind: 'return' };
  if (isDshAuthError(err)) {
    if (!state.authRefreshAttempted) return { kind: 'refresh-auth' };
    return { kind: 'rethrow' };
  }
  return { kind: 'reconnect' };
}

export interface DshClientOptions {
  /** Configured DSH home; selects `.credentials.yaml` when no explicit file is given. */
  dshHome?: string;
  /**
   * Optional DSH Web launch token. Accepts either the bare token or the full
   * URL printed by `dsh web` (the `token` query parameter is extracted).
   */
  token?: string;
  /**
   * DSH credentials file containing the durable browser-session signing
   * secret. Defaults to `$DSH_HOME/.credentials.yaml` or
   * `~/.dsh/.credentials.yaml`. When readable, this is preferred over the
   * per-process launch token and survives `dsh web` restarts.
   */
  credentialsFile?: string;
  /** Injectable credentials reader (tests). */
  readCredentials?: (file: string) => Promise<Buffer>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Lifetime of minted browser cookies. */
  cookieLifetimeMs?: number;
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketFactory;
  /**
   * Unary request timeout. DSH accepts the HTTP connection but may never answer
   * (e.g. a stuck `session/prompt`); without a timeout the run generator stays
   * parked in `await unary()` forever, so /stop and the idle watchdog cannot
   * release the bridge's workspace queue.
   */
  requestTimeoutMs?: number;
  /**
   * Live `sessionEvents` streams fail after this long of continuous disconnect
   * (measured from the first failed reconnect, reset by any received frame).
   * 0 disables. A connected-but-silent model turn is not affected.
   */
  streamDisconnectTimeoutMs?: number;
}

export class DshClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly credentialsFile: string;
  private readonly readCredentials: (file: string) => Promise<Buffer>;
  private readonly now: () => number;
  private readonly cookieLifetimeMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl: WebSocketFactory;
  private readonly requestTimeoutMs: number;
  private readonly streamDisconnectTimeoutMs: number;
  private cookiePromise?: Promise<string | undefined>;
  /** (mtime, size) 指纹命中时复用的 signing secret，见 resolveCredentialsSecret。 */
  private secretCache?: { mtimeMs: number; size: number; secret: Buffer };

  constructor(baseUrl: string, options: DshClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = extractDshToken(options.token);
    this.credentialsFile =
      options.credentialsFile?.trim() || resolveDshCredentialsFile(process.env, options.dshHome);
    this.readCredentials = options.readCredentials ?? readDshBrowserSecret;
    this.now = options.now ?? Date.now;
    this.cookieLifetimeMs = options.cookieLifetimeMs ?? DSH_COOKIE_LIFETIME_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketImpl = options.webSocketImpl ?? defaultWebSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.streamDisconnectTimeoutMs =
      options.streamDisconnectTimeoutMs ?? DEFAULT_STREAM_DISCONNECT_TIMEOUT_MS;
  }

  /**
   * Resolve a DSH browser cookie. The durable credentials file is re-read only
   * when its (mtime, size) fingerprint changes — an unchanged file reuses the
   * cached secret, so a rotated signing secret is still picked up without
   * restarting lark-remote while steady-state requests cost a single `stat`
   * instead of stat+read+YAML.parse. Token bootstrap remains a fallback for
   * hosts without that file; unlike `/connect`, the index handshake mints a v1
   * cookie that DSH accepts for API and WebSocket requests across its own
   * restarts.
   */
  private async authCookie(force = false, signal?: AbortSignal): Promise<string | undefined> {
    const fromCredentials = await this.cookieFromCredentials();
    if (fromCredentials) return fromCredentials;
    if (!this.token) return undefined;
    if (force) this.cookiePromise = undefined;
    if (!this.cookiePromise) {
      this.cookiePromise = (async (): Promise<string> => {
        const url = `${this.baseUrl}/?token=${encodeURIComponent(this.token)}`;
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          if (signal?.aborted) throw err;
          throw new DshError('transport', `DSH auth transport error: ${(err as Error).message}`);
        }
        if (res.status !== 303 && !res.ok) {
          throw new DshError(
            'http',
            `DSH auth HTTP ${res.status}: 凭据文件不可用，且 dsh web 启动 token 无效`,
            { status: res.status },
          );
        }
        const setCookies =
          typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter((v): v is string => !!v);
        const cookie = setCookies
          .map((value) => value.split(';')[0]?.trim())
          .filter((value): value is string => !!value)
          .join('; ');
        if (!cookie) {
          throw new DshError('auth', 'DSH index handshake did not return a session cookie');
        }
        return cookie;
      })();
      // A failed handshake must not poison later retries (e.g. after the user
      // updates agents.dsh.token in config.yaml and the runner is rebuilt).
      this.cookiePromise.catch(() => {
        this.cookiePromise = undefined;
      });
    }
    return this.cookiePromise;
  }

  /**
   * Mint a v1 browser cookie from DSH's durable signing secret.
   *
   * secret 走 (mtime, size) 指纹缓存：凭据文件由 DSH 独占写入（轮换 = 重写文件
   * → mtime 必变 → 下次调用自动重读），命中时省掉 read + YAML.parse。一次 run
   * 的几十上百个 unary + mux（重）连原本每次都要完整读盘解析，现在各付一次 stat。
   */
  private async cookieFromCredentials(): Promise<string | undefined> {
    try {
      const secret = await this.resolveCredentialsSecret();
      return mintDshBrowserCookie(this.baseUrl, secret, this.now(), this.cookieLifetimeMs);
    } catch (err) {
      if (isDshCredentialsNotFound(err)) return undefined;
      if (this.token) {
        getLogger().warn(
          `[dsh] cannot use DSH credentials file ${this.credentialsFile}: ${(err as Error).message}; ` +
            'falling back to the launch token',
        );
        return undefined;
      }
      throw new DshError(
        'auth',
        `DSH auth credentials file ${this.credentialsFile}: ${(err as Error).message}`,
      );
    }
  }

  /** 指纹未变时复用缓存的 signing secret；变化（或首读）时重新读盘解析。 */
  private async resolveCredentialsSecret(): Promise<Buffer> {
    // stat 只作缓存闸门：stat 失败（含 ENOENT）不自行抛——照旧调用 readCredentials，
    // 由它产出真实错误（注入的测试 reader 不 stat，错误契约必须保持不变）。
    const stat = await fs.promises.stat(this.credentialsFile).catch(() => undefined);
    if (
      stat &&
      this.secretCache &&
      this.secretCache.mtimeMs === stat.mtimeMs &&
      this.secretCache.size === stat.size
    ) {
      return this.secretCache.secret;
    }
    const secret = await this.readCredentials(this.credentialsFile);
    this.secretCache = stat ? { mtimeMs: stat.mtimeMs, size: stat.size, secret } : undefined;
    return secret;
  }

  /**
   * Perform a unary POST and return the ok value; throws DshError on failure.
   *
   * `signal` aborts the request when the run is stopped; a timeout (default
   * `requestTimeoutMs`) guards against a server that accepted the connection
   * but never answers. Both are composed into the request's AbortSignal.
   */
  async unary(
    method: string,
    payload: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const ctx = prepareUnary(opts, this.requestTimeoutMs);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attemptUnary(method, payload, opts, ctx, attempt);
      if (result.kind === 'done') return result.value;
    }
    throw new DshError('auth', `DSH ${method} authentication failed after refresh`);
  }

  /** One unary POST attempt: obtain cookie, then post; both stages may ask to
   *  retry once (401 → re-mint cookie); all other failures throw DshError. */
  private async attemptUnary(
    method: string,
    payload: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number },
    ctx: UnaryContext,
    attempt: number,
  ): Promise<UnaryAttemptResult> {
    const cookieResult = await this.obtainUnaryCookie(method, opts, ctx, attempt);
    if (cookieResult.kind === 'retry') return { kind: 'retry' };
    return this.postUnary(method, payload, opts, ctx, cookieResult.cookie, attempt);
  }

  private async obtainUnaryCookie(
    method: string,
    opts: { signal?: AbortSignal; timeoutMs?: number },
    ctx: UnaryContext,
    attempt: number,
  ): Promise<{ kind: 'cookie'; cookie: string | undefined } | { kind: 'retry' }> {
    if (opts.signal?.aborted) {
      throw new DshError('aborted', `DSH unary ${method} aborted before send`);
    }
    try {
      return { kind: 'cookie', cookie: await this.authCookie(attempt > 0, ctx.signal) };
    } catch (err) {
      if (opts.signal?.aborted || ctx.signal?.aborted) {
        throw abortErrorOf(method, err, opts.signal, ctx.timeoutSignal, ctx.timeoutMs);
      }
      // A token bootstrap can race a DSH restart; retry once with a fresh
      // credentials read before surfacing the deterministic auth failure.
      if (
        attempt === 0 &&
        err instanceof DshError &&
        err.code === 'http' &&
        err.details.status === 401
      ) {
        getLogger().warn(`[dsh] 401 while authenticating ${method}, re-minting cookie once`);
        return { kind: 'retry' };
      }
      throw err;
    }
  }

  private async postUnary(
    method: string,
    payload: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number },
    ctx: UnaryContext,
    cookie: string | undefined,
    attempt: number,
  ): Promise<UnaryAttemptResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'client-request',
          rpcId: ctx.rpcId,
          method,
          payload: { args: dshArgs(method, payload) },
        }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      if (opts.signal?.aborted || ctx.signal?.aborted) {
        throw abortErrorOf(method, err, opts.signal, ctx.timeoutSignal, ctx.timeoutMs);
      }
      throw new DshError(
        'transport',
        `DSH unary ${method} transport error: ${(err as Error).message}`,
      );
    }
    if (opts.signal?.aborted) {
      throw new DshError('aborted', `DSH unary ${method} aborted`);
    }
    if (res.status === 401 && attempt === 0) {
      this.cookiePromise = undefined;
      getLogger().warn(`[dsh] 401 for ${method}, re-minting cookie once`);
      return { kind: 'retry' };
    }
    if (res.status === 401) {
      throw new DshError(
        'http',
        `DSH HTTP 401 for ${method}: 认证失败；请确认 ${this.credentialsFile} 可读，` +
          '或在 config.yaml 的 agents.dsh.token 填入当前 dsh web 启动 token。' +
          '若凭据文件可读且格式正确仍返回 401，请查看 DSH 日志确认认证方式',
        { status: 401 },
      );
    }
    return { kind: 'done', value: await readUnaryBody(method, res) };
  }

  /** Create a session. Pass `agentPreset` to pin the session's preset (fixed at
   *  creation). */
  async createSession(
    payload: {
      cwd: string;
      agentPreset?: string;
    },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ sessionId: string; agentPreset?: string }> {
    return (await this.unary('session/create', payload, opts)) as {
      sessionId: string;
      agentPreset?: string;
    };
  }

  /** Align the session's model/reasoningEffort (also persists as global default
   *  server-side). Failures are surfaced as DshError for the caller to downgrade. */
  async selectModel(
    payload: DshModelSelection & { sessionId: string },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshModelSelection> {
    const value = (await this.unary('session/selectModel', payload, opts)) as {
      selected: DshModelSelection;
    };
    return value.selected;
  }

  /** Read the model catalog (session/modelCatalog). */
  async listModels(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<DshModelCatalogValue> {
    return (await this.unary('session/modelCatalog', {}, opts)) as DshModelCatalogValue;
  }

  /**
   * Wait until the Host accepts session RPCs.
   *
   * 0.2.2 mounts the HTTP gateway before `sessionController` finishes its
   * asynchronous `Service.init`: `/api/` is already authenticated while
   * `session/*` calls still answer `gateway/service-unavailable`. The daemon
   * probe only proves HTTP liveness, so the first session RPC must be gated on
   * this business-level probe instead.
   *
   * Compatibility: retry only errors that prove the endpoint exists but its
   * service/context is still starting (or a boot-time transport/timeout/5xx
   * failure). Any other failure is inconclusive — log and proceed — so an
   * older Host is never blocked by a probe it does not implement.
   */
  async waitForSessionService(
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SERVICE_READY_TIMEOUT_MS;
    if (timeoutMs <= 0) return;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) {
        throw new DshError('aborted', 'DSH session service readiness aborted');
      }
      try {
        await this.unary(
          'session/list',
          {},
          {
            signal: opts.signal,
            timeoutMs: Math.max(1, Math.min(SERVICE_READY_PROBE_TIMEOUT_MS, deadline - Date.now())),
          },
        );
        return;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (!isDshTransientAvailabilityError(err)) {
          getLogger().info(
            `[dsh] session readiness probe inconclusive (${(err as Error).message}); continuing`,
          );
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new DshError(
            'service-not-ready',
            `DSH 服务端在 ${timeoutMs}ms 内未完成 session 服务启动（可能正在启动或升级）：${(err as Error).message}`,
          );
        }
        attempt += 1;
        const backoff = Math.min(
          SERVICE_READY_BACKOFF_MAX_MS,
          SERVICE_READY_BACKOFF_MS * 2 ** Math.min(attempt - 1, 4),
        );
        getLogger().warn(
          `[dsh] session service not ready yet (attempt ${attempt}); retrying in ${Math.min(backoff, remaining)}ms`,
        );
        await this.sleepWithAbort(Math.min(backoff, remaining), opts.signal);
      }
    }
  }

  /** Abortable sleep used by the readiness gate; run() must stay stoppable. */
  private async sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DshError('aborted', 'DSH session service readiness aborted'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      function cleanup(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      function onAbort(): void {
        cleanup();
        reject(new DshError('aborted', 'DSH session service readiness aborted'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Execute one slash command against a session (commands/execute).
   *
   * This is the only way to run a DSH command: `session/prompt` turns the text
   * into an ordinary user message and never routes it through the command
   * registry, so `/compact` sent as a prompt would just be model input.
   *
   * The RPC settles when the handler settles, not when it is accepted: DSH's
   * `/compact` waits for the compaction to finish. Callers therefore must pass
   * an explicit `timeoutMs` (0 = no unary budget) and rely on their own
   * cancellation/watchdog instead of the 60s default.
   */
  async executeCommand(
    sessionId: string,
    line: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshCommandResult | undefined> {
    const value = (await this.unary(
      'commands/execute',
      { agentId: sessionId, line, submittedAttachments: [] },
      opts,
    )) as
      | {
          commandId?: unknown;
          result?: { kind?: unknown; text?: unknown; sourceEventSeq?: unknown };
          kind?: unknown;
          text?: unknown;
          sourceEventSeq?: unknown;
        }
      | undefined;
    if (!value || typeof value !== 'object') return undefined;
    const result = value.result && typeof value.result === 'object' ? value.result : value;
    return {
      ...(typeof value.commandId === 'string' ? { commandId: value.commandId } : {}),
      ...(result.kind === 'success' || result.kind === 'error' ? { kind: result.kind } : {}),
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(typeof result.sourceEventSeq === 'number'
        ? { sourceEventSeq: result.sourceEventSeq }
        : {}),
    };
  }

  /** Read the preset catalog (agentPresets/list). */
  async listPresets(): Promise<DshPresetListValue> {
    return (await this.unary('agentPresets/list', {})) as DshPresetListValue;
  }

  /** Read the permission preset catalog (permissionPresets/catalog). */
  async listPermissionPresets(): Promise<DshPermissionCatalogValue> {
    return (await this.unary('permissionPresets/catalog', {})) as DshPermissionCatalogValue;
  }

  /** Answer one forwarded approval waterfall ($events/result). */
  async answerRemoteEvent(
    clientId: string,
    eventId: string,
    outcome: DshRemoteEventOutcome,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.unary('$events/result', { clientId, eventId, outcome }, opts);
  }

  /**
   * Return the highest event `seq` currently persisted for the session.
   *
   * `session/projections` is the unary watermark (the old `session.history`
   * high-water scan is gone in 0.2.x). The caller snapshots this before
   * `session/prompt` so a follow snapshot can skip already-completed turns.
   */
  async latestEventSeq(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<number> {
    const value = await this.projectionSnapshot(sessionId, opts);
    return typeof value?.asOfSeq === 'number' ? value.asOfSeq : -1;
  }

  /** Read one cold history page. `throughSeq` normally comes from
   *  `latestEventSeq()`; `session/page` needs an inclusive cursor. */
  async page(
    sessionId: string,
    throughSeq: number,
    maxMessages: number,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshSessionPageValue> {
    return (await this.unary(
      'session/page',
      {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages,
      },
      opts,
    )) as DshSessionPageValue;
  }

  /**
   * Read the session's exact projection values.
   *
   * Returns `null` when the host has no projections for the session (e.g. it was
   * deleted). A failed unary still throws — callers that only need a
   * best-effort probe catch it themselves.
   */
  async projectionSnapshot(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshProjectionSnapshot | null> {
    const value = (await this.unary('session/projections', { sessionId }, opts)) as {
      asOfSeq?: unknown;
      values?: unknown;
    } | null;
    if (!value || typeof value !== 'object') return null;
    return {
      ...(typeof value.asOfSeq === 'number' ? { asOfSeq: value.asOfSeq } : {}),
      values:
        value.values && typeof value.values === 'object' && !Array.isArray(value.values)
          ? (value.values as Record<string, unknown>)
          : {},
    };
  }

  /**
   * Read the session's current goal (authoritative at call time).
   *
   * 收尾判定必须用宿主状态：本轮 turn 结束不代表任务结束——goal 仍 active 且
   * armed 时 driver 会在 quiescence 立刻起下一轮。`known:false` 表示读不到，
   * 调用方不得据此断言"已完成"（探测失败降级为收尾，正是"任务还在跑却写完成"
   * 的来源）。
   *
   * `phase` 来自 durable 投影，`activation` 来自 `goals/get`（进程内状态，投影
   * 故意不持久化）：宿主重启、`/stop`、agent error 之后 goal 仍是 active 但
   * disarmed，driver 不再起轮——这种卡片的会话是空闲的，Compact 必须可用。
   * activation 读不到时留空（调用方按"可能续跑"保守处理），不影响 known。
   */
  async goalState(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ known: boolean; goal: GoalView | null }> {
    let snapshot: DshProjectionSnapshot | null;
    try {
      snapshot = await this.projectionSnapshot(sessionId, opts);
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      getLogger().warn(`[dsh] goal probe failed session=${sessionId}: ${(err as Error).message}`);
      return { known: false, goal: null };
    }
    // 拿不到投影 = 宿主没这个会话的投影，不等于"没有 goal"。
    if (!snapshot) return { known: false, goal: null };
    // 投影快照存在但没有 goal 域 = 宿主明确没有目标（未用过 goal 的会话就是这样）。
    // 不能把缺失当成"读不懂"：goalFromProjection(undefined) 也返回 undefined，
    // 那会把每次普通会话都误报成「目标状态未确认」。
    if (!('goal' in snapshot.values)) return { known: true, goal: null };
    const parsed = goalFromProjection(snapshot.values.goal);
    if (parsed === undefined) return { known: false, goal: null };
    // activation 只对 active goal 有意义（其它 phase 本来就不会续跑），
    // 也就没必要为普通收尾多打一次 unary。
    if (parsed === null || parsed.phase !== 'active') return { known: true, goal: parsed };
    const activation = await this.goalActivation(sessionId, parsed.id, opts?.signal);
    return { known: true, goal: activation ? { ...parsed, activation } : parsed };
  }

  /**
   * Best-effort read of the process-local goal activation.
   *
   * `goals/get` 是 agent 维度的实时视图；agent 不在线（run 已收尾、宿主刚
   * 重启）时会失败。这里返回 undefined 表示"读不到"，绝不让它把整个 goal
   * 探测降级成 unknown——phase 仍是权威的。
   */
  private async goalActivation(
    sessionId: string,
    goalId: string,
    signal?: AbortSignal,
  ): Promise<GoalView['activation']> {
    try {
      const live = goalFromLiveView(
        await this.unary(
          'goals/get',
          { agentId: sessionId },
          {
            ...(signal ? { signal } : {}),
            timeoutMs: GOAL_ACTIVATION_PROBE_TIMEOUT_MS,
          },
        ),
      );
      // id 不一致 = 两次读之间 goal 被换掉：activation 不能安到旧 goal 上。
      return live?.id === goalId ? live.activation : undefined;
    } catch (err) {
      if (signal?.aborted) return undefined;
      getLogger().warn(
        `[dsh] goal activation probe failed session=${sessionId}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Find this run's prompt if it is still sitting in the host's inbox.
   *
   * DSH 的 prompt 受理后先进入 inbox，被 turn 取走（claim）就不再出现；停止
   * 时用它区分“还没开始 → 可以从队列里撤掉”和“已经在跑 → 只能 cancel”。
   * `source.rpcId` 是 `session/prompt` 的 requestId，归属不会认错。
   */
  async findPendingPrompt(
    sessionId: string,
    requestId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<string | undefined> {
    const snapshot = await this.projectionSnapshot(sessionId, opts);
    if (!snapshot) return undefined;
    return inboxItemsOf(snapshot.values).find(
      (item) => item.source?.kind === 'user' && item.source.rpcId === requestId,
    )?.id;
  }

  /**
   * Remove one not-yet-claimed inbox occurrence (`session/updateQueue`).
   *
   * @returns true when the host removed it; false when it was claimed between
   *   the projection read and this call (`session/queue-item-not-found`).
   */
  async removeQueuedPrompt(
    sessionId: string,
    itemId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<boolean> {
    try {
      await this.unary(
        'session/updateQueue',
        { sessionId, itemId, action: { kind: 'remove' } },
        opts,
      );
      return true;
    } catch (err) {
      if (err instanceof DshError && err.code === 'session/queue-item-not-found') return false;
      throw err;
    }
  }

  /**
   * Whether the session still has a running turn.
   *
   * 主信号是 `session/list` 的 `running` 字段：服务端权威（会话列表页"运行中"
   * 用的就是它），一次 unary，投票不受桥接进程内存影响。名单里没有该会话或
   * 服务端不返回 `running` 时，回退到事件探测（{@link probeOpenTurnByEvents}），
   * 两者都判不出来就返回 false（fail open，仍由 DSH 自己拒绝）。
   */
  async hasOpenTurn(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<boolean> {
    return (await this.openTurnState(sessionId, opts)) === 'open';
  }

  /**
   * Tri-state version of {@link hasOpenTurn}.
   *
   * Stop verification must distinguish "the host says idle" from "the probe
   * could not tell" — reporting `closed` on a failed probe would let a still
   * running turn be reported as stopped. `unknown` is the honest answer there.
   */
  async openTurnState(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshOpenTurnState> {
    try {
      const list = (await this.unary('session/list', {}, opts)) as DshSessionListValue;
      const row = list?.items?.find((item) => String(item.sessionId) === sessionId);
      if (row && typeof row.running === 'boolean') return row.running ? 'open' : 'closed';
    } catch (err) {
      getLogger().warn(
        `[dsh] open-turn probe: session/list failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
    return this.probeOpenTurnByEvents(sessionId, opts);
  }

  /**
   * Fallback probe: the newest durable event's type tells whether a turn is open.
   *
   * 只在拿不到 `running` 时用。名单刻意保守——`job/*`（后台任务可在 turn 外
   * 结算）、`turn/end` 都不算，判不出来就报告 `unknown`。
   *
   * 落盘顺序已从 DSH 源码验证（packages/core/agent-loop：agent.ts 的 turn()/
   * step() + inbox.ts 的 mutate()）：prompt 提交只落 `agent/inbox/spliced`，
   * `turn/start` 由 turn() 在认领前 append，`user/message` 在 step() 认领时才
   * append——顺序是 spliced → turn/start → user/message。两个边界：
   *
   * - 尾部 `agent/inbox/spliced` → closed 是**对的**：turn 尚未打开，cancel
   *   空闲 session 无害，随后 withdraw 探测会撤走排队 prompt；
   * - 尾部 `user/message` → **unknown**：step() 里 user/message append 后要等
   *   一整个 LLM 往返才有下一条 durable 事件（assistant 流帧是 process-local
   *   的），这个秒级窗口内 turn 已打开；且压缩 checkpoint 也以 turn:null 落
   *   user/message——两种解释并存时只能报 unknown（stop 按 unconfirmed 处理，
   *   不假报已停止）。此前报 closed 会让一个 LLM 往返宽的窗口假报干净停止。
   */
  private async probeOpenTurnByEvents(
    sessionId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DshOpenTurnState> {
    try {
      // A missing projection snapshot is not "idle": the host simply cannot
      // tell us. Only a known watermark with no events (or a closed tail) is
      // evidence that no turn is open.
      const snapshot = await this.projectionSnapshot(sessionId, opts);
      if (!snapshot || typeof snapshot.asOfSeq !== 'number' || snapshot.asOfSeq < 0) {
        return 'unknown';
      }
      const value = await this.page(sessionId, snapshot.asOfSeq, 1, opts);
      const last = value.records.at(-1)?.event;
      if (last === undefined) return 'closed';
      if (last.type === 'user/message') return 'unknown';
      return last.type === 'turn/start' || IN_TURN_EVENT_TYPES.has(last.type) ? 'open' : 'closed';
    } catch (err) {
      getLogger().warn(
        `[dsh] open-turn probe failed for session ${sessionId}: ${(err as Error).message}`,
      );
      return 'unknown';
    }
  }

  /**
   * One logical stream over `/api/remote.mux`. The WebSocket must carry the
   * same auth cookie as unary calls. Ends on the server's `end` frame, socket
   * close, error, or `signal` abort.
   */
  private async *muxStream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<unknown> {
    yield* openMuxStream({
      baseUrl: this.baseUrl,
      endpoint,
      payload,
      signal,
      requestTimeoutMs: this.requestTimeoutMs,
      authCookie: () => this.authCookie(),
      webSocketFactory: this.webSocketImpl,
    });
  }

  /** One logical `session/follow` stream. */
  private async *followStream(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<DshFollowFrame> {
    const payload = {
      args: dshArgs('session/follow', {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: FOLLOW_MAX_MESSAGES,
      }),
    };
    for await (const frame of this.muxStream('session/follow', payload, signal)) {
      yield frame as DshFollowFrame;
    }
  }

  /**
   * Consume the Gateway-owned `$events` stream. The stream is owner-only and
   * answer-capable; each waterfall for another session is delegated with
   * `next` so a different lark-remote workspace cannot park it.
   */
  async *approvalEvents(
    sessionId: string,
    signal: AbortSignal,
  ): AsyncGenerator<DshApprovalStreamItem> {
    const state: ApprovalStreamState = {
      authRefreshAttempted: false,
      reconnectAttempts: 0,
      sawReady: false,
    };
    while (!signal.aborted) {
      // 每次重连重置本次连接的 ready 身份；auth 刷新与重连预算跨连接保留。
      state.sawReady = false;
      state.streamClientId = undefined;
      try {
        for await (const raw of this.muxStream('$events', { args: {} }, signal)) {
          if (signal.aborted) return;
          const result = processApprovalFrame(
            state,
            raw as DshRemoteEventFrame,
            sessionId,
            signal,
            this,
          );
          for (const item of result.items) yield item;
          if (result.stop) return;
        }
      } catch (err) {
        const action = classifyApprovalStreamError(err, state, signal);
        if (action.kind === 'return') return;
        if (action.kind === 'refresh-auth') {
          state.authRefreshAttempted = true;
          this.cookiePromise = undefined;
          getLogger().warn(
            `[dsh] approval event stream authentication expired; refreshing credentials and reconnecting once`,
          );
          continue;
        }
        if (action.kind === 'reconnect') {
          state.reconnectAttempts = action.attempt;
          getLogger().warn(
            `[dsh] approval event stream dropped (attempt ${action.attempt}/3); reconnecting`,
          );
          await reconnectBackoff();
          continue;
        }
        getLogger().warn(`[dsh] approval event stream unavailable: ${action.message}`);
        yield { kind: 'unavailable', message: action.message };
        return;
      }
      const tail = approvalStreamTail(state, signal);
      if (tail === 'aborted') return;
      if (tail === 'reconnect') {
        getLogger().warn(
          `[dsh] approval event stream ended (attempt ${state.reconnectAttempts}/3); reconnecting`,
        );
        await reconnectBackoff();
        continue;
      }
      // A clean end before ready means the Host does not expose `$events`;
      // fall back to the Web UI prompt instead of retrying forever.
      yield { kind: 'unavailable', message: 'DSH approval event stream ended' };
      return;
    }
  }

  /**
   * Per-session subscription: yields session events, assistant stream chunks
   * and approval notices for `sessionId`, auto-reconnecting on stream
   * drop/error and replaying the follow snapshot (dedup by seq). Terminates on
   * the run's own turn/end or `signal` abort.
   *
   * `promptRequestId` binds the stream to this run's prompt. `mode:'queue'`
   * prompts are accepted while the agent is mid-turn and start a turn only
   * later, so the first `turn/end` after `initialSeq` can belong to that OTHER
   * turn. Everything recorded before the prompt's own durable `user/message`
   * (whose source echoes the request id as `rpcId`) is foreign: dropping it
   * keeps the card "running" until this run's turn actually finishes.
   */
  async *sessionEvents(
    sessionId: string,
    signal: AbortSignal,
    initialSeq = -1,
    promptRequestId?: string,
  ): AsyncGenerator<DshStreamItem> {
    const state: SessionStreamState = {
      lastSeq: initialSeq,
      owns: promptRequestId === undefined,
      foreignTailReported: false,
      sessionId,
      promptRequestId,
      authRefreshAttempted: false,
    };
    // 指数退避：连续无进展的重连轮数（收到任何一帧即归零）。宿主宕机而 run
    // 在途时，固定 200ms 会造成每秒 ~5 次「握手+快照重放」风暴；指数退避把
    // 稳态压到 5s/次，瞬断仍按第一档快速恢复。
    let failedReconnects = 0;
    // 从第一次「已断开」开始计时；收到任何帧即清零。只惩罚断连，不惩罚
    // 连接正常但模型长时间不出帧——后者由 turn idle / idle 看门狗负责。
    let disconnectedSince: number | undefined;
    while (!signal.aborted) {
      let receivedFrame = false;
      try {
        for await (const frame of this.followStream(sessionId, signal)) {
          if (signal.aborted) return;
          receivedFrame = true;
          disconnectedSince = undefined;
          state.authRefreshAttempted = false;
          for (const ev of await sessionFrameEvents(this, state, frame, signal)) {
            const step = advanceSessionEvent(state, ev);
            if (!step) continue;
            if (step.item) yield step.item;
            if (step.done) return;
          }
          if (frame.type === 'assistant-stream' && state.owns) {
            // Mid-turn deltas of the turn this prompt is queued behind.
            yield { kind: 'assistant-stream', sessionId, frame: frame.frame };
          }
        }
      } catch (err) {
        const action = classifySessionStreamError(err, state, signal);
        if (action.kind === 'return') return;
        if (action.kind === 'refresh-auth') {
          state.authRefreshAttempted = true;
          this.cookiePromise = undefined;
          getLogger().warn(
            `[dsh] remote mux authentication expired for session ${sessionId}; refreshing credentials and reconnecting once`,
          );
          continue;
        }
        if (action.kind === 'rethrow') throw err;
        disconnectedSince ??= Date.now();
        getLogger().warn(
          `[dsh] remote mux disconnected for session ${sessionId}: ${(err as Error).message}; reconnecting`,
        );
      }
      if (signal.aborted) return;
      // 干净 end（没有异常）同样是一次断连：重连成功后收到帧才会清零。
      disconnectedSince ??= Date.now();
      const disconnectedAt = disconnectedSince;
      if (
        this.streamDisconnectTimeoutMs > 0 &&
        disconnectedAt !== undefined &&
        Date.now() - disconnectedAt >= this.streamDisconnectTimeoutMs
      ) {
        throw new DshError(
          'unavailable',
          `DSH 服务端已连续 ${Math.max(1, Math.round((Date.now() - disconnectedAt) / 1000))}s 不可达` +
            '（可能正在重启或升级）；本轮已终止，请稍后重试',
        );
      }
      // 本轮拿到过帧 = 连接曾恢复：退避归零后按首轮节奏重连（干净断开同理）。
      const backoff = reconnectBackoffMs(receivedFrame ? 0 : failedReconnects);
      failedReconnects = receivedFrame ? 0 : failedReconnects + 1;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  /**
   * 快照缺口回填（经 DSH 源码验证后实现）。
   *
   * follow 开场快照按**消息**截取：host 的 paginate 只数 user/assistant
   * message（工具事件随所在消息组搭车进快照，不占预算），`maxMessages` 内
   * 装不下的更早前缀被截掉并以 `hasMore: true` 标记。断连期间积压超过
   * FOLLOW_MAX_MESSAGES 条消息时，`lastSeq` 与快照起点之间的缺口若不补，
   * 这些事件对本次 follow 永久缺失（卡片丢中段工具行；seq 去重只防重放
   * 不补缺）。`session/page` 的 `throughSeq` 游标正是服务端为此设计的回填
   * 通道——从缺口尾部向前翻页直到盖住 lastSeq、翻到日志头或达到页数上限。
   *
   * best-effort：翻页失败保留已取回的部分（缺口剩余与旧行为一致地丢失，
   * 但只发生在超出 BACKFILL_MAX_PAGES×PAGE_MESSAGES 条消息的极端断连）。
   * 返回 seq 升序的完整回放序列（回填 + 快照记录；与 lastSeq 重叠的条目
   * 由回放循环的 seq 去重兜住）。
   */
  async replaySnapshotGap(
    sessionId: string,
    signal: AbortSignal,
    lastSeq: number,
    frame: DshFollowSnapshot,
  ): Promise<DshSessionEvent[]> {
    const records = (frame.records ?? [])
      .map((record) => record.event)
      .filter((ev): ev is DshSessionEvent => !!ev);
    if (frame.hasMore !== true || signal.aborted) return records;
    const firstSeq = records[0]?.seq;
    const gapEnd = firstSeq !== undefined ? firstSeq - 1 : frame.cursor;
    if (gapEnd <= lastSeq) return records;

    const pages: DshSessionEvent[][] = [];
    try {
      let throughSeq = gapEnd;
      for (let page = 0; page < FOLLOW_GAP_BACKFILL_MAX_PAGES; page++) {
        const value = await this.page(sessionId, throughSeq, FOLLOW_GAP_BACKFILL_PAGE_MESSAGES, {
          signal,
        });
        const events = (value.records ?? [])
          .map((record) => record.event)
          .filter((ev): ev is DshSessionEvent => !!ev);
        if (events.length > 0) pages.push(events);
        const oldest = events[0]?.seq;
        // hasMore=false（日志头）或本页已盖住 lastSeq：缺口补齐，停。
        if (value.hasMore !== true || oldest === undefined || oldest <= lastSeq + 1) break;
        throughSeq = oldest - 1;
      }
    } catch (err) {
      getLogger().warn(
        `[dsh] follow snapshot gap backfill incomplete sessionId=${sessionId}: ${(err as Error).message}`,
      );
    }
    // pages 是「从新到旧」收集的；倒序拼接得到 seq 升序回放。
    const backfill: DshSessionEvent[] = [];
    for (let index = pages.length - 1; index >= 0; index--) backfill.push(...pages[index]!);
    if (backfill.length > 0) {
      getLogger().info(
        `[dsh] backfilled ${backfill.length} events before follow snapshot sessionId=${sessionId} gapEnd=${gapEnd} lastSeq=${lastSeq}`,
      );
    }
    return [...backfill, ...records];
  }

  /**
   * Host-wide live projection stream (`session/control`).
   *
   * 一份 baseline（当前所有活跃 session 的完整投影值）+ 之后每个投影的变化帧。
   * 调用方按 sessionId 过滤：这是 DSH 上唯一"服务端变一次推一次"的通道，
   * 不需要轮询 `session/projections`。
   *
   * 失败必须降级为"没有状态条"，不能影响 run：控制流是增强通道，断了运行
   * 照常（异常在此吞掉并记日志，不向 merge 抛）。
   */
  async *controlFrames(signal: AbortSignal): AsyncGenerator<DshProjectionItem> {
    try {
      // mux 的 payload 与 unary 同信封：`{args:{...}}`。control 无参数，故空 args；
      // 少了这层包装网关直接拒绝（live 实测 0 帧，测试用假服务端不会发现）。
      for await (const raw of this.muxStream('session/control', { args: {} }, signal)) {
        const frame = raw as {
          type?: string;
          sessionId?: string;
          key?: string;
          value?: unknown;
        };
        if (!frame || typeof frame !== 'object') continue;
        if (frame.type === 'baseline') {
          const projections =
            (frame.value as { projections?: Record<string, unknown> } | undefined)?.projections ??
            {};
          for (const [sessionId, snapshot] of Object.entries(projections)) {
            const values =
              (snapshot as { values?: Record<string, unknown> } | undefined)?.values ?? {};
            for (const [key, value] of Object.entries(values)) {
              yield { kind: 'projection', sessionId, key, value };
            }
          }
          continue;
        }
        if (frame.type === 'projection' && frame.sessionId && frame.key) {
          yield {
            kind: 'projection',
            sessionId: frame.sessionId,
            key: frame.key,
            value: frame.value,
          };
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      getLogger().warn(
        `[dsh] session/control stream unavailable (${(err as Error).message}); run continues without live status`,
      );
    }
  }

  /**
   * Subscribe to one session's background-job roster as a live stream.
   *
   * `job/list` 是整份替换流（whole-set replacement）：首帧就是当前真相，之后
   * 任务生命周期一变就再推一整份。**run 结束之后**必须用这个长订阅——后台任务
   * 跨 turn 存活，任务结束这件事只会在这条流上出现；收尾时取首帧即断开
   * （{@link jobRows}）只够画那一瞬间的卡片。
   */
  async *watchJobs(sessionId: string, signal: AbortSignal): AsyncGenerator<DshJobView[]> {
    for await (const frame of this.muxStream(
      'job/list',
      { args: dshArgs('job/list', { sessionId }) },
      signal,
    )) {
      const rows = frame as { type?: string; jobs?: unknown };
      if (rows?.type !== 'rows') continue;
      yield Array.isArray(rows.jobs) ? (rows.jobs as DshJobView[]) : [];
    }
  }

  /**
   * One session's current background-job roster (snapshot).
   *
   * "此刻有哪些任务在跑"只需要第一帧：文档明确首帧就是当前真相，取到即断开，
   * 不长期持有连接。失败返回 undefined（与"没有任务"区分）：拿不到就别在卡片
   * 上写"0 个后台任务"。
   */
  async jobRows(
    sessionId: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DshJobView[] | undefined> {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), opts.timeoutMs ?? 2_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
    try {
      for await (const rows of this.watchJobs(sessionId, signal)) return rows;
      return undefined;
    } catch (err) {
      getLogger().debug(`[dsh] job/list unavailable: ${(err as Error).message}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
      timer.abort();
    }
  }

  /** Kill one background job on the user's behalf (`job/kill`). */
  async jobKill(
    sessionId: string,
    jobId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    try {
      await this.unary('job/kill', { sessionId, jobId }, opts);
      return true;
    } catch (err) {
      getLogger().warn(`[dsh] job/kill failed job=${jobId}: ${(err as Error).message}`);
      return false;
    }
  }
}

/** Stable client-side prompt identity persisted on the accepted user message. */
export function newPromptRequestId(): string {
  return `lark-remote-${randomUUID()}`;
}

/**
 * Read the questions of one `user-questions/request` waterfall.
 *
 * Returns undefined when the batch cannot be answered through the Feishu card:
 * malformed fields, or duplicate question texts — the approval coordinator
 * keys answers by question text, so duplicates would answer the wrong one.
 * The caller delegates such a batch back to the DSH Web UI.
 */
export function dshQuestionsOf(request: Record<string, unknown>): DshQuestion[] | undefined {
  const raw = request.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: DshQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const text = typeof record.question === 'string' ? record.question : '';
    if (!id || !text) return undefined;
    if (seen.has(text)) return undefined;
    seen.add(text);
    const options: DshQuestionOption[] = [];
    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) return undefined;
      for (const rawOption of record.options) {
        if (rawOption === null || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
          return undefined;
        }
        const option = rawOption as Record<string, unknown>;
        const label = typeof option.label === 'string' ? option.label : '';
        if (!label) return undefined;
        options.push({
          label,
          ...(typeof option.description === 'string' && option.description
            ? { description: option.description }
            : {}),
        });
      }
    }
    questions.push({
      id,
      question: text,
      ...(typeof record.detail === 'string' && record.detail ? { detail: record.detail } : {}),
      ...(typeof record.header === 'string' && record.header ? { header: record.header } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

/**
 * True for a timed (`askTimed`) request — `wait.timed` in the projected payload.
 *
 * Timed asks settle at their own foreground deadline and then close the
 * waterfall, so an answer sent outside that window can never land. Such a
 * request belongs to the client that claims the wait (`attachWait`) and renders
 * its countdown, i.e. the DSH Web UI; the card must not offer answers that expire
 * silently on the server side.
 */
export function isTimedQuestionRequest(request: Record<string, unknown>): boolean {
  const wait = request.wait;
  if (wait === null || typeof wait !== 'object' || Array.isArray(wait)) return false;
  return (wait as Record<string, unknown>).timed === true;
}
