import {
  createLarkChannel,
  type CardActionEvent,
  type CardActionResponse,
  type CardStreamProducer,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuite/channel';
import type { AppConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';
import { MAX_FILE_UPLOAD_SIZE } from './file-limits.js';
import { DEFAULT_INBOUND_MEDIA_MAX_SIZE_MB } from '../config/index.js';
import { stripPlaceholders } from '../inbound/placeholder.js';
import { sleep } from '../common/sleep.js';
import { isTransientTransportError } from '../error-classification.js';
import axios from 'axios';
import fs from 'node:fs';
import { silentlyUnlink } from '../common/fs.js';
import { displayName } from '../platform/path.js';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import FormData from 'form-data';

/**
 * Dedicated https.Agent with keepAlive disabled for sendFile's three axios
 * calls (token, upload, send). Bun's Node.js http compat layer has a bug
 * where it reuses keep-alive sockets that the server has already RST'd —
 * the write goes into a dead socket and the caller gets ECONNRESET after
 * ~30s. Node.js proper does not exhibit this because it checks socket
 * health before reuse. Disabling keep-alive forces a fresh TCP+TLS
 * handshake per request, eliminating the stale-socket path at the cost of
 * one extra round-trip per file send (acceptable for an infrequent
 * operation).
 */
const noKeepAliveAgent = new https.Agent({ keepAlive: false });

/**
 * dedup 缓存 TTL（毫秒）。控制飞书事件去重窗口，全局作用于 message + cardAction。
 *
 * 必须远小于用户连击间隔，否则同一按钮的连续点击会被当成"重复事件"丢弃：
 * - SDK 的 cardAction dedup eventId = `card:{messageId}:{operator.openId}:{actionId}`
 * - actionId = `tag|name|option|JSON.stringify(value)`，不含时间戳/事件序号
 * - config 卡片原地更新（updateCardInPlace），用户在同一张卡上重复触发
 *   固定 value 的按钮（如 config.toggle）：
 *   messageId / operator / value 三段都相同 → eventId 完全相同 → 第二次点击被
 *   seenCache drop，toggle 不可逆（第二次点击静默失效）。
 *
 * SDK 默认 12h 太长；60s 仍会误伤连击。300ms 挡飞书瞬时重投递（<100ms 级），
 * 放过用户连击（慢点两次通常 >500ms）。代价：削弱 message 秒级重投递防护——
 * 飞书 WS 正常连接不重发，重连补发延迟常 >60s 本就挡不住，串行队列（§9.6）
 * 还兜底防并发，影响可接受。
 *
 * 此 bug 无法在 stub connector 测试中复现（测试绕过 SDK safety 层）。
 * 详见 design.md §9.8。原地更新逻辑新增按钮时参考该节去重风险分类。
 */
export const DEDUP_TTL_MS = 300;

/**
 * SDK converter 注册表支持的 msg_type（@larksuite/channel 0.7.1 实测）。
 * 带资源但类型不在其中 = 未来新增类型：照常下载 + warn（default-deny）。
 */
const KNOWN_RESOURCE_CONTENT_TYPES = new Set([
  'text',
  'post',
  'image',
  'file',
  'audio',
  'video',
  'media',
  'sticker',
  'interactive',
  'merge_forward',
  'share_chat',
  'share_user',
  'location',
  'system',
  'vote',
  'todo',
  'calendar',
  'general_calendar',
  'share_calendar_event',
  'folder',
  'hongbao',
  'video_chat',
]);

interface FeishuMessage {
  userId: string;
  messageId: string;
  chatId: string;
  content: string;
  /** 飞书原始 msg_type（`text` / `image` / `post` / `merge_forward` …）。 */
  rawContentType: string;
  /** 引用消息 id（回复某条消息时存在）。 */
  replyToMessageId?: string;
}

type MessageHandler = (msg: FeishuMessage) => void;

/**
 * 入站媒体（image/file 消息的 resource）下载结果，交给 bridge 落盘。
 * media 为通过大小限制、可落盘的项；failures 为下载失败或超限的项
 * （bridge 负责把这些失败提示回用户）。
 */
export interface InboundMediaItem {
  /**
   * 下载 type（飞书 `im.v1.messageResource.get` 只认 image/file 两个值，
   * 见 inbound-message-matrix.md §4 —— 不要扩展成 video/audio/sticker）。
   */
  type: 'image' | 'file';
  /** 资源种类（image/file/video/audio/sticker）：命名/展示语义，与下载 type 分离。 */
  kind: InboundResourceKind;
  /** 原始文件名（file 消息有；image 消息无，由 bridge 按 MIME 生成）。 */
  fileName?: string;
  /** 服务端 content-type（参数已剥离；可能缺失，bridge 有兜底）。 */
  mimeType?: string;
  /** 视频/语音时长（毫秒），透传给 prompt 附件块。 */
  durationMs?: number;
  /**
   * 下载内容所在临时文件（流式落盘，避免大文件全量进堆内存）。
   * 由 bridge 移动到最终位置；任何未移动路径都必须清理该文件。
   */
  tempPath: string;
}

export interface InboundMediaFailure {
  /** 资源种类（排障/回执分组用）。 */
  kind?: InboundResourceKind;
  fileName?: string;
  reason: string;
}

export interface InboundMediaPayload {
  userId: string;
  chatId: string;
  messageId: string;
  /** 引用上下文：不同 replyTo 强制拆批。 */
  replyToMessageId?: string;
  media: InboundMediaItem[];
  failures: InboundMediaFailure[];
}

/** 单资源下载超时（毫秒）：SDK 无内置超时，挂起会导致提示丢失 + 残留临时文件。 */
const RESOURCE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 合并转发（merge_forward）的聚合资源缺少 `message_id`，飞书要求 key 与 message_id
 * 同属一条消息（234003），且合并转发的资源下载本身被列为不支持（234043）。
 * 自建子消息遍历需要真机验证（inbound-message-matrix.md §5 Step 3），
 * 在验证完成前下载必然失败的场景给用户可执行的替代方案。
 */
const MERGE_FORWARD_HINT: Record<string, string> = {
  merge_forward: '（合并转发里的附件暂不支持保存，可逐条转发或直接发送文件）',
};

/** withTimeout 的超时专用错误：catch 侧据此知道清理已交给补删路径。 */
class ResourceTimeoutError extends Error {}

/**
 * 给没有超时的 SDK 调用套一层超时。**超时只是不再等它，底层操作照跑**
 * （`downloadResourceToFile` 没有 abort 入参），所以 onLateSettle 在操作自己
 * 结束时补做清理：此刻 unlink 在 win32 会被句柄占用挡到放弃、在 posix 只删掉
 * 目录项把空间留给未关闭的 fd，两种平台都可能留下孤儿文件。
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onLateSettle?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ResourceTimeoutError(`${label} timed out after ${ms}ms`));
      if (onLateSettle) promise.then(onLateSettle, onLateSettle);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 媒体消息到达的轻量描述（未下载）：供上层先做 owner/配置闸门，
 * 通过后再调 downloadInboundMedia —— 下载发生在认证之后（P1 review 修复）。
 */
/** SDK 给出的可下载资源种类（`resources[].type`）。 */
export type InboundResourceKind = 'image' | 'file' | 'audio' | 'video' | 'sticker';

export interface InboundMediaMessage {
  userId: string;
  chatId: string;
  messageId: string;
  /** 飞书原始 msg_type（未识别类型时用于 warn，default-deny 而非 default-text）。 */
  rawContentType: string;
  /** 引用上下文：不同 replyTo 强制拆批。 */
  replyToMessageId?: string;
  resources: Array<{
    /** 飞书下载接口 type（只有 image/file 两值）。 */
    type: 'image' | 'file';
    /** 资源种类（透传 SDK 的 `resources[].type`）。 */
    kind: InboundResourceKind;
    fileKey: string;
    fileName?: string;
    durationMs?: number;
  }>;
}

type InboundMediaDetectedHandler = (msg: InboundMediaMessage) => void | Promise<void>;

/**
 * CardAction handler may return a CardActionResponse (e.g. `{ toast: {...} }`)
 * to give the clicking user native immediate feedback. The SDK passes the
 * return value back to Feishu as the callback response. Returning void/undefined
 * means "no immediate response" (original behavior).
 */
type CardActionHandler = (
  action: CardActionEvent,
) => void | CardActionResponse | Promise<void | CardActionResponse>;

/**
 * 判断 send 失败是否值得重试一次（§9.5 限流重试口径，§P1-3 修正）。
 *
 * @larksuite/channel@0.7.1 的 classifyError 把飞书业务码 99991400/99991401
 * （频率控制）归类为 `code='permission_denied'`（SDK 源码实证），并保留原始
 * axios 错误在 `cause` 链上（`cause.response.data.code`）。因此仅判
 * `code === 'rate_limited'` 会让这条重试路径对设计目标完全死亡。判定覆盖：
 *  1. code === 'rate_limited'（HTTP 429，SDK 已内置退避重试，这里作为兜底保留）；
 *  2. context.feishuCode / cause.code / cause.data.code / cause.response.data.code
 *     命中 99991400 或 99991401；
 *  3. message 内含 99991400/99991401（低版本 SDK 把业务码拼进 msg 的兜底）。
 * 注意：普通 permission_denied（如缺 scope 的 99991663）不重试——重试无意义且
 * 会放大无效出站。
 */
function shouldRetrySendError(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    message?: unknown;
    context?: { feishuCode?: unknown };
    cause?: {
      code?: unknown;
      data?: { code?: unknown };
      response?: { data?: { code?: unknown } };
    };
  };
  if (e?.code === 'rate_limited') return true;
  const feishuCodes = [
    e?.context?.feishuCode,
    e?.cause?.code,
    e?.cause?.data?.code,
    e?.cause?.response?.data?.code,
  ];
  if (feishuCodes.some((c) => c === 99991400 || c === 99991401)) return true;
  if (typeof e?.message === 'string' && /9999140[01]/.test(e.message)) return true;
  return false;
}

/**
 * Narrow interface for the feishu message.patch API used by the observability probe.
 * Isolates the deep optional-chain cast into one place so the constructor stays
 * readable and future SDK structural changes break at this type boundary.
 */
interface PatchableMessageService {
  patch(
    request?: { path?: { message_id?: string }; data?: { content?: string } },
    options?: unknown,
  ): Promise<{ code?: number; msg?: string }>;
}

/**
 * 卡片 patch 的重试上限。含义：1 次原始尝试 + 最多 PATCH_MAX_RETRIES 次重试。
 */
export const PATCH_MAX_RETRIES = 3;
/** 重试退避基数（ms）；第 n 次重试前等待 n × 基数，给对端恢复的时间。 */
export const PATCH_RETRY_BASE_DELAY_MS = 150;

/** 记日志用的错误摘要（不打印 axios 巨型循环对象）。 */
function formatErrorForLog(err: unknown): string {
  if (err instanceof Error) {
    // For axios errors, extract useful info without circular refs
    const axiosErr = err as { response?: { status?: number }; code?: string };
    if (axiosErr.response?.status) {
      return `${err.message} (HTTP ${axiosErr.response.status})`;
    }
    if (axiosErr.code) {
      return `${err.message} (code: ${axiosErr.code})`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * 卡片 patch 是否值得重试：传输层瞬态失败 + 5xx。
 * 4xx（业务拒绝/请求构造错误）不重试 —— 重试只会得到同样的结果。
 */
function isRetryablePatchError(err: unknown): boolean {
  if (isTransientTransportError(err)) return true;
  if (err == null || typeof err !== 'object') return false;
  const status = (err as { response?: { status?: number } }).response?.status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

/**
 * 飞书的「tenant_access_token 无效」业务码（HTTP 200 + body code）。
 * appSecret 在后台被重置后，此前签发的 token 立刻落到这个码。
 */
const FEISHU_TOKEN_INVALID_CODE = 99991663;

/** 带飞书业务码的失败：日志与错误文案只留 message，判定要另存 code。 */
class FeishuBusinessError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'FeishuBusinessError';
    this.code = code;
  }
}

/**
 * 这次失败是否等于「缓存里的 token 已失效」：body code 99991663 或 HTTP 401。
 * 判定发生在内层 try 抓到的原始错误上，外层 `${label} failed: …` 包装在其之后。
 */
function isAccessTokenRejected(err: unknown): boolean {
  if (err instanceof FeishuBusinessError) return err.code === FEISHU_TOKEN_INVALID_CODE;
  const resp = (err as { response?: { status?: number } } | null)?.response;
  return resp?.status === 401;
}

/**
 * 带重试的 `im.v1.message.patch`。
 *
 * 为什么必须在这一层重试：流式卡片的 patch 由 @larksuite/channel 的
 * CardStreamController 经 throttle 延迟触发 —— `controller.update()` 调完
 * `throttle.note()` 就 resolve，不等真正的 patch。失败时是一条脱离 await 链的
 * detached rejection，只能冒泡到 `process.unhandledRejection`，调用方的
 * try/catch 根本挡不住。2026-09-15 00:09 的事故正是如此：卡片 patch 时
 * socket 被关（AxiosError `ERR_SOCKET_CLOSED`），整进程退出，正在跑的 run 陪葬。
 *
 * 这里在唯一的底层 patch 出口上兜住：瞬态错误重试最多 PATCH_MAX_RETRIES 次，
 * 全部失败才把最后一个错误抛出去（此时上层 classifyRejection 也会判为
 * recoverable，不会击穿进程）。patch 是整卡替换，重试天然幂等。
 *
 * 重试期间不会有更新的帧插到前面：@larksuite/channel 的 CardStreamController 用
 * `Throttle.inFlight`（在途 fire 未结束则新 fire 延后）+ 每流 FIFO `UpdateQueue`
 * 两层串行，本函数就在 `fire()` 的 await 链上，所以后续帧一定排在本次重试之后。
 * 终态帧另走 `flushNow()` + `queue.drain()`。不需要在这里补 sequence 机制。
 */
async function patchWithRetry(
  patchFn: PatchableMessageService['patch'],
  request: Parameters<PatchableMessageService['patch']>[0],
  options: Parameters<PatchableMessageService['patch']>[1],
): Promise<Awaited<ReturnType<PatchableMessageService['patch']>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PATCH_MAX_RETRIES; attempt += 1) {
    try {
      return await patchFn(request, options);
    } catch (err) {
      lastError = err;
      if (attempt === PATCH_MAX_RETRIES || !isRetryablePatchError(err)) throw err;
      const delayMs = PATCH_RETRY_BASE_DELAY_MS * (attempt + 1);
      getLogger().warn(
        `[feishu] message.patch transient failure ` +
          `(attempt ${attempt + 1}/${PATCH_MAX_RETRIES + 1}), retrying in ${delayMs}ms: ` +
          `${formatErrorForLog(err)}`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Safely extract the im.v1.message.patch service from a LarkChannel.
 * Returns undefined when the channel mock omits rawClient (unit tests).
 */
function tryGetPatchService(channel: LarkChannel): PatchableMessageService | undefined {
  const c = (
    channel as unknown as {
      rawClient?: { im?: { v1?: { message?: PatchableMessageService } } };
    }
  ).rawClient;
  return c?.im?.v1?.message;
}

export class FeishuConnector {
  /** 飞书 channel 实例（public：测试直接访问/注入 mock，替代 as unknown as）。 */
  channel: LarkChannel;
  private onMessage?: MessageHandler;
  private onCardAction?: CardActionHandler;
  private onInboundMediaDetected?: InboundMediaDetectedHandler;
  private isConnected = false;
  private appId: string;
  private appSecret: string;

  constructor(config: AppConfig) {
    this.appId = config.feishu.appId;
    this.appSecret = config.feishu.appSecret;
    this.channel = createLarkChannel({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      // Attach raw Feishu event on every cardAction: the SDK normalizer drops
      // `input_value` (CardKit 2.0 input submit-icon payload), so handlers
      // (queue.edit input) read it from action.raw.
      includeRawEvent: true,
      policy: {
        dmMode: 'open',
        requireMention: false,
      },
      safety: {
        dedup: {
          ttl: DEDUP_TTL_MS,
          maxEntries: 1000,
        },
      },
    });

    // 卡片 patch 的统一出口（观测 + 重试）：
    // 1) 观测（2026-08-11 run 卡定格事故）：飞书业务码错误以 HTTP 200 + {code!=0}
    //    返回时，lark SDK 正常 resolve、@larksuite/channel 的 patchCard 丢弃返回值，
    //    导致终态卡 patch 被业务层拒绝时全链路无日志无兜底。这里把业务码记 warn。
    //    **不在这里抛**：流式卡片的 patch 由 throttle 触发、脱离 await 链
    //    （`Throttle.fireSoon` 丢掉 doFire 的 promise），抛出即成 detached rejection。
    //    恢复链路只覆盖有 await 的调用方：见 `updateCard()` 读业务码后抛。
    // 2) 重试（2026-09-15 socket-close 事故）：瞬态传输失败就地重试，最多
    //    PATCH_MAX_RETRIES 次，不把失败直接落到 unhandledRejection 打死进程。
    //    业务码是确定性失败，不进重试循环。
    // Guard: unit-test mocks may omit rawClient; skip probe installation in that case.
    const messageService = tryGetPatchService(this.channel);
    if (messageService?.patch) {
      const origPatch = messageService.patch.bind(messageService);
      messageService.patch = (async (request, options) => {
        const res = await patchWithRetry(origPatch, request, options);
        if (typeof res?.code === 'number' && res.code !== 0) {
          const content = request?.data?.content;
          const bytes =
            typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : undefined;
          getLogger().warn(
            `[feishu] message.patch business error code=${res.code} msg=${String(res.msg)} ` +
              `messageId=${String(request?.path?.message_id)} bytes=${bytes ?? 'unknown'}`,
          );
        }
        return res;
      }) as typeof origPatch;
    }

    this.channel.on('message', (msg: NormalizedMessage) => {
      if (msg.chatType !== 'p2p') return;

      // 判据是「是否携带可下载资源」（`msg.resources`），不是 `msg_type` 白名单：
      // SDK 只为 image/file/audio/video/media/sticker 五类产出非空 resources，
      // 枚举 msg_type 必然漏（2026-09-15 事故：mp4 被当文本转发给 agent）。
      // 一条消息可以**同时**产出资源事件与文本事件（post 既有文字又有图），
      // 由 B3 的装配器合并成同一个 turn。
      const hasResources = msg.resources.length > 0;
      if (hasResources) {
        // 只上报「媒体到达」，不在此下载：owner/配置闸门在 index.ts 里先执行，
        // 通过后才调用 downloadInboundMedia（避免未认证大文件下载打爆内存）。
        void this.handleInboundMediaDetected(msg);
      }
      if (!hasResources || stripPlaceholders(msg.content).clean !== '') {
        this.onMessage?.({
          userId: msg.senderId,
          messageId: msg.messageId,
          chatId: msg.chatId,
          content: msg.content,
          rawContentType: msg.rawContentType,
          replyToMessageId: msg.replyToMessageId,
        });
      }
    });

    this.channel.on('cardAction', (action: CardActionEvent) => {
      // Return the handler's response (toast / in-place card update) so the
      // SDK passes it back to Feishu as the button-click callback response.
      return this.onCardAction?.(action);
    });

    this.channel.on('error', (err) => {
      getLogger().error('[feishu] channel error:', err.code, err.message);
    });

    this.channel.on('reconnecting', () => {
      getLogger().info('[feishu] reconnecting...');
      this.isConnected = false;
    });

    this.channel.on('reconnected', () => {
      getLogger().info('[feishu] reconnected');
      this.isConnected = true;
    });
  }

  get connected(): boolean {
    return this.isConnected;
  }

  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  setCardActionHandler(handler: CardActionHandler): void {
    this.onCardAction = handler;
  }

  setInboundMediaDetectedHandler(handler: InboundMediaDetectedHandler): void {
    this.onInboundMediaDetected = handler;
  }

  /**
   * 上报媒体消息到达（轻量，不含下载内容）。上层认证/配置闸门通过后
   * 再调 downloadInboundMedia。
   */
  private async handleInboundMediaDetected(msg: NormalizedMessage): Promise<void> {
    if (!this.onInboundMediaDetected) {
      getLogger().warn('[feishu] inbound media received but no detected handler registered');
      return;
    }
    // default-deny 但可见：未识别类型（未来 SDK 新增）照常下载，但必须留痕，
    // 否则会重演「静默降级成占位符」的事故。
    if (!KNOWN_RESOURCE_CONTENT_TYPES.has(msg.rawContentType)) {
      getLogger().warn(
        `[feishu] inbound media with unrecognized msg_type="${msg.rawContentType}" ` +
          `resources=${msg.resources.length}, downloading anyway`,
      );
    }
    try {
      await this.onInboundMediaDetected({
        userId: msg.senderId,
        chatId: msg.chatId,
        messageId: msg.messageId,
        rawContentType: msg.rawContentType,
        replyToMessageId: msg.replyToMessageId,
        resources: msg.resources.map((r) => ({
          // 下载 type 只有 image/file 两个合法值（传 video/audio/sticker 会 400）。
          type: r.type === 'image' ? ('image' as const) : ('file' as const),
          kind: r.type,
          fileKey: r.fileKey,
          fileName: r.fileName,
          durationMs: r.durationMs,
        })),
      });
    } catch (err) {
      getLogger().error('[feishu] inbound media detected handler failed:', (err as Error).message);
    }
  }

  /**
   * 下载消息里的全部资源（流式写临时文件，避免大文件全量进堆内存）。
   * 逐资源 try/catch：单个失败不影响其他资源；超限项不进入 media（不落盘）。
   * 下载失败/超限都随 failures 交给 bridge 提示用户（对齐"发送文件失败"文案风格）。
   * 调用方必须已通过 owner/配置闸门（index.ts）；maxFileSizeMb 由调用方从
   * 当前配置传入（避免 connector 持有过期的 config 快照）。
   */
  async downloadInboundMedia(
    msg: InboundMediaMessage,
    opts?: { maxFileSizeMb?: number; downloadTimeoutMs?: number },
  ): Promise<InboundMediaPayload> {
    const maxBytes = (opts?.maxFileSizeMb ?? DEFAULT_INBOUND_MEDIA_MAX_SIZE_MB) * 1024 * 1024;
    const timeoutMs = opts?.downloadTimeoutMs ?? RESOURCE_DOWNLOAD_TIMEOUT_MS;
    const media: InboundMediaItem[] = [];
    const failures: InboundMediaFailure[] = [];

    for (const res of msg.resources) {
      const tmpPath = path.join(os.tmpdir(), `lark-remote-inbound-${randomUUID()}`);
      try {
        const { contentType, bytesWritten } = await withTimeout(
          this.channel.downloadResourceToFile(msg.messageId, res.fileKey, res.type, tmpPath),
          timeoutMs,
          `downloadResource fileKey=${res.fileKey}`,
          () => silentlyUnlink(tmpPath),
        );
        if (bytesWritten > maxBytes) {
          silentlyUnlink(tmpPath);
          const limitMb = maxBytes / (1024 * 1024);
          failures.push({
            kind: res.kind,
            fileName: res.fileName,
            // 飞书侧 >100MB 必须 Range 分片（SDK 不分片），到上限就是下不动：
            // 提示写清楚，避免用户以为"再放大上限就能存"（matrix §4.4/§2 #11）。
            reason:
              `超过 ${limitMb}MB 大小限制` +
              (limitMb >= 100 ? '（飞书 >100MB 的文件需分片下载，暂不支持）' : ''),
          });
          continue;
        }
        media.push({
          type: res.type,
          kind: res.kind,
          fileName: res.fileName,
          mimeType: contentType,
          durationMs: res.durationMs,
          tempPath: tmpPath,
        });
      } catch (err) {
        // 超时不在这里删文件：上面已把清理挂到底层传输的 settle 上。
        if (!(err instanceof ResourceTimeoutError)) silentlyUnlink(tmpPath);
        getLogger().warn(
          `[feishu] downloadResource failed fileKey=${res.fileKey} type=${res.type}:`,
          (err as Error).message,
        );
        failures.push({
          kind: res.kind,
          fileName: res.fileName,
          reason: `下载失败: ${(err as Error).message}${MERGE_FORWARD_HINT[msg.rawContentType] ?? ''}`,
        });
      }
    }

    return {
      userId: msg.userId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      replyToMessageId: msg.replyToMessageId,
      media,
      failures,
    };
  }

  async connect(): Promise<void> {
    try {
      await this.channel.connect();
      this.isConnected = true;
      getLogger().info('[feishu] connected via WebSocket');
    } catch (err) {
      getLogger().error('[feishu] connection failed:', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.channel.disconnect();
      this.isConnected = false;
      getLogger().info('[feishu] disconnected');
    } catch (err) {
      getLogger().warn('[feishu] disconnect error:', err);
      // Still mark as disconnected even if there was an error
      this.isConnected = false;
    }
  }

  /**
   * Send a message with automatic rate-limit retry (§9.5).
   * Encounters rate_limited / feishuCode 99991400|99991401（SDK 归类为
   * permission_denied）→ sleep 200ms → retry once.
   */
  async sendWithRetry(
    chatId: string,
    input: { text: string } | { markdown: string } | { card: object },
    opts?: { replyTo?: string },
  ): Promise<string> {
    try {
      const result = await this.channel.send(chatId, input, { replyTo: opts?.replyTo });
      return result.messageId;
    } catch (err: unknown) {
      if (shouldRetrySendError(err)) {
        getLogger().warn('[feishu] rate limited, retrying in 200ms...');
        await sleep(200);
        try {
          const result = await this.channel.send(chatId, input, { replyTo: opts?.replyTo });
          return result.messageId;
        } catch (retryErr: unknown) {
          // P2-17: throw the RETRY error, not the outer `err`. Previously
          // `throw err` here re-threw the first (rate-limit) failure, hiding
          // the real reason the retry attempt failed (e.g. auth invalid).
          getLogger().warn('[feishu] retry after rate limit still failed');
          throw retryErr;
        }
      }
      throw err;
    }
  }

  async streamCard(
    chatId: string,
    initial: object,
    producer: CardStreamProducer,
    opts?: { replyTo?: string },
  ): Promise<string> {
    try {
      const result = await this.channel.stream(
        chatId,
        { card: { initial, producer } },
        { replyTo: opts?.replyTo },
      );
      return result.messageId;
    } catch (err) {
      // 抛出去前先落一条格式化日志（调用方只看到包装后的 message）。
      // 抛普通 Error 而不是原 err：axios 错误对象跨层序列化会丢信息。
      const errorInfo = this.formatError(err);
      getLogger().error('[feishu] streamCard failed:', errorInfo);
      throw new Error(`streamCard failed: ${errorInfo}`, { cause: err });
    }
  }

  /**
   * 原地替换已发消息的卡片内容。
   *
   * 走 `rawClient.im.v1.message.patch` 而不是 `channel.updateCard()`，唯一目的就是
   * 拿到返回值：飞书的业务码拒绝以 HTTP 200 + `{code!=0}` 返回，SDK 的 `patchCard`
   * 把返回值丢了，调用方于是拿到假成功（卡片定格在被打回的那一帧，用户却收到
   * 「已保存」）。抛出去让 `bridge.updateCardInPlace()` 的 catch 走 sendResult 兜底。
   * `rawClient` 缺失（测试 mock）时回退 SDK 入口，行为退化为「看不见业务码」。
   */
  async updateCard(messageId: string, card: object): Promise<void> {
    const messageService = tryGetPatchService(this.channel);
    let rejection: { code: number; msg?: string } | undefined;

    try {
      if (messageService?.patch) {
        const res = await messageService.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
        });
        if (typeof res?.code === 'number' && res.code !== 0) {
          rejection = { code: res.code, msg: res.msg };
        }
      } else {
        await this.channel.updateCard(messageId, card);
      }
    } catch (err) {
      // Log the error but don't swallow it - a plain error avoids axios
      // serialization issues in the logger.
      const errorInfo = this.formatError(err);
      getLogger().error('[feishu] updateCard failed:', errorInfo);
      throw new Error(`updateCard failed: ${errorInfo}`, { cause: err });
    }

    if (rejection) {
      throw new Error(
        `updateCard failed: Feishu rejected the card (code=${rejection.code} msg=${rejection.msg ?? ''})`,
        { cause: rejection },
      );
    }
  }

  /** Format error for logging without causing circular serialization */
  private formatError(err: unknown): string {
    return formatErrorForLog(err);
  }

  async addReaction(messageId: string, emoji: string): Promise<void> {
    try {
      await this.channel.addReaction(messageId, emoji);
    } catch (err) {
      getLogger().error('[feishu] addReaction failed:', this.formatError(err));
    }
  }

  /**
   * Remove a reaction by emoji (e.g. retract the Typing indicator).
   * The SDK resolves the reaction id internally; missing reaction is a no-op.
   */
  async removeReactionByEmoji(messageId: string, emoji: string): Promise<void> {
    try {
      await this.channel.removeReactionByEmoji(messageId, emoji);
    } catch (err) {
      getLogger().error('[feishu] removeReactionByEmoji failed:', this.formatError(err));
    }
  }

  /**
   * sendFile/sendImage 共用：校验文件存在与大小上限（30MB，对齐飞书
   * im/v1 上传 API）。noun 是消息里的小写名词（'file'/'image'）。
   */
  private checkUploadable(filePath: string, noun: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`Cannot access ${noun}: file not found (${filePath})`, { cause: err });
      }
      throw new Error(`Cannot access ${noun}: ${(err as Error).message}`, { cause: err });
    }
    if (stat.size > MAX_FILE_UPLOAD_SIZE) {
      const nounCap = noun.charAt(0).toUpperCase() + noun.slice(1);
      throw new Error(
        `${nounCap} too large (${(stat.size / 1_000_000).toFixed(1)}MB), exceeds ${MAX_FILE_UPLOAD_SIZE / (1024 * 1024)}MB limit`,
      );
    }
  }

  /**
   * sendFile/sendImage 共用骨架：token → 上传（流在任何失败路径销毁，P2-18）
   * → 发送媒体消息。上传端点 / form 字段 / 响应 key / msg_type 的差异由调用方
   * 以 uploadUrl + buildForm + keyField + msgType 表达；timeout、noKeepAliveAgent
   * （Bun keep-alive 修复）与错误包装在此单源。label 是对外错误前缀与日志
   * 标签（'sendFile' | 'sendImage'）。
   */
  private async uploadAndSendMedia(
    chatId: string,
    filePath: string,
    label: string,
    uploadUrl: string,
    buildForm: (stream: fs.ReadStream) => FormData,
    keyField: 'file_key' | 'image_key',
    msgType: 'file' | 'image',
  ): Promise<string> {
    try {
      // 被判 token 无效时清缓存重取，整段上传重做**一次**（appSecret 在飞书后台
      // 被重置后，缓存里的旧 token 立刻失效；不清缓存就要一直失败到自然过期
      // ~2h，期间发文件全报错）。只重试一次：持续被拒说明问题不在 token 缓存。
      for (let attempt = 0; ; attempt++) {
        const accessToken = await this.getTenantAccessToken();
        try {
          return await this.uploadWithToken(
            accessToken,
            chatId,
            filePath,
            uploadUrl,
            buildForm,
            keyField,
            msgType,
          );
        } catch (err) {
          if (attempt === 0 && isAccessTokenRejected(err)) {
            this.invalidateTenantToken();
            getLogger().warn(`[feishu] ${label}: tenant token rejected, refetching once`);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const errorInfo = this.formatError(err);
      getLogger().error(`[feishu] ${label} failed:`, errorInfo);
      throw new Error(`${label} failed: ${errorInfo}`, { cause: err });
    }
  }

  /** 单次「上传 + 发媒体消息」；文件流在此拥有，任何失败路径都销毁（P2-18）。 */
  private async uploadWithToken(
    accessToken: string,
    chatId: string,
    filePath: string,
    uploadUrl: string,
    buildForm: (stream: fs.ReadStream) => FormData,
    keyField: 'file_key' | 'image_key',
    msgType: 'file' | 'image',
  ): Promise<string> {
    let fileStream: fs.ReadStream | null = null;
    try {
      fileStream = fs.createReadStream(filePath);
      const form = buildForm(fileStream);

      // P2-18: timeout 120s（大文件慢链路）；httpsAgent: noKeepAliveAgent 防止
      // Bun 复用已被服务端 RST 的 keep-alive socket（ECONNRESET after ~30s）。
      const uploadResp = await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 120000,
        httpsAgent: noKeepAliveAgent,
      });
      if (uploadResp.data.code !== 0) {
        throw new FeishuBusinessError(
          `Upload failed: ${uploadResp.data.msg}`,
          uploadResp.data.code,
        );
      }
      const mediaKey = uploadResp.data.data[keyField];

      // P2-18: timeout 30s；noKeepAlive 同上。
      const sendResp = await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/messages',
        {
          receive_id: chatId,
          msg_type: msgType,
          content: JSON.stringify({ [keyField]: mediaKey }),
        },
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${accessToken}`,
          },
          params: { receive_id_type: 'chat_id' },
          timeout: 30000,
          httpsAgent: noKeepAliveAgent,
        },
      );
      if (sendResp.data.code !== 0) {
        throw new FeishuBusinessError(
          `Media message failed: ${sendResp.data.msg}`,
          sendResp.data.code,
        );
      }
      return sendResp.data.data.message_id;
    } catch (err) {
      // P2-18: destroy the read stream on failure so the fd is released.
      if (fileStream) {
        try {
          fileStream.destroy();
        } catch {
          /* already destroyed */
        }
      }
      throw err;
    }
  }

  /**
   * Upload a file to Feishu and send it to the specified chat.
   * Uses the im/v1/files upload API.
   */
  async sendFile(chatId: string, filePath: string): Promise<string> {
    this.checkUploadable(filePath, 'file');
    return this.uploadAndSendMedia(
      chatId,
      filePath,
      'sendFile',
      'https://open.feishu.cn/open-apis/im/v1/files',
      (stream) => {
        const form = new FormData();
        form.append('file', stream);
        form.append('file_name', displayName(filePath));
        form.append('file_type', 'stream');
        return form;
      },
      'file_key',
      'file',
    );
  }

  /**
   * Upload a local image file to Feishu and send it as an image message
   * (im/v1/images + msg_type=image). Used by the clone wizard to deliver the
   * scan-to-create QR code inline instead of as a downloadable file.
   */
  async sendImage(chatId: string, filePath: string): Promise<string> {
    this.checkUploadable(filePath, 'image');
    return this.uploadAndSendMedia(
      chatId,
      filePath,
      'sendImage',
      'https://open.feishu.cn/open-apis/im/v1/images',
      (stream) => {
        const form = new FormData();
        form.append('image_type', 'message');
        form.append('image', stream);
        return form;
      },
      'image_key',
      'image',
    );
  }

  /**
   * Cached tenant_access_token for sendFile (P2-18). The token is valid ~2h;
   * fetching it on every file send wastes a round-trip and an unguarded fetch
   * could return data.code != 0 with an undefined token. Cache with expiry and
   * validate the response code.
   *
   * 缓存的两条失效路径：到期（下面 expire）与被服务端判 token 无效
   * （invalidateTenantToken，见 §B13）。
   */
  private cachedToken: string | null = null;
  private cachedTokenExpireAt = 0;
  /** 在途的取 token 请求：并发发送合流成一次请求（飞书该端点有限流）。 */
  private tokenFetch: Promise<string> | null = null;

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedTokenExpireAt) {
      return this.cachedToken;
    }
    this.tokenFetch ??= this.fetchTenantAccessToken().finally(() => {
      this.tokenFetch = null;
    });
    return this.tokenFetch;
  }

  /** 清掉缓存的 token：鉴权被拒时旧值已经没有价值，留着只会继续失败。 */
  private invalidateTenantToken(): void {
    this.cachedToken = null;
    this.cachedTokenExpireAt = 0;
  }

  private async fetchTenantAccessToken(): Promise<string> {
    // P2-18: timeout 30s on the token request.
    // httpsAgent: noKeepAlive — same Bun keep-alive fix as upload above.
    const tokenResp = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: this.appId,
        app_secret: this.appSecret,
      },
      {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        timeout: 30000,
        httpsAgent: noKeepAliveAgent,
      },
    );
    if (tokenResp.data.code !== 0) {
      throw new FeishuBusinessError(
        `Failed to get tenant_access_token: ${tokenResp.data.msg ?? 'unknown error'}`,
        tokenResp.data.code,
      );
    }
    const token = tokenResp.data.tenant_access_token;
    // Expire is in seconds; refresh 5min early as a safety margin.
    const expire = (tokenResp.data.expire ?? 7200) as number;
    this.cachedToken = token;
    this.cachedTokenExpireAt = Date.now() + (expire - 300) * 1000;
    return token;
  }
}
