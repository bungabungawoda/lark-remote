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
import { sleep } from '../common/sleep.js';
import axios from 'axios';
import fs from 'node:fs';
import { silentlyUnlink } from '../common/fs.js';
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
 * - config 卡片原地更新（updateCardInPlace），用户在同一张卡上连点 toggle：
 *   messageId / operator / value 三段都相同 → eventId 完全相同 → 第二次点击被
 *   seenCache drop，toggle 不可逆（"显示工具结果"等开关第二次点击静默失效）。
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

interface FeishuMessage {
  userId: string;
  messageId: string;
  chatId: string;
  content: string;
}

type MessageHandler = (msg: FeishuMessage) => void;

/**
 * 入站媒体（image/file 消息的 resource）下载结果，交给 bridge 落盘。
 * media 为通过大小限制、可落盘的项；failures 为下载失败或超限的项
 * （bridge 负责把这些失败提示回用户）。
 */
export interface InboundMediaItem {
  /** 资源类型：image 消息按 MIME 生成 image_<HHmmss>_<n>.<ext>，file 保留文件名。 */
  type: 'image' | 'file';
  /** 原始文件名（file 消息有；image 消息无，由 bridge 按 MIME 生成）。 */
  fileName?: string;
  /** 服务端 content-type（参数已剥离；可能缺失，bridge 有兜底）。 */
  mimeType?: string;
  /**
   * 下载内容所在临时文件（流式落盘，避免大文件全量进堆内存）。
   * 由 bridge 移动到最终位置；任何未移动路径都必须清理该文件。
   */
  tempPath: string;
}

export interface InboundMediaFailure {
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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
export interface InboundMediaMessage {
  userId: string;
  chatId: string;
  messageId: string;
  /** 引用上下文：不同 replyTo 强制拆批。 */
  replyToMessageId?: string;
  resources: Array<{ type: 'image' | 'file'; fileKey: string; fileName?: string }>;
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
 * @larksuite/channel@0.3.0 的 classifyError 把飞书业务码 99991400/99991401
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

    // 观测探针（2026-08-11 run 卡定格事故）：飞书业务码错误以 HTTP 200 + {code!=0}
    // 返回时，lark SDK 正常 resolve、@larksuite/channel 的 patchCard 丢弃返回值，
    // 导致终态卡 patch 被业务层拒绝时全链路无日志无兜底。这里只观测不改行为——
    // 不 throw、不重试，返回值原样透传。
    // 详见 .adversarial-tdd/prompt-patchcard-business-code-observability.md
    // Guard: unit-test mocks may omit rawClient; skip probe installation in that case.
    const messageService = tryGetPatchService(this.channel);
    if (messageService?.patch) {
      const origPatch = messageService.patch.bind(messageService);
      messageService.patch = (async (request, options) => {
        const res = await origPatch(request, options);
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

      // 入站图片/文件：不转发文本内容（图片消息的 content 只是占位文案），
      // 而是下载资源后交给 bridge 落盘（runner 零改动）。
      if (
        (msg.rawContentType === 'image' || msg.rawContentType === 'file') &&
        msg.resources.length > 0
      ) {
        // 只上报"媒体到达"，不在此下载：owner/配置闸门在 index.ts 里先执行，
        // 通过后才调用 downloadInboundMedia（避免未认证大文件下载打爆内存）。
        void this.handleInboundMediaDetected(msg);
        return;
      }

      this.onMessage?.({
        userId: msg.senderId,
        messageId: msg.messageId,
        chatId: msg.chatId,
        content: msg.content,
      });
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
    try {
      await this.onInboundMediaDetected({
        userId: msg.senderId,
        chatId: msg.chatId,
        messageId: msg.messageId,
        replyToMessageId: msg.replyToMessageId,
        resources: msg.resources.map((r) => ({
          type: r.type === 'image' ? ('image' as const) : ('file' as const),
          fileKey: r.fileKey,
          fileName: r.fileName,
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
        );
        if (bytesWritten > maxBytes) {
          silentlyUnlink(tmpPath);
          failures.push({
            fileName: res.fileName,
            reason: `超过 ${maxBytes / (1024 * 1024)}MB 大小限制`,
          });
          continue;
        }
        media.push({
          type: res.type,
          fileName: res.fileName,
          mimeType: contentType,
          tempPath: tmpPath,
        });
      } catch (err) {
        silentlyUnlink(tmpPath);
        getLogger().warn(
          `[feishu] downloadResource failed fileKey=${res.fileKey} type=${res.type}:`,
          (err as Error).message,
        );
        failures.push({ fileName: res.fileName, reason: `下载失败: ${(err as Error).message}` });
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

  async reconnect(): Promise<void> {
    // disconnect() swallows its own errors internally, so no try/catch needed
    // here — it always resolves.
    await this.disconnect();
    await this.connect();
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
      // Log the error but don't throw - this prevents unhandled rejection
      const errorInfo = this.formatError(err);
      getLogger().error('[feishu] streamCard failed:', errorInfo);
      // Throw a plain error to avoid axios error serialization issues
      throw new Error(`streamCard failed: ${errorInfo}`, { cause: err });
    }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    try {
      await this.channel.updateCard(messageId, card);
    } catch (err) {
      // Log the error but don't throw - this prevents unhandled rejection
      const errorInfo = this.formatError(err);
      getLogger().error('[feishu] updateCard failed:', errorInfo);
      // Throw a plain error to avoid axios error serialization issues
      throw new Error(`updateCard failed: ${errorInfo}`, { cause: err });
    }
  }

  /** Format error for logging without causing circular serialization */
  private formatError(err: unknown): string {
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
   * Upload a file to Feishu and send it to the specified chat.
   * Uses the im/v1/files upload API.
   */
  async sendFile(chatId: string, filePath: string): Promise<string> {
    // Check file existence first with proper error handling
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`Cannot access file: file not found (${filePath})`, { cause: err });
      }
      throw new Error(`Cannot access file: ${(err as Error).message}`, { cause: err });
    }

    // Check file size limit (30MB, aligned with Feishu im/v1/files API)
    if (stat.size > MAX_FILE_UPLOAD_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1_000_000).toFixed(1)}MB), exceeds ${MAX_FILE_UPLOAD_SIZE / (1024 * 1024)}MB limit`,
      );
    }

    const fileName = filePath.split('/').pop() ?? 'file';

    // P2-18: capture the read stream so it can be destroyed on any failure
    // path. Without this, a token/upload/send failure leaks the fd (axios
    // only closes the stream when it fully consumes it on success).
    let fileStream: fs.ReadStream | null = null;
    try {
      // P2-18: tenant_access_token cache. Avoid re-fetching on every file send
      // (token is valid ~2h); validate data.code before trusting the token.
      const accessToken = await this.getTenantAccessToken();

      // Upload file
      const form = new FormData();
      fileStream = fs.createReadStream(filePath);
      form.append('file', fileStream);
      form.append('file_name', fileName);
      form.append('file_type', 'stream');

      // P2-18: timeout on the upload (large file, slow link) — 120s.
      // httpsAgent: noKeepAlive — prevents Bun from reusing a server-RST'd
      // keep-alive socket (ECONNRESET after ~30s; see noKeepAliveAgent docs).
      const uploadResp = await axios.post('https://open.feishu.cn/open-apis/im/v1/files', form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 120000,
        httpsAgent: noKeepAliveAgent,
      });

      if (uploadResp.data.code !== 0) {
        throw new Error(`File upload failed: ${uploadResp.data.msg}`);
      }

      const fileKey = uploadResp.data.data.file_key;

      // Send file message. P2-18: timeout 30s.
      // httpsAgent: noKeepAlive — same Bun keep-alive fix as upload above.
      const sendResp = await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/messages',
        {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
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
        throw new Error(`File message failed: ${sendResp.data.msg}`);
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
      // Log the error but throw a formatted error to prevent unhandled rejection
      const errorInfo = this.formatError(err);
      getLogger().error('[feishu] sendFile failed:', errorInfo);
      throw new Error(`sendFile failed: ${errorInfo}`, { cause: err });
    }
  }

  /**
   * Cached tenant_access_token for sendFile (P2-18). The token is valid ~2h;
   * fetching it on every file send wastes a round-trip and an unguarded fetch
   * could return data.code != 0 with an undefined token. Cache with expiry and
   * validate the response code.
   */
  private cachedToken: string | null = null;
  private cachedTokenExpireAt = 0;

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedTokenExpireAt) {
      return this.cachedToken;
    }
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
      throw new Error(
        `Failed to get tenant_access_token: ${tokenResp.data.msg ?? 'unknown error'}`,
      );
    }
    const token = tokenResp.data.tenant_access_token;
    // Expire is in seconds; refresh 5min early as a safety margin.
    const expire = (tokenResp.data.expire ?? 7200) as number;
    this.cachedToken = token;
    this.cachedTokenExpireAt = now + (expire - 300) * 1000;
    return token;
  }
}
