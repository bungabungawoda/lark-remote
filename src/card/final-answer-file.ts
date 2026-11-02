/**
 * 完整回答超出一张卡片时，落成 Markdown 文件随卡片发送。
 *
 * 为什么不再拆纯文本消息：拆出来的「完整回答（1/N）」与卡片正文重复
 * （2026-11-02 实机反馈：同一篇回答用户看到两遍），而且纯文本会丢表格、
 * 代码块等 Markdown 结构。文件通道保留原文逐字不变，且只多一条文件消息。
 *
 * 调用方负责用后删除：`bestEffortUnlink()` 见 `common/fs.ts`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cardWithHeader } from './card-shared.js';
import { markdownDiv } from './collapsible.js';

/** 文件名里的可读时间戳（本地时区），如 `20261102-0715`。 */
function fileStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/**
 * 把完整回答写进系统临时目录里的 `.md` 文件，返回绝对路径。
 *
 * 文件名带时间戳与随机后缀：同一分钟内的多个 run 不会互相覆盖，也不会在
 * 飞书里显示成同名附件。内容逐字写入，不做任何截断或转义。
 */
export function writeFinalAnswerFile(text: string, now: Date = new Date()): string {
  const suffix = randomUUID().slice(0, 8);
  const filePath = path.join(
    os.tmpdir(),
    `lark-remote-final-answer-${fileStamp(now)}-${suffix}.md`,
  );
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

/** 文件通道失败时的提示卡——终态反馈也只走卡片，不发纯文本。 */
export function finalAnswerFileFailureCard(message: string): object {
  return cardWithHeader({
    template: 'red',
    title: '⚠️ 完整回答文件发送失败',
    elements: [markdownDiv(`完整回答没能作为 Markdown 文件发出：${message}`)],
  });
}
