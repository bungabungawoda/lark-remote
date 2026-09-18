/**
 * prompt 组装（结构化 `<attachments>` 标签块，设计依据见
 * `docs/zh/architecture/inbound-unified-input-design.md`）。
 *
 * 输出形态：用户文本（按到达顺序、原样）+ 空行 + 附件块。
 *
 *   <用户文本，原样>
 *
 *   <attachments>
 *     <file path="/abs/x.png" kind="image"/>
 *     <file path="/abs/a.mp4" kind="video" duration="80.9s" name="a.mp4"/>
 *   </attachments>
 *
 * 约定：无附件时 prompt 就是纯文本（与旧行为兼容，缩小回归面）；**绝不输出 file_key**
 * （对 agent 无意义，且是敏感凭据）。
 */

import type { InboundTurn } from './turn.js';

/** 属性值转义：只处理会破坏引号包裹的字符。 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/** 时长格式化（对齐 SDK 的 formatDuration：80.9s / 3s / 500ms）。 */
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function buildPrompt(turn: InboundTurn): string {
  const text = turn.texts.join('\n');
  if (turn.attachments.length === 0) return text;

  const lines = turn.attachments.map((att) => {
    let line = `  <file path="${escapeAttr(att.path)}" kind="${att.kind}"`;
    const duration = att.durationMs === undefined ? undefined : formatDuration(att.durationMs);
    if (duration) line += ` duration="${duration}"`;
    if (att.originalName) line += ` name="${escapeAttr(att.originalName)}"`;
    return `${line}/>`;
  });
  const block = `<attachments>\n${lines.join('\n')}\n</attachments>`;
  return text === '' ? block : `${text}\n\n${block}`;
}
