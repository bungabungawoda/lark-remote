import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildFileName,
  imageExtension,
  limitFileNameLength,
  sanitizeFileName,
  uniqueTargetPath,
} from './inbound-media.js';
import { makeBridge } from '../../tests/lib/bridge-stubs.js';
import { AppConfigSchema } from '../config/index.js';
import type { InboundMediaPayload } from '../connector/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

let tmpDir: string;
let downloadDir: string;
let nextTempIndex = 0;

beforeEach(() => {
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-media-test-'));
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-media-download-'));
  nextTempIndex = 0;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(downloadDir, { recursive: true, force: true });
});

/** 模拟 connector 下载产物：写一个临时文件并返回 tempPath。 */
function downloaded(
  content: Buffer | string,
  overrides: Partial<{ type: 'image' | 'file'; fileName?: string; mimeType?: string }> = {},
): { type: 'image' | 'file'; fileName?: string; mimeType?: string; tempPath: string } {
  nextTempIndex += 1;
  const tempPath = path.join(downloadDir, `resource-${nextTempIndex}`);
  fs.writeFileSync(tempPath, content);
  return { type: 'image', ...overrides, tempPath };
}

function mediaPayload(overrides: Partial<InboundMediaPayload> = {}): InboundMediaPayload {
  return {
    userId: 'user-1',
    chatId: 'chat-1',
    messageId: 'msg-1',
    media: [downloaded(pngBytes, { mimeType: 'image/png' })],
    failures: [],
    ...overrides,
  };
}

function sentTexts(connector: ReturnType<typeof makeBridge>['connector']): string[] {
  return connector._sent
    .map((s) => (s.input as { text?: string }).text)
    .filter((t): t is string => typeof t === 'string');
}

function savedFiles(): string[] {
  const root = path.join(tmpDir, '.lark-remote-temp');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const stamp of fs.readdirSync(root)) {
    const dir = path.join(root, stamp);
    for (const file of fs.readdirSync(dir)) out.push(path.join(dir, file));
  }
  return out;
}

describe('InboundMediaHandler 落盘', () => {
  it('图片保存到 <cwd>/.lark-remote-temp/<YYYYMMDDHHmm>/image_<HHmmss>_<n>.png 并回复提示', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(mediaPayload());

    const files = savedFiles();
    expect(files).toHaveLength(1);
    const stamp = path.basename(path.dirname(files[0]));
    expect(stamp).toMatch(/^\d{12}$/); // YYYYMMDDHHmm
    expect(path.basename(files[0])).toMatch(/^image_\d{6}_1\.png$/);
    expect(fs.readFileSync(files[0])).toEqual(pngBytes);
    // 临时文件被移动到最终位置，不再残留
    expect(fs.readdirSync(downloadDir)).toHaveLength(0);

    expect(sentTexts(connector)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('📎 已保存 1 个文件');
    expect(sentTexts(connector)[0]).toContain(files[0]);
  });

  it('file 消息保留原始文件名（sanitize 防穿越 + 长度截断）', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(
      mediaPayload({
        media: [
          downloaded('x', {
            type: 'file',
            fileName: '../../etc/passwd',
            mimeType: 'text/plain',
          }),
          downloaded('y', {
            type: 'file',
            fileName: `${'长'.repeat(200)}.txt`,
            mimeType: 'text/plain',
          }),
        ],
      }),
    );

    const files = savedFiles();
    expect(files).toHaveLength(2);
    const names = files.map((f) => path.basename(f)).sort();
    expect(names[0]).toBe('passwd');
    // 超长文件名按 UTF-8 字节截断（保留扩展名），不再 ENAMETOOLONG
    expect(names[1]).toMatch(/\.txt$/);
    expect(Buffer.byteLength(names[1], 'utf8')).toBeLessThanOrEqual(240);
    // 穿越失败：任何文件都不能写到 temp 根目录之外
    expect(fs.existsSync(path.join(tmpDir, 'passwd'))).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(sentTexts(connector)[0]).toContain(files[0]);
  });

  it('同名冲突自动加序号，不覆盖', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(
      mediaPayload({
        media: [downloaded('first', { type: 'file', fileName: 'a.txt', mimeType: 'text/plain' })],
      }),
    );
    await bridge.onInboundMedia(
      mediaPayload({
        media: [downloaded('second', { type: 'file', fileName: 'a.txt', mimeType: 'text/plain' })],
      }),
    );

    const files = savedFiles();
    expect(files).toHaveLength(2);
    const names = files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(['a-1.txt', 'a.txt']);
    expect(fs.readFileSync(files.find((f) => f.endsWith('a.txt'))!)).toEqual(Buffer.from('first'));

    await vi.advanceTimersByTimeAsync(500);
    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('📎 已保存 2 个文件');
  });

  it('cwd 不可用时拒绝保存、提示先 /cd 或 /ws use，并清理临时文件', async () => {
    const { bridge, connector } = makeBridge();
    const payload = mediaPayload();

    await bridge.onInboundMedia(payload);

    expect(savedFiles()).toHaveLength(0);
    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('未设置工作目录');
    expect(sentTexts(connector)[0]).toContain('/cd');
    expect(fs.readdirSync(downloadDir)).toHaveLength(0);
  });

  it('目录创建失败（cwd 是文件）时回复明确错误并清理临时文件', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    // cwd 指向一个文件：mkdirSync(<file>/.lark-remote-temp/...) 必抛 ENOTDIR
    const fileAsCwd = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fileAsCwd, 'x');
    sessionStore.setCwd('user-1', fileAsCwd);

    await bridge.onInboundMedia(mediaPayload());

    expect(savedFiles()).toHaveLength(0);
    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('保存失败');
    expect(fs.readdirSync(downloadDir)).toHaveLength(0);
  });

  it('全部失败时直接回复保存失败', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(
      mediaPayload({
        media: [],
        failures: [{ fileName: 'big.pdf', reason: '超过 50MB 大小限制' }],
      }),
    );

    expect(savedFiles()).toHaveLength(0);
    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('保存失败');
    expect(sentTexts(connector)[0]).toContain('big.pdf');
  });

  it('部分失败：成功文件照常保存，提示附带失败原因', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(
      mediaPayload({
        failures: [{ fileName: 'big.pdf', reason: '超过 50MB 大小限制' }],
      }),
    );

    const files = savedFiles();
    expect(files).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    const text = sentTexts(connector)[0];
    expect(text).toContain('已保存 1 个文件');
    expect(text).toContain('big.pdf');
  });
});

describe('InboundMediaHandler 合批', () => {
  it('500ms 窗口内同 user/chat 的图片合并为一条提示', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(mediaPayload({ messageId: 'm1' }));
    await vi.advanceTimersByTimeAsync(200);
    await bridge.onInboundMedia(mediaPayload({ messageId: 'm2' }));

    expect(savedFiles()).toHaveLength(2);
    expect(sentTexts(connector)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);

    const texts = sentTexts(connector);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('📎 已保存 2 个文件');
  });

  it('文本到达时 flushMediaNotifications 立即冲刷批次', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(mediaPayload({ messageId: 'm1' }));
    await bridge.onInboundMedia(mediaPayload({ messageId: 'm2' }));
    bridge.flushMediaNotifications('user-1', 'chat-1');

    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('已保存 2 个文件');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentTexts(connector)).toHaveLength(1);
  });

  it('flushAllPending 冲刷全部批次（/exit、/restart 退出前）', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(mediaPayload({ messageId: 'm1' }));
    await bridge.onInboundMedia(mediaPayload({ messageId: 'm2' }));
    await bridge.flushAllMediaNotifications();

    expect(sentTexts(connector)).toHaveLength(1);
    expect(sentTexts(connector)[0]).toContain('已保存 2 个文件');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentTexts(connector)).toHaveLength(1);
  });

  it('bridge.setConfig 后 dirName 活引用生效（非启动快照）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(mediaPayload());
    expect(fs.existsSync(path.join(tmpDir, '.lark-remote-temp'))).toBe(true);

    const nextConfig = AppConfigSchema.parse({
      ...bridge.config,
      inboundMedia: { enabled: true, dirName: 'other-temp', maxFileSizeMb: 50 },
    });
    bridge.setConfig(nextConfig);
    await bridge.onInboundMedia(mediaPayload({ messageId: 'm2' }));

    // 新配置生效：文件落在 other-temp/ 而非旧目录
    expect(fs.existsSync(path.join(tmpDir, 'other-temp'))).toBe(true);
    const stamp = fs.readdirSync(path.join(tmpDir, 'other-temp'))[0];
    expect(fs.readdirSync(path.join(tmpDir, 'other-temp', stamp))).toHaveLength(1);
  });

  it('不同 replyTo 上下文强制拆批', async () => {
    const { bridge, sessionStore, connector } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.onInboundMedia(mediaPayload({ messageId: 'm1', replyToMessageId: 'r1' }));
    await bridge.onInboundMedia(mediaPayload({ messageId: 'm2', replyToMessageId: 'r2' }));
    bridge.flushMediaNotifications('user-1', 'chat-1');

    expect(sentTexts(connector)).toHaveLength(2);
  });
});

describe('文件名工具', () => {
  it('sanitizeFileName 剥离目录与控制字符', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\u0000b.txt')).toBe('a_b.txt');
    expect(sanitizeFileName('a\\b.txt')).toBe('a_b.txt');
    expect(sanitizeFileName('..')).toBe('');
    expect(sanitizeFileName('  ')).toBe('');
  });

  it('imageExtension 按 MIME 映射，未知 MIME 按魔数兜底，全未知返回 undefined', () => {
    expect(imageExtension('image/png', Buffer.alloc(0))).toBe('png');
    expect(imageExtension('image/jpeg', Buffer.alloc(0))).toBe('jpg');
    expect(imageExtension('image/gif', Buffer.alloc(0))).toBe('gif');
    expect(imageExtension('image/webp', Buffer.alloc(0))).toBe('webp');
    expect(imageExtension(undefined, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('jpg');
    expect(imageExtension('application/octet-stream', pngBytes)).toBe('png');
    expect(imageExtension(undefined, Buffer.alloc(0))).toBeUndefined();
  });

  it('buildFileName：file 保留名，image 生成 image_<HHmmss>_<n>.<ext>；未知格式无扩展名', () => {
    const at = new Date(2026, 7, 16, 14, 30, 5); // 2026-08-16 14:30:05
    expect(buildFileName({ type: 'file', fileName: 'report.pdf', tempPath: '' }, 1, at)).toBe(
      'report.pdf',
    );
    expect(buildFileName({ type: 'file', fileName: '..', tempPath: '' }, 2, at)).toBe(
      'file_143005_2',
    );
    const pngTemp = path.join(downloadDir, 'img-raw');
    fs.writeFileSync(pngTemp, pngBytes);
    expect(buildFileName({ type: 'image', mimeType: 'image/png', tempPath: pngTemp }, 1, at)).toBe(
      'image_143005_1.png',
    );
    const unknownTemp = path.join(downloadDir, 'img-unknown');
    fs.writeFileSync(unknownTemp, Buffer.from('not-an-image'));
    expect(
      buildFileName({ type: 'image', mimeType: undefined, tempPath: unknownTemp }, 3, at),
    ).toBe('image_143005_3');
  });

  it('limitFileNameLength 按 UTF-8 字节截断并保留扩展名', () => {
    expect(limitFileNameLength('short.txt')).toBe('short.txt');
    const longAscii = `${'a'.repeat(250)}.txt`;
    const cut = limitFileNameLength(longAscii);
    expect(cut.endsWith('.txt')).toBe(true);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(240);
    // 多字节字符不会被截断在中间
    const chinese = `${'中'.repeat(100)}.txt`;
    const cutZh = limitFileNameLength(chinese);
    expect(Buffer.byteLength(cutZh, 'utf8')).toBeLessThanOrEqual(240);
    expect(cutZh).not.toContain('�');
  });

  it('uniqueTargetPath 冲突加序号', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-unique-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      expect(uniqueTargetPath(dir, 'a.txt')).toBe(path.join(dir, 'a-1.txt'));
      fs.writeFileSync(path.join(dir, 'a-1.txt'), 'y');
      expect(uniqueTargetPath(dir, 'a.txt')).toBe(path.join(dir, 'a-2.txt'));
      expect(uniqueTargetPath(dir, 'b.txt')).toBe(path.join(dir, 'b.txt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
