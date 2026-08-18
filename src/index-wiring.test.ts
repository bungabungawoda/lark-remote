/**
 * 入口 wiring 静态守卫（设计豁免：index.ts 的 main() 在 import 即运行，
 * cardAction 分发无法行为注入测试；此处不用 /s 全文件模糊匹配，只取有界片段）。
 *
 * 守卫目标：approval.respond / approval.toggle / approval.answer 系列必须走
 * 「直接返回」分支
 * （router.handleCardAction 直返 toast），不得落入串行队列 enqueue 分支——
 * 否则审批响应排在等待审批的 run 之后：run 不结束不执行、run 结束 coordinator
 * 已删响应空转（线上复现：approval.respond 排队卡 + no approval coordinator）。
 * 2026-08-17 review：approval.answer 家族（answer/answerSubmit/answerCustom）
 * 曾漏在直返列表外，错误 toast（过期/重复 nonce/非法选项）被 enqueueImmediate
 * 静默吞掉——必须与 respond/toggle 同等守卫。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('index.ts card action dispatch wiring guard (§9.19)', () => {
  it('approval.respond / toggle / answer 家族必须在直接返回分支（不落入串行队列）', () => {
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
    expect(block).toContain("actionValue.cmd === 'approval.answer'");
    expect(block).toContain("actionValue.cmd === 'approval.answerSubmit'");
    expect(block).toContain("actionValue.cmd === 'approval.answerCustom'");
  });
});

/**
 * 入口 wiring 静态守卫（设计豁免同 §9.19：index.ts 的 setupMessageHandlers
 * 无法行为注入测试——main() 在 import 即运行）。有界片段匹配（不用 /s 全文件）。
 *
 * 守卫目标：入站媒体必须先过 owner + enabled 闸门再下载（P1 review 修复——
 * 认证发生在下载之前，未认证/关闭配置时不得发生网络下载）。
 */
describe('index.ts inbound media wiring guard（先认证后下载）', () => {
  it('setInboundMediaDetectedHandler 回调内先 isOwner/enabled 再 downloadInboundMedia', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8');
    const mediaBlock = source.match(
      /connector\.setInboundMediaDetectedHandler\(\(msg\) => \{[\s\S]{0,1600}?logger\.error\('\[media\] inbound media download\/save failed:'/,
    );
    expect(mediaBlock).not.toBeNull();
    const block = mediaBlock?.[0] ?? '';
    expect(block).toContain('binder.isOwner(msg.userId)');
    // 活引用：读 router.config（/config 保存后是新对象，启动快照会过期）
    expect(block).toContain('router.config.inboundMedia.enabled');
    expect(block).toContain('connector.downloadInboundMedia(msg, {');
    expect(block).toContain('maxFileSizeMb: router.config.inboundMedia.maxFileSizeMb');
    expect(block).toContain('bridge.onInboundMedia(payload)');
    // 意外抛错时兜底清理临时文件
    expect(block).toContain('silentlyUnlink(item.tempPath)');
    // 关闭配置时不静默：owner 收到明确反馈（P3 review），且不进入下载
    expect(block).toContain('入站媒体保存已关闭');
    expect(block).toContain('.sendResult(');
    // 顺序保证：owner 检查必须在下载之前
    expect(block.indexOf('binder.isOwner(msg.userId)')).toBeLessThan(
      block.indexOf('connector.downloadInboundMedia(msg, {'),
    );
    expect(block.indexOf('router.config.inboundMedia.enabled')).toBeLessThan(
      block.indexOf('connector.downloadInboundMedia(msg, {'),
    );
  });
});

/**
 * 入口 wiring 静态守卫：别名展开必须在命令分发前完成，且 /、! 分支与
 * 入队 payload 都必须使用展开后的 content（而非原始 msg.content）。
 */
describe('index.ts alias expansion wiring guard', () => {
  it('消息处理使用 expandAliasMessage 的结果分发', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8');
    const aliasBlock = source.match(
      /const content = router\.expandAliasMessage\(msg\.content\);[\s\S]{0,6000}?messagePreview: content\.slice\(0, 3000\)/,
    );
    expect(aliasBlock).not.toBeNull();
    const block = aliasBlock?.[0] ?? '';
    expect(block).toContain("content.trim().startsWith('/')");
    expect(block).toContain("content.trim().startsWith('!')");
    expect(block).toMatch(/router\.handle\(\s+content,/);
    // 展开结果不得再被原始消息覆盖
    expect(block).not.toContain('messagePreview: msg.content.slice(0, 3000)');
  });
});
