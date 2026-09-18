import { describe, it, expect } from 'vitest';
import { buildReceipt, unsupportedReason } from './receipt.js';

describe('buildReceipt（B4：不支持/失败必须可见）', () => {
  it('无文本纯附件：已保存路径 + 引导语', () => {
    const text = buildReceipt({
      saved: ['/tmp/a/image_1.png'],
      rejected: [],
      startWorkHint: true,
    });
    expect(text).toContain('📎 已保存 1 个文件：');
    expect(text).toContain('- /tmp/a/image_1.png');
    expect(text).toContain('💡 说一句话我就开始处理');
    expect(text).toContain('请处理 /tmp/a 下的文件');
  });

  it('有文本时不带引导语，只报未处理项', () => {
    const text = buildReceipt({
      saved: [],
      rejected: [{ kind: 'video', reason: 'big.mp4: 超过 100MB 大小限制', sourceMsgId: 'm1' }],
      startWorkHint: false,
    });
    expect(text).toBe('⚠️ big.mp4: 超过 100MB 大小限制');
  });

  it('多个未处理项合并成一条（不单独飘消息）', () => {
    const text = buildReceipt({
      saved: [],
      rejected: [
        { kind: 'location', reason: '暂不支持位置消息', sourceMsgId: 'm1' },
        { kind: 'sticker', reason: '暂不支持表情消息', sourceMsgId: 'm2' },
      ],
      startWorkHint: false,
    });
    expect(text).toBe('⚠️ 暂不支持位置消息；暂不支持表情消息');
  });

  it('已保存 + 未处理项合并到同一条回执', () => {
    const text = buildReceipt({
      saved: ['/tmp/a/ok.png'],
      rejected: [{ kind: 'video', reason: '下载失败: 234043', sourceMsgId: 'm1' }],
      startWorkHint: true,
    });
    expect(text).toContain('📎 已保存 1 个文件');
    expect(text).toContain('⚠️ 下载失败: 234043');
    expect(text).toContain('💡 说一句话我就开始处理');
  });

  it('跨分钟落在两个目录时全部列出', () => {
    const text = buildReceipt({
      saved: ['/tmp/a/1.png', '/tmp/b/2.png'],
      rejected: [],
      startWorkHint: true,
    });
    expect(text).toContain('请处理以下目录下的文件：/tmp/a、/tmp/b');
  });

  it('超过 10 个文件折叠', () => {
    const saved = Array.from({ length: 12 }, (_, i) => `/tmp/a/${i}.png`);
    const text = buildReceipt({ saved, rejected: [], startWorkHint: false }) ?? '';
    expect(text).toContain('📎 已保存 12 个文件');
    expect(text).toContain('… 等 12 个文件');
  });

  it('无内容可报时返回 undefined（调用方不发消息）', () => {
    expect(buildReceipt({ saved: [], rejected: [], startWorkHint: true })).toBeUndefined();
  });

  it('不支持文案自称 lark-remote 风格句式（暂不支持 X 消息）', () => {
    expect(unsupportedReason('location')).toBe('暂不支持位置消息');
    expect(unsupportedReason('share')).toBe('暂不支持名片/群分享消息');
    expect(unsupportedReason('unsupported')).toBe('暂不支持此类消息');
  });
});
