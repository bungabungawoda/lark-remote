/**
 * 装配器事件（设计依据见 `docs/zh/architecture/inbound-unified-input-design.md`）。
 *
 * 设计文档早期的媒体事件形态是「下载完成后的 attachments/failures」。实际链路里
 * 下载是异步的（`index.ts` 先过 owner/enabled 闸门再下载），若等下载完成才投递事件，
 * 「先图后文」在慢下载下会先提交一个只含文本的 turn（正是要修的症状）。因此媒体事件
 * 携带一个 **outcome promise**：装配器立刻知道「本 turn 还有 in-flight 下载」，
 * 窗口到期后等它落定再 commit（§5.2）。
 */

import type { PlaceholderKind } from './placeholder.js';
import type { MediaOutcome } from './turn.js';

export interface InboundEventBase {
  userId: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  /** 飞书原始 msg_type（`text` / `image` / `post` / `merge_forward` …）。 */
  rawContentType: string;
}

export interface TextInboundEvent extends InboundEventBase {
  kind: 'text';
  /** 已剥离结构占位符的文本（可为空串：整条消息都是占位符）。 */
  text: string;
  /** 本条消息命中的占位符种类，用于「不支持」回执。 */
  placeholders: PlaceholderKind[];
  /** 未知标签（未来 SDK 新增），上层负责 warn。 */
  unknownTags: string[];
}

export interface MediaInboundEvent extends InboundEventBase {
  kind: 'media';
  /** 下载 + 落盘结果；装配器在窗口到期后等它落定才 commit。 */
  outcome: Promise<MediaOutcome>;
}

export interface RejectedInboundEvent extends InboundEventBase {
  kind: 'rejected';
  /** 面向人的说明（如「入站媒体保存已关闭」）。 */
  reason: string;
  /** 拒绝项的 kind（默认 `unknown`）。 */
  rejectedKind?: string;
}

export type InboundEvent = TextInboundEvent | MediaInboundEvent | RejectedInboundEvent;
