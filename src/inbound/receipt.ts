/**
 * 入站回执文案（设计依据见 `docs/zh/architecture/inbound-unified-input-design.md`）。
 *
 * 两类回执合并成一条：
 * 1. 无文本纯附件（决策 2）：不自动起 turn，只回已保存路径 + 引导语；
 * 2. 拿不到的东西（不支持类型 / 超限 / 下载失败 / 媒体保存已关闭）：明确告知，
 *    而不是把占位符塞给 agent。
 *
 * 用户可见文案指代本程序时只能写 `lark-remote`（AGENTS.md 命名纪律）。
 */

import type { PlaceholderKind } from './placeholder.js';
import type { RejectedItem } from './turn.js';
import path from 'node:path';

/** 单条回执最多列出的文件数；超出折叠为 "… 等 N 个文件"（沿用旧提示口径）。 */
export const MAX_PATHS_IN_RECEIPT = 10;

/** 占位符种类 → 面向人的名称。 */
const PLACEHOLDER_LABELS: Record<PlaceholderKind, string> = {
  image: '图片',
  file: '文件',
  video: '视频',
  audio: '语音',
  sticker: '表情',
  share: '名片/群分享',
  location: '位置',
  folder: '文件夹',
  vote: '投票',
  todo: '待办',
  meeting: '视频会议',
  calendar: '日程',
  hongbao: '红包',
  forwarded: '合并转发',
  unsupported: '此类',
  unknown: '未知类型',
};

/** 「不支持」回执句式（§5.7 表：不支持类型统一「暂不支持 X」）。 */
export function unsupportedReason(kind: PlaceholderKind): string {
  return `暂不支持${PLACEHOLDER_LABELS[kind]}消息`;
}

export interface ReceiptInput {
  /** 本次已落盘的绝对路径（仅无文本场景展示）。 */
  saved: string[];
  /** 未处理项（不支持 / 超限 / 失败）。 */
  rejected: RejectedItem[];
  /** 本次没有用户文本：附上「说一句话我就开始处理」引导。 */
  startWorkHint: boolean;
}

/**
 * 生成回执文案；没有任何需要告知的内容时返回 undefined（调用方不发消息）。
 */
export function buildReceipt(input: ReceiptInput): string | undefined {
  const parts: string[] = [];

  if (input.saved.length > 0) {
    const lines = input.saved.slice(0, MAX_PATHS_IN_RECEIPT).map((p) => `- ${p}`);
    const overflow =
      input.saved.length > MAX_PATHS_IN_RECEIPT ? `\n… 等 ${input.saved.length} 个文件` : '';
    parts.push(`📎 已保存 ${input.saved.length} 个文件：\n${lines.join('\n')}${overflow}`);
  }

  if (input.rejected.length > 0) {
    parts.push(`⚠️ ${input.rejected.map((r) => r.reason).join('；')}`);
  }

  if (input.startWorkHint && input.saved.length > 0) {
    // 保存目录去重（跨分钟时可能落在两个目录，此时全部列出）。
    const dirs = [...new Set(input.saved.map((p) => path.dirname(p)))];
    const example =
      dirs.length === 1
        ? `请处理 ${dirs[0]} 下的文件`
        : `请处理以下目录下的文件：${dirs.join('、')}`;
    parts.push(`💡 说一句话我就开始处理，例如：${example}`);
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n');
}
