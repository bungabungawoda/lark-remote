import { describe, it, expect } from 'vitest';
import { buildPrompt, formatDuration } from './prompt.js';
import type { InboundTurn } from './turn.js';

function turn(overrides: Partial<InboundTurn> = {}): InboundTurn {
  return {
    userId: 'u1',
    chatId: 'c1',
    texts: [],
    attachments: [],
    rejected: [],
    messageIds: ['m1'],
    commitReason: 'idle',
    ...overrides,
  };
}

describe('buildPrompt（决策 3：结构化附件块）', () => {
  it('无附件时就是纯文本（与旧行为兼容）', () => {
    expect(buildPrompt(turn({ texts: ['hello'] }))).toBe('hello');
  });

  it('多段文本按到达顺序换行拼接、不加工', () => {
    expect(buildPrompt(turn({ texts: ['**T**', '看这个'] }))).toBe('**T**\n看这个');
  });

  it('文本 + 附件：文本在前、空行、附件块', () => {
    const prompt = buildPrompt(
      turn({
        texts: ['test'],
        attachments: [
          { path: '/tmp/a/image_220934_1.png', kind: 'image', sourceMsgId: 'm1' },
          {
            path: '/tmp/a/1755000000.mp4',
            kind: 'video',
            sourceMsgId: 'm1',
            originalName: '1755000000.mp4',
            durationMs: 80900,
          },
        ],
      }),
    );
    expect(prompt).toBe(
      'test\n\n' +
        '<attachments>\n' +
        '  <file path="/tmp/a/image_220934_1.png" kind="image"/>\n' +
        '  <file path="/tmp/a/1755000000.mp4" kind="video" duration="80.9s" name="1755000000.mp4"/>\n' +
        '</attachments>',
    );
  });

  it('只有附件没有文本时 prompt 就是附件块', () => {
    const prompt = buildPrompt(
      turn({ attachments: [{ path: '/tmp/a/x.opus', kind: 'audio', sourceMsgId: 'm1' }] }),
    );
    expect(prompt).toBe(
      '<attachments>\n  <file path="/tmp/a/x.opus" kind="audio"/>\n</attachments>',
    );
  });

  it('绝不输出 file_key', () => {
    const prompt = buildPrompt(
      turn({
        texts: ['hi'],
        attachments: [{ path: '/tmp/a/x.png', kind: 'image', sourceMsgId: 'm1' }],
      }),
    );
    expect(prompt).not.toContain('file_key');
    expect(prompt).not.toContain('fileKey');
    expect(prompt).not.toContain('img_v3');
  });

  it('文件名中的引号被转义（不破坏属性）', () => {
    const prompt = buildPrompt(
      turn({
        attachments: [
          { path: '/tmp/a/x', kind: 'file', sourceMsgId: 'm1', originalName: 'a"b.txt' },
        ],
      }),
    );
    expect(prompt).toContain('name="a&quot;b.txt"');
  });

  it('duration 格式化对齐 SDK（ms / 整数秒 / 一位小数）', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(3000)).toBe('3s');
    expect(formatDuration(80900)).toBe('80.9s');
    expect(formatDuration(-1)).toBeUndefined();
  });
});
