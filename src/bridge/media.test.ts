/**
 * 入站媒体落盘测试。
 *
 * `InboundMediaHandler` 只做「落盘 + 报告结果」：返回值是
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

  it('file 名含 win32 非法字符/尾点时替换与剥离，落盘不失败（review 2026-10-07）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(
      mediaPayload({
        media: [
          downloaded('x', {
            kind: 'file',
            // `:` `?` 是 NTFS 非法字符；尾点在 win32 落盘时会被静默剥离
            fileName: 'weird:file?.txt.',
            mimeType: 'text/plain',
          }),
        ],
      }),
    );

    const names = savedFiles().map((f) => path.basename(f));
    expect(names).toEqual(['weird_file_.txt']);
    expect(fs.existsSync(path.join(path.dirname(savedFiles()[0]!), 'weird_file_.txt'))).toBe(true);
  });

  it('同名冲突自动加序号，不覆盖', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(
      mediaPayload({
        media: [downloaded('first', { kind: 'file', fileName: 'a.txt', mimeType: 'text/plain' })],
      }),
    );
    await bridge.saveInboundMedia(
      mediaPayload({
        messageId: 'msg-2',
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
    // config 由测试自己持有（Bridge.config 是 private）：传入 makeBridge，
    // 再基于同一份派生 nextConfig，避免访问私有字段。
    const config = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
    });
    const { bridge, sessionStore } = makeBridge({ config });
    sessionStore.setCwd('user-1', tmpDir);

    await bridge.saveInboundMedia(mediaPayload());
    expect(fs.existsSync(path.join(tmpDir, '.lark-remote-temp'))).toBe(true);

    const nextConfig = AppConfigSchema.parse({
      ...config,
      inboundMedia: { enabled: true, dirName: 'other-temp', maxFileSizeMb: 100 },
    });
    bridge.setConfig(nextConfig);
    await bridge.saveInboundMedia(mediaPayload({ messageId: 'msg-2' }));

    // 新配置生效：文件落在 other-temp/ 而非旧目录
    expect(fs.existsSync(path.join(tmpDir, 'other-temp'))).toBe(true);
    const stamp = fs.readdirSync(path.join(tmpDir, 'other-temp'))[0];
    expect(fs.readdirSync(path.join(tmpDir, 'other-temp', stamp))).toHaveLength(1);
  });

  it('缺省 kind/fileName 的失败与落盘失败的媒体都如实进 rejected（原名/序号标签）', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);

    const named = downloaded('x', {
      kind: 'file',
      fileName: 'broken.txt',
      mimeType: 'text/plain',
    });
    const unsanitizable = downloaded('y', {
      kind: 'file',
      fileName: '..',
      mimeType: 'text/plain',
    });
    const anonymous = downloaded('z', { kind: 'file', mimeType: 'text/plain' });
    // 让 atomicMoveFile 真的抛 ENOENT（模拟下载产物丢失），逐个进 catch。
    fs.rmSync(named.tempPath);
    fs.rmSync(unsanitizable.tempPath);
    fs.rmSync(anonymous.tempPath);

    const outcome = await bridge.saveInboundMedia(
      mediaPayload({
        messageId: 'msg-1',
        media: [named, unsanitizable, anonymous],
        failures: [{ reason: '超过 100MB 大小限制' }],
      }),
    );

    expect(outcome.attachments).toEqual([]);
    expect(savedFiles()).toHaveLength(0);
    expect(outcome.rejected).toHaveLength(4);
    // 失败项没带 kind / fileName：默认 file，原因原样透出、不加文件名前缀。
    expect(outcome.rejected[0]).toEqual({
      kind: 'file',
      reason: '超过 100MB 大小限制',
      sourceMsgId: 'msg-1',
    });
    // 落盘失败项：有原名用原名、原名被 sanitize 抹掉就回退原名、没原名用序号。
    expect(outcome.rejected[1].reason).toMatch(/^broken\.txt: /);
    expect(outcome.rejected[2].reason).toMatch(/^\.\.: /);
    expect(outcome.rejected[3].reason).toMatch(/^第 3 个: /);
    expect(outcome.rejected.every((r) => r.sourceMsgId === 'msg-1')).toBe(true);
  });
});

/**
 * extensionFor 的魔数 / MIME 判定口径（ub 结构等价 characterization）。
 * extensionFor 是模块私有函数，通过「无原名的 image 落盘文件名后缀」间接钉住：
 * 拆分后每一支的返回值必须逐字不变。
 */
describe('extensionFor 魔数 / MIME 口径（ub characterization）', () => {
  /** 每次清空默认落盘目录，保证 savedFiles()[0] 就是本次用例的唯一产物。 */
  async function extOf(
    opts: { mimeType?: string; bytes?: Buffer } = {},
  ): Promise<string | undefined> {
    fs.rmSync(path.join(tmpDir, '.lark-remote-temp'), { recursive: true, force: true });
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd('user-1', tmpDir);
    await bridge.saveInboundMedia(
      mediaPayload({
        media: [downloaded(opts.bytes ?? Buffer.alloc(12), { mimeType: opts.mimeType })],
      }),
    );
    const name = path.basename(savedFiles()[0]);
    const m = name.match(/\.([a-z0-9]+)$/);
    return m ? m[1] : undefined;
  }

  /** 12 字节头：先铺满，再把签名写到指定偏移。 */
  function withSignature(offset: number, sig: number[] | string): Buffer {
    const b = Buffer.alloc(12);
    if (typeof sig === 'string') b.write(sig, offset, 'latin1');
    else Buffer.from(sig).copy(b, offset);
    return b;
  }

  it('MIME → 扩展名映射逐字钉住', async () => {
    const cases: Array<[string, string]> = [
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/jpg', 'jpg'],
      ['image/gif', 'gif'],
      ['image/webp', 'webp'],
      ['image/bmp', 'bmp'],
      ['video/mp4', 'mp4'],
      ['video/quicktime', 'mov'],
      ['video/webm', 'webm'],
      ['video/x-matroska', 'mkv'],
      ['audio/opus', 'opus'],
      ['audio/ogg', 'ogg'],
      ['audio/mpeg', 'mp3'],
      ['audio/mp3', 'mp3'],
      ['audio/wav', 'wav'],
      ['audio/x-wav', 'wav'],
      ['audio/aac', 'aac'],
      ['audio/amr', 'amr'],
      ['audio/mp4', 'm4a'],
    ];
    for (const [mime, ext] of cases) {
      expect(await extOf({ mimeType: mime }), mime).toBe(ext);
    }
  });

  it('MIME 归一化：剥参数 / 转小写 / trim', async () => {
    expect(await extOf({ mimeType: 'IMAGE/PNG; charset=binary' })).toBe('png');
    expect(await extOf({ mimeType: '  image/webp  ' })).toBe('webp');
    expect(await extOf({ mimeType: 'audio/mpeg; codecs=mp3' })).toBe('mp3');
  });

  it('MIME 命中时优先于魔数', async () => {
    const png = withSignature(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await extOf({ mimeType: 'image/gif', bytes: png })).toBe('gif');
  });

  it('魔数签名逐字钉住（无 MIME）', async () => {
    const riffWebp = withSignature(0, 'RIFF');
    riffWebp.write('WEBP', 8, 'latin1');
    expect(await extOf({ bytes: riffWebp }), 'RIFF/WEBP').toBe('webp');

    const riffWave = withSignature(0, 'RIFF');
    riffWave.write('WAVE', 8, 'latin1');
    expect(await extOf({ bytes: riffWave }), 'RIFF/WAVE').toBe('wav');

    expect(
      await extOf({ bytes: withSignature(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
      'PNG',
    ).toBe('png');
    expect(await extOf({ bytes: withSignature(0, [0xff, 0xd8, 0xff]) }), 'JPEG').toBe('jpg');
    expect(await extOf({ bytes: withSignature(0, 'GIF8') }), 'GIF8').toBe('gif');
    expect(await extOf({ bytes: withSignature(0, 'OggS') }), 'OggS').toBe('opus');
    expect(await extOf({ bytes: withSignature(4, 'ftyp') }), 'ftyp').toBe('mp4');
    expect(await extOf({ bytes: withSignature(0, 'BM') }), 'BM').toBe('bmp');
    expect(await extOf({ bytes: withSignature(0, 'ID3') }), 'ID3').toBe('mp3');
    expect(await extOf({ bytes: withSignature(0, [0xff, 0xfb]) }), 'frame sync').toBe('mp3');
    expect(await extOf({ bytes: withSignature(0, '#!AMR') }), '#!AMR').toBe('amr');
    expect(await extOf({ bytes: withSignature(0, [0x1a, 0x45, 0xdf, 0xa3]) }), 'EBML').toBe('mkv');
  });

  it('无法识别（未知 MIME / 空魔数）→ 省略扩展名', async () => {
    expect(await extOf({ mimeType: 'application/octet-stream' })).toBeUndefined();
    expect(await extOf({ bytes: Buffer.alloc(12) })).toBeUndefined();
  });

  it('头部不足签名所需长度时不误判', async () => {
    expect(await extOf({ bytes: Buffer.from('GIF') })).toBeUndefined();
  });
});
