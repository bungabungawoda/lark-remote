/**
 * 入站媒体落盘测试（B2）。
 *
 * 2026-09-15 起 `InboundMediaHandler` 只做「落盘 + 报告结果」：返回值是
 * `MediaOutcome{attachments, rejected}`，时间语义与回执由装配器统一负责
 * （旧 500ms 合批提示窗口由装配器 700ms 静默期窗口取代）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeBridge } from '../../tests/lib/bridge-stubs.js';
import { AppConfigSchema } from '../config/index.js';
import type { InboundMediaPayload, InboundResourceKind } from '../connector/index.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
/** MP4：ISO BMFF，偏移 4 处是 'ftyp'。 */
const mp4Bytes = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
/** Ogg 容器（飞书语音）→ 推断为 .opus。 */
const oggBytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0, 0, 0, 0]);

let tmpDir: string;
let downloadDir: string;
let nextTempIndex = 0;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-media-test-'));
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-media-download-'));
  nextTempIndex = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(downloadDir, { recursive: true, force: true });
});

/** 模拟 connector 下载产物：写一个临时文件并返回 tempPath。 */
function downloaded(
  content: Buffer | string,
  overrides: Partial<{
    kind: InboundResourceKind;
    fileName?: string;
    mimeType?: string;
    durationMs?: number;
  }> = {},
): InboundMediaPayload['media'][number] {
  nextTempIndex += 1;
  const tempPath = path.join(downloadDir, `resource-${nextTempIndex}`);
  fs.writeFileSync(tempPath, content);
  const kind = overrides.kind ?? 'image';
  return {
    type: kind === 'image' ? 'image' : 'file',
    ...overrides,
    kind,
    tempPath,
  };
}

function mediaPayload(overrides: Partial<InboundMediaPayload> = {}): InboundMediaPayload {
  return {
    userId: 'user-1',
    chatId: 'chat-1',
    messageId: 'msg-1',
    rawContentType: 'image',
    media: [downloaded(pngBytes, { mimeType: 'image/png' })],
    failures: [],
    ...overrides,
  };
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
  it('图片保存到 <cwd>/.lark-remote-temp/<YYYYMMDDHHmm>/image_<HHmmss>_<n>.png，并回报绝对路径', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    const outcome = await bridge.saveInboundMedia(mediaPayload());

    const files = savedFiles();
    expect(files).toHaveLength(1);
    const stamp = path.basename(path.dirname(files[0]));
    expect(stamp).toMatch(/^\d{12}$/); // YYYYMMDDHHmm
    expect(path.basename(files[0])).toMatch(/^image_\d{6}_1\.png$/);
    expect(fs.readFileSync(files[0])).toEqual(pngBytes);
    // 临时文件被移动到最终位置，不再残留
    expect(fs.readdirSync(downloadDir)).toHaveLength(0);
    // 回报的附件带绝对路径 + kind + 来源 messageId（prompt 附件块的输入）
    expect(outcome.attachments[0]).toMatchObject({
      path: files[0],
      kind: 'image',
      sourceMsgId: 'msg-1',
    });
    expect(outcome.rejected).toEqual([]);
  });

  it('图片缺 MIME 时按魔数推断扩展名（png/jpeg）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(
      mediaPayload({
        media: [
          downloaded(pngBytes, { mimeType: undefined }),
          downloaded(jpegBytes, { mimeType: undefined }),
        ],
      }),
    );

    const names = savedFiles()
      .map((f) => path.basename(f))
      .sort();
    expect(names.filter((n) => n.endsWith('.jpg'))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith('.png'))).toHaveLength(1);
    expect(names.every((n) => /^image_\d{6}_\d+\.\w+$/.test(n))).toBe(true);
  });

  it('视频/语音无 fileName 时按 MIME/魔数补扩展名（此前是裸 file_HHmmss_n）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(
      mediaPayload({
        media: [
          downloaded(mp4Bytes, { kind: 'video', mimeType: undefined }),
          downloaded(oggBytes, { kind: 'audio', mimeType: undefined }),
          downloaded(mp4Bytes, { kind: 'video', mimeType: 'video/mp4' }),
        ],
      }),
    );

    const names = savedFiles()
      .map((f) => path.basename(f))
      .sort();
    expect(names.filter((n) => n.endsWith('.mp4'))).toHaveLength(2);
    expect(names.filter((n) => n.endsWith('.opus'))).toHaveLength(1);
    expect(names.every((n) => /^(video|audio|sticker)_\d{6}_\d+\.\w+$/.test(n))).toBe(true);
  });

  it('视频有 fileName 时保留原名，并把时长回报给 prompt', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    const outcome = await bridge.saveInboundMedia(
      mediaPayload({
        rawContentType: 'media',
        media: [
          downloaded(mp4Bytes, {
            kind: 'video',
            fileName: '1755000000.mp4',
            mimeType: 'video/mp4',
            durationMs: 80900,
          }),
        ],
      }),
    );

    expect(path.basename(savedFiles()[0])).toBe('1755000000.mp4');
    expect(outcome.attachments[0]).toMatchObject({
      kind: 'video',
      originalName: '1755000000.mp4',
      durationMs: 80900,
    });
  });

  it('file 消息保留原始文件名（sanitize 防穿越 + 长度截断）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(
      mediaPayload({
        rawContentType: 'file',
        media: [
          downloaded('x', {
            kind: 'file',
            fileName: '../../etc/passwd',
            mimeType: 'text/plain',
          }),
          downloaded('y', {
            kind: 'file',
            fileName: `${'长'.repeat(200)}.txt`,
            mimeType: 'text/plain',
          }),
        ],
      }),
    );

    const names = savedFiles()
      .map((f) => path.basename(f))
      .sort();
    expect(names[0]).toBe('passwd');
    // 超长文件名按 UTF-8 字节截断（保留扩展名），不再 ENAMETOOLONG
    expect(names[1]).toMatch(/\.txt$/);
    expect(Buffer.byteLength(names[1], 'utf8')).toBeLessThanOrEqual(240);
    // 穿越失败：任何文件都不能写到 temp 根目录之外
    expect(fs.existsSync(path.join(tmpDir, 'passwd'))).toBe(false);
  });

  it('同名冲突自动加序号，不覆盖', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(
      mediaPayload({
        rawContentType: 'file',
        media: [downloaded('first', { kind: 'file', fileName: 'a.txt', mimeType: 'text/plain' })],
      }),
    );
    await bridge.saveInboundMedia(
      mediaPayload({
        messageId: 'msg-2',
        rawContentType: 'file',
        media: [downloaded('second', { kind: 'file', fileName: 'a.txt', mimeType: 'text/plain' })],
      }),
    );

    const files = savedFiles();
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['a-1.txt', 'a.txt']);
    expect(fs.readFileSync(files.find((f) => f.endsWith('a.txt'))!)).toEqual(Buffer.from('first'));
  });

  it('cwd 不可用 → rejected 提示先 /cd 或 /ws use，并清理临时文件', async () => {
    const { bridge } = makeBridge();

    const outcome = await bridge.saveInboundMedia(mediaPayload());

    expect(savedFiles()).toHaveLength(0);
    expect(outcome.attachments).toEqual([]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].reason).toContain('未设置工作目录');
    expect(outcome.rejected[0].reason).toContain('/cd');
    expect(fs.readdirSync(downloadDir)).toHaveLength(0);
  });

  it('目录创建失败（cwd 是文件）→ rejected 明确错误并清理临时文件', async () => {
    const { bridge, sessionStore } = makeBridge();
    // cwd 指向一个文件：mkdirSync(<file>/.lark-remote-temp/...) 必抛 ENOTDIR
    const fileAsCwd = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fileAsCwd, 'x');
    sessionStore.setCwd('user-1', fileAsCwd);

    const outcome = await bridge.saveInboundMedia(mediaPayload());

    expect(savedFiles()).toHaveLength(0);
    expect(outcome.rejected[0].reason).toContain('保存失败：无法创建目录');
    expect(fs.readdirSync(downloadDir)).toHaveLength(0);
  });

  it('全部失败（下载/超限）→ 全部进 rejected，不落盘', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    const outcome = await bridge.saveInboundMedia(
      mediaPayload({
        media: [],
        failures: [{ kind: 'file', fileName: 'big.pdf', reason: '超过 100MB 大小限制' }],
      }),
    );

    expect(savedFiles()).toHaveLength(0);
    expect(outcome.rejected).toEqual([
      { kind: 'file', reason: 'big.pdf: 超过 100MB 大小限制', sourceMsgId: 'msg-1' },
    ]);
  });

  it('部分失败：成功文件照常落盘，失败原因与路径一并回报', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    const outcome = await bridge.saveInboundMedia(
      mediaPayload({
        failures: [{ kind: 'video', fileName: 'big.mp4', reason: '超过 100MB 大小限制' }],
      }),
    );

    expect(savedFiles()).toHaveLength(1);
    expect(outcome.attachments).toHaveLength(1);
    expect(outcome.rejected[0].reason).toBe('big.mp4: 超过 100MB 大小限制');
  });

  it('bridge.setConfig 后 dirName 活引用生效（非启动快照）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(mediaPayload());
    expect(fs.existsSync(path.join(tmpDir, '.lark-remote-temp'))).toBe(true);

    const nextConfig = AppConfigSchema.parse({
      ...bridge.config,
      inboundMedia: { enabled: true, dirName: 'other-temp', maxFileSizeMb: 100 },
    });
    bridge.setConfig(nextConfig);
    await bridge.saveInboundMedia(mediaPayload({ messageId: 'msg-2' }));

    // 新配置生效：文件落在 other-temp/ 而非旧目录
    expect(fs.existsSync(path.join(tmpDir, 'other-temp'))).toBe(true);
    const stamp = fs.readdirSync(path.join(tmpDir, 'other-temp'))[0];
    expect(fs.readdirSync(path.join(tmpDir, 'other-temp', stamp))).toHaveLength(1);
  });
});
