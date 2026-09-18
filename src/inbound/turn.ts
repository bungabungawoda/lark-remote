/**
 * 统一入站回合（InboundTurn）模型。
 *
 * 设计依据：`docs/zh/architecture/inbound-unified-input-design.md` §4。
 * 核心不变量：**一个用户意图 = 一个 turn**，且任何进 agent 的内容都必须已落到本地路径。
 */

/** 附件种类（命名/展示语义）。与下载语义 `InboundMediaItem.type` 分离（§5.3）。 */
export type AttachmentKind = 'image' | 'file' | 'video' | 'audio' | 'sticker';

export interface InboundAttachment {
  /** 绝对路径（落盘后位置）。 */
  path: string;
  kind: AttachmentKind;
  /** 来源飞书 messageId：下载凭据的一部分，也是排障锚点。 */
  sourceMsgId: string;
  /** 原始文件名（有则保留，用于 prompt 标注与排障）。 */
  originalName?: string;
  /** 视频/语音时长（毫秒）。 */
  durationMs?: number;
}

/** 拿不到、不支持、超限、失败的项 —— 需要回执给人（不进 agent）。 */
export interface RejectedItem {
  /** 原 msg_type / 占位符种类 / 资源种类。 */
  kind: string;
  /** 面向人的说明。 */
  reason: string;
  sourceMsgId: string;
}

/** 提交原因，用于观测与测试断言。 */
export type CommitReason = 'idle' | 'timeout' | 'flush' | 'no-text';

export interface InboundTurn {
  userId: string;
  chatId: string;
  replyToMessageId?: string;
  /** 用户文本片段，按到达顺序；已剥离结构占位符。 */
  texts: string[];
  /** 已落盘的附件（绝对路径），按到达顺序。 */
  attachments: InboundAttachment[];
  rejected: RejectedItem[];
  /** 本 turn 覆盖的飞书 messageId（回执、去重、排障）。 */
  messageIds: string[];
  commitReason: CommitReason;
}

/** 媒体下载 + 落盘的结果（装配器等待它落定后才 commit）。 */
export interface MediaOutcome {
  attachments: InboundAttachment[];
  rejected: RejectedItem[];
}

export function bucketKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}
