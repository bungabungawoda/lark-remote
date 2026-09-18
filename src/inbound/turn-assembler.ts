/**
 * InboundTurnAssembler：统一静默期窗口 + 合并 + 下载等待 + commit。
 *
 * 设计依据：`docs/zh/architecture/inbound-unified-input-design.md` §4/§5.2。
 *
 * 规则：
 * - 任何事件到达 → **重置** 700ms 定时器（按 `userId:chatId` 分桶），保证图/文任意顺序等价；
 * - 定时器到点 → 若本 turn 仍有 in-flight 下载 → 等待，落定后再 commit；
 * - 下载失败/超时 → 该项进 `rejected`，然后照常 commit；
 * - commit → 构造 prompt（`prompt.ts`）→ `onCommit`；
 * - **无文本且只有附件 → 不 commit**（决策 2），只发 `onReceipt` 回执；
 * - 命令消息由调用方 `flush()` 强制提交，不等窗口。
 */

import { getLogger } from '../logger/index.js';
import type { InboundEvent } from './event.js';
import { isDownloadablePlaceholder } from './placeholder.js';
import { buildPrompt } from './prompt.js';
import { buildReceipt, unsupportedReason } from './receipt.js';
import {
  bucketKey,
  type CommitReason,
  type InboundAttachment,
  type InboundTurn,
  type MediaOutcome,
  type RejectedItem,
} from './turn.js';

/** 统一静默期窗口（ms）——决策 1：不做「纯文本零延迟」快路径。 */
export const DEFAULT_TURN_WINDOW_MS = 700;

export interface AssemblerContext {
  userId: string;
  chatId: string;
  messageId: string;
}

export interface AssemblerDeps {
  /** 静默期窗口（毫秒），默认 700。 */
  windowMs?: number;
  /** 定时器注入（便于 vitest fake timers / 单元测试确定性）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** commit 回调：组装完成的 turn + prompt 交给上层（进 agent）。 */
  onCommit: (turn: InboundTurn, prompt: string) => void | Promise<void>;
  /** 回执回调：面向用户的提示（无文本纯附件 / 有 rejected 项）。 */
  onReceipt?: (ctx: AssemblerContext, text: string) => void | Promise<void>;
}

interface Bucket {
  userId: string;
  chatId: string;
  texts: string[];
  attachments: InboundAttachment[];
  rejected: RejectedItem[];
  messageIds: string[];
  replyToMessageId?: string;
  /** in-flight 下载数（>0 时禁止 commit）。 */
  pendingOutcomes: Set<Promise<void>>;
  /** 窗口是否已到期（下载落定时据此判定能否立即 commit）。 */
  windowElapsed: boolean;
  /** flush 强制提交时记录的原因（下载落定后沿用）。 */
  forcedReason?: CommitReason;
  timer?: unknown;
  commitPromise?: Promise<void>;
  committed: boolean;
}

export class InboundTurnAssembler {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private disposed = false;

  constructor(private readonly deps: AssemblerDeps) {
    this.windowMs = deps.windowMs ?? DEFAULT_TURN_WINDOW_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /** 投递一个入站事件（文本 / 媒体[in-flight] / 拒绝）。 */
  ingest(event: InboundEvent): void {
    if (this.disposed) {
      // 已 dispose（进程收尾）：不再装配，但必须吞掉 in-flight promise 的 rejection，
      // 否则它会以 unhandledRejection 形式打死进程。
      if (event.kind === 'media') void event.outcome.catch(() => {});
      return;
    }
    const key = bucketKey(event.userId, event.chatId);
    const bucket = this.ensureBucket(key, event);
    if (!bucket.messageIds.includes(event.messageId)) bucket.messageIds.push(event.messageId);
    if (bucket.replyToMessageId === undefined && event.replyToMessageId !== undefined) {
      bucket.replyToMessageId = event.replyToMessageId;
    }

    switch (event.kind) {
      case 'text': {
        if (event.text !== '') bucket.texts.push(event.text);
        // 可下载占位符（图/文件/视频/语音/表情）由媒体通道处理，不在此记 rejected；
        // 其余（位置/名片/投票/合并转发/降级态/未知）拿不到，明确回执。
        for (const kind of event.placeholders) {
          if (isDownloadablePlaceholder(kind)) continue;
          // 合并转发的子消息文本已被 SDK 渲染（text 非空）→ 只保留文本；
          // 附件能不能拿到由媒体通道的 outcome 决定，不在这里重复报「不支持」。
          if (kind === 'forwarded' && event.text !== '') continue;
          this.pushRejected(bucket, {
            kind,
            reason: unsupportedReason(kind),
            sourceMsgId: event.messageId,
          });
        }
        break;
      }
      case 'media': {
        this.trackMediaOutcome(bucket, key, event.messageId, event.outcome);
        break;
      }
      case 'rejected': {
        this.pushRejected(bucket, {
          kind: event.rejectedKind ?? 'unknown',
          reason: event.reason,
          sourceMsgId: event.messageId,
        });
        break;
      }
    }

    this.armTimer(key, bucket);
  }

  /**
   * 强制提交窗口内已装配的内容（命令到达、退出前冲刷）。
   * 仍有 in-flight 下载时先等它落定（避免丢掉附件路径）。
   */
  async flush(userId: string, chatId: string, reason: CommitReason = 'flush'): Promise<void> {
    const key = bucketKey(userId, chatId);
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    bucket.windowElapsed = true;
    bucket.forcedReason = reason;
    if (bucket.pendingOutcomes.size > 0) {
      await Promise.all([...bucket.pendingOutcomes]);
    }
    await (bucket.commitPromise ?? this.tryCommit(key, reason));
  }

  /** 冲刷全部窗口（/exit、/restart 干净退出前调用）。 */
  async flushAll(reason: CommitReason = 'flush'): Promise<void> {
    const buckets = [...this.buckets.values()];
    await Promise.all(buckets.map((b) => this.flush(b.userId, b.chatId, reason)));
  }

  /** 进程退出：丢弃定时器，避免悬挂。 */
  dispose(): void {
    this.disposed = true;
    for (const bucket of this.buckets.values()) {
      if (bucket.timer !== undefined) this.clearTimer(bucket.timer);
    }
    this.buckets.clear();
  }

  private ensureBucket(key: string, event: InboundEvent): Bucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const bucket: Bucket = {
      userId: event.userId,
      chatId: event.chatId,
      texts: [],
      attachments: [],
      rejected: [],
      messageIds: [],
      pendingOutcomes: new Set(),
      windowElapsed: false,
      committed: false,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private pushRejected(bucket: Bucket, item: RejectedItem): void {
    const dup = bucket.rejected.some(
      (r) => r.sourceMsgId === item.sourceMsgId && r.reason === item.reason,
    );
    if (!dup) bucket.rejected.push(item);
  }

  private armTimer(key: string, bucket: Bucket): void {
    if (bucket.timer !== undefined) this.clearTimer(bucket.timer);
    bucket.windowElapsed = false;
    bucket.timer = this.setTimer(() => {
      bucket.timer = undefined;
      bucket.windowElapsed = true;
      if (bucket.pendingOutcomes.size > 0) return; // 等 in-flight 下载落定
      void this.tryCommit(key, bucket.forcedReason ?? 'idle');
    }, this.windowMs);
  }

  /**
   * 登记一次 in-flight 媒体下载：落定后合并结果，并在窗口已到期时触发 commit。
   * 下载异常（含超时）记入 rejected，不阻断本 turn 的其它内容。
   */
  private trackMediaOutcome(
    bucket: Bucket,
    key: string,
    messageId: string,
    outcome: Promise<MediaOutcome>,
  ): void {
    const tracked: Promise<void> = Promise.resolve(outcome)
      .then(
        (result) => {
          bucket.attachments.push(...result.attachments);
          for (const item of result.rejected) this.pushRejected(bucket, item);
        },
        (err: unknown) => {
          this.pushRejected(bucket, {
            kind: 'file',
            reason: `下载失败: ${(err as Error)?.message ?? String(err)}`,
            sourceMsgId: messageId,
          });
        },
      )
      .then(() => {
        bucket.pendingOutcomes.delete(tracked);
        if (bucket.windowElapsed && bucket.pendingOutcomes.size === 0 && !bucket.committed) {
          void this.tryCommit(key, bucket.forcedReason ?? 'idle');
        }
      });
    bucket.pendingOutcomes.add(tracked);
  }

  private tryCommit(key: string, reason: CommitReason): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.committed) return Promise.resolve();
    if (bucket.pendingOutcomes.size > 0) return Promise.resolve();
    bucket.committed = true;
    this.buckets.delete(key);
    if (bucket.timer !== undefined) {
      this.clearTimer(bucket.timer);
      bucket.timer = undefined;
    }
    const promise = this.commit(bucket, reason);
    bucket.commitPromise = promise;
    return promise;
  }

  private async commit(bucket: Bucket, reason: CommitReason): Promise<void> {
    const noText = bucket.texts.length === 0;
    const turn: InboundTurn = {
      userId: bucket.userId,
      chatId: bucket.chatId,
      replyToMessageId: bucket.replyToMessageId,
      texts: bucket.texts,
      attachments: bucket.attachments,
      rejected: bucket.rejected,
      messageIds: bucket.messageIds,
      commitReason: noText ? 'no-text' : reason,
    };
    const ctx: AssemblerContext = {
      userId: bucket.userId,
      chatId: bucket.chatId,
      messageId: bucket.messageIds[bucket.messageIds.length - 1] ?? '',
    };

    try {
      if (noText) {
        // 决策 2：纯附件不自动起 turn，只回执并引导用户说一句话。
        const text = buildReceipt({
          saved: bucket.attachments.map((a) => a.path),
          rejected: bucket.rejected,
          startWorkHint: true,
        });
        if (text) await this.deps.onReceipt?.(ctx, text);
        return;
      }
      await this.deps.onCommit(turn, buildPrompt(turn));
      if (bucket.rejected.length > 0) {
        const text = buildReceipt({ saved: [], rejected: bucket.rejected, startWorkHint: false });
        if (text) await this.deps.onReceipt?.(ctx, text);
      }
    } catch (err) {
      getLogger().error('[inbound] turn commit failed:', (err as Error)?.message ?? String(err));
    }
  }
}
