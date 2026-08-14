/**
 * 入口 wiring 静态守卫（设计豁免：index.ts 的 main() 在 import 即运行，
 * cardAction 分发无法行为注入测试；此处不用 /s 全文件模糊匹配，只取有界片段）。
 *
 * 守卫目标：approval.respond / approval.toggle 必须走「直接返回」分支
 * （router.handleCardAction 直返 toast），不得落入串行队列 enqueue 分支——
 * 否则审批响应排在等待审批的 run 之后：run 不结束不执行、run 结束 coordinator
 * 已删响应空转（线上复现：approval.respond 排队卡 + no approval coordinator）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('index.ts card action dispatch wiring guard (§9.19)', () => {
  it('approval.respond / approval.toggle 必须在直接返回分支（不落入串行队列）', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8');
    // 有界片段匹配（不用 /s 全文件模糊）：从 queue.input 条件到直接返回分支的
    // 右括号，允许多行 if 条件格式。
    const directReturnBlock = source.match(
      /actionValue\.cmd === 'queue\.input'[\s\S]{0,500}?\) \{/,
    );
    expect(directReturnBlock).not.toBeNull();
    const block = directReturnBlock?.[0] ?? '';
    expect(block).toContain("actionValue.cmd === 'approval.respond'");
    expect(block).toContain("actionValue.cmd === 'approval.toggle'");
  });
});
