import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { FeishuConnector, type InboundMediaMessage } from './index.js';
import { AppConfigSchema } from '../config/index.js';
import { mockLogger } from '../../tests/lib/logger-mock.js';
import { writeSizedFile } from '../../tests/lib/sized-file.js';

const { messageHandlers, downloadResourceToFile } = vi.hoisted(() => ({
  messageHandlers: new Map<string, (msg: unknown) => void>(),
  downloadResourceToFile: vi.fn(),
}));

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: (event: string, handler: unknown) => {
      if (event === 'message') {
        messageHandlers.set('message', handler as (msg: unknown) => void);
      }
      return vi.fn();
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    updateCard: vi.fn(),
    downloadResourceToFile,
  }),
}));

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const config = AppConfigSchema.parse({
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: { model: 'opus', effort: 'medium', stopGraceMs: 5000 },
});

function fireMessage(msg: Record<string, unknown>): void {
  messageHandlers.get('message')?.(msg);
}

function makeConnector(): {
  connector: FeishuConnector;
  detected: InboundMediaMessage[];
  textMessages: unknown[];
} {
  const connector = new FeishuConnector(config);
  const detected: InboundMediaMessage[] = [];
  const textMessages: unknown[] = [];
  connector.setInboundMediaDetectedHandler((msg) => {
    detected.push(msg);
  });
  connector.setMessageHandler((msg) => textMessages.push(msg));
  return { connector, detected, textMessages };
}

const imageResource = { type: 'image', fileKey: 'file-key-1' };

beforeEach(() => {
  downloadResourceToFile.mockReset();
  mockLogger.warn.mockClear();
  messageHandlers.clear();
});

describe('FeishuConnector inbound media 两阶段流程（先认证后下载）', () => {
  it('图片消息到达只上报 detected（不下载），且不转发文本事件', async () => {
    const { detected, textMessages } = makeConnector();

    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-1',
      chatId: 'chat-1',
      content: '![image](img_v3_1)',
      rawContentType: 'image',
      resources: [imageResource],
      replyToMessageId: undefined,
    });

    await Promise.resolve();
    expect(detected).toHaveLength(1);
    expect(detected[0].userId).toBe('user-1');
    expect(detected[0].chatId).toBe('chat-1');
    expect(detected[0].messageId).toBe('msg-1');
    expect(detected[0].rawContentType).toBe('image');
    expect(detected[0].resources[0]).toMatchObject({ type: 'image', fileKey: 'file-key-1' });
    expect(detected[0].resources[0].fileName).toBeUndefined();
    // 认证之前绝不发生下载
    expect(downloadResourceToFile).not.toHaveBeenCalled();
    // 纯图片消息的 content 只有占位符 → 不产生文本事件
    expect(textMessages).toHaveLength(0);
  });

  it('file 消息 detected 保留原始文件名、下载 type 与资源 kind', async () => {
    const { detected } = makeConnector();
    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-2',
      chatId: 'chat-1',
      content: '<file key="file-key-2" name="report.pdf"/>',
      rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'file-key-2', fileName: 'report.pdf' }],
    });
    await Promise.resolve();
    expect(detected[0].resources).toEqual([
      { type: 'file', kind: 'file', fileKey: 'file-key-2', fileName: 'report.pdf' },
    ]);
  });

  it('media/audio/sticker 也进入媒体通道（不再按 msg_type 白名单漏判）', async () => {
    const { detected, textMessages } = makeConnector();
    const cases: Array<{ type: string; content: string; kind: string }> = [
      {
        type: 'media',
        content: '<video key="file-key-v" name="a.mp4" duration="80.9s"/>',
        kind: 'video',
      },
      { type: 'audio', content: '<audio key="file-key-a" duration="3s"/>', kind: 'audio' },
      { type: 'sticker', content: '<sticker key="file-key-s"/>', kind: 'sticker' },
    ];
    for (const c of cases) {
      fireMessage({
        chatType: 'p2p',
        senderId: 'user-1',
        messageId: `msg-${c.kind}`,
        chatId: 'chat-1',
        content: c.content,
        rawContentType: c.type,
        resources: [{ type: c.kind, fileKey: `file-key-${c.kind}` }],
      });
    }
    await Promise.resolve();

    expect(detected.map((m) => m.rawContentType)).toEqual(['media', 'audio', 'sticker']);
    // 下载 type 只有 image/file 两个合法值（视频/语音/表情统一走 file）
    expect(detected.map((m) => m.resources[0].type)).toEqual(['file', 'file', 'file']);
    expect(detected.map((m) => m.resources[0].kind)).toEqual(['video', 'audio', 'sticker']);
    expect(textMessages).toHaveLength(0);
  });

  it('post（图 + 文）同时产出资源事件与文本事件（同一 messageId）', async () => {
    const { detected, textMessages } = makeConnector();
    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-post',
      chatId: 'chat-1',
      content: '**T**\n\n看这张图 ![image](img_v3_post)',
      rawContentType: 'post',
      resources: [{ type: 'image', fileKey: 'img_v3_post' }],
    });
    await Promise.resolve();

    expect(detected).toHaveLength(1);
    expect(textMessages).toHaveLength(1);
    expect((textMessages[0] as { messageId: string }).messageId).toBe('msg-post');
    expect((textMessages[0] as { rawContentType: string }).rawContentType).toBe('post');
  });

  it('post 富文本顶层附件（0.6.0+）→ file 资源进媒体通道，正文同时转发', async () => {
    const { detected, textMessages } = makeConnector();
    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-post-file',
      chatId: 'chat-1',
      content: '**报告**\n\n看一下附件\n<file key="file_v3_att" name="report.pdf"/>',
      rawContentType: 'post',
      resources: [{ type: 'file', fileKey: 'file_v3_att', fileName: 'report.pdf' }],
    });
    await Promise.resolve();

    expect(detected).toHaveLength(1);
    expect(detected[0].resources).toEqual([
      { type: 'file', kind: 'file', fileKey: 'file_v3_att', fileName: 'report.pdf' },
    ]);
    expect(textMessages).toHaveLength(1);
  });

  it('未识别类型但带资源 → 照常下载 + warn（default-deny 而非 default-text）', async () => {
    const { detected } = makeConnector();
    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-future',
      chatId: 'chat-1',
      content: '<newcard key="x"/>',
      rawContentType: 'brand_new_type',
      resources: [{ type: 'file', fileKey: 'file-key-future' }],
    });
    await Promise.resolve();

    expect(detected).toHaveLength(1);
    expect(downloadResourceToFile).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unrecognized msg_type="brand_new_type"'),
    );
  });

  it('downloadInboundMedia 流式写临时文件并返回 tempPath（不物化 Buffer）', async () => {
    const { connector } = makeConnector();
    let writtenTo: string | undefined;
    downloadResourceToFile.mockImplementation(
      async (_messageId: string, _fileKey: string, _type: string, destPath: string) => {
        writtenTo = destPath;
        fs.writeFileSync(destPath, 'hello');
        return { contentType: 'text/plain', bytesWritten: 5 };
      },
    );

    const payload = await connector.downloadInboundMedia({
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'msg-3',
      rawContentType: 'file',
      resources: [{ type: 'file', kind: 'file', fileKey: 'file-key-3', fileName: 'a.txt' }],
    });

    expect(downloadResourceToFile).toHaveBeenCalledWith(
      'msg-3',
      'file-key-3',
      'file',
      expect.any(String),
    );
    expect(payload.media).toHaveLength(1);
    const item = payload.media[0];
    expect(item).toMatchObject({
      type: 'file',
      kind: 'file',
      fileName: 'a.txt',
      mimeType: 'text/plain',
    });
    expect(item.tempPath).toBe(writtenTo);
    expect(fs.existsSync(item.tempPath)).toBe(true);
    expect(fs.readFileSync(item.tempPath, 'utf-8')).toBe('hello');
    expect(payload.failures).toEqual([]);
  });

  it('downloadInboundMedia 并行下载（限 3 路）且结果顺序不变', async () => {
    const { connector } = makeConnector();
    let inFlight = 0;
    let maxInFlight = 0;
    downloadResourceToFile.mockImplementation(
      async (_messageId: string, fileKey: string, _type: string, destPath: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // 异步让 worker 池真正叠起来（8 个资源 / 3 路 = 至少 3 轮并发）。
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        fs.writeFileSync(destPath, `content-${fileKey}`);
        return { contentType: 'application/octet-stream', bytesWritten: destPath.length };
      },
    );
    const resources = Array.from({ length: 8 }, (_, i) => ({
      type: 'file' as const,
      kind: 'file' as const,
      fileKey: `key-${i}`,
      fileName: `f-${i}.bin`,
    }));

    const payload = await connector.downloadInboundMedia({
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'msg-parallel',
      rawContentType: 'file',
      resources,
    });

    // 并发上限生效：8 个资源不会 8 路齐发。
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    // 全部成功且 media 顺序 = 资源顺序（摊平语义与串行版一致）。
    expect(payload.failures).toEqual([]);
    expect(payload.media.map((m) => m.fileName)).toEqual([
      'f-0.bin',
      'f-1.bin',
      'f-2.bin',
      'f-3.bin',
      'f-4.bin',
      'f-5.bin',
      'f-6.bin',
      'f-7.bin',
    ]);
  });

  it('downloadInboundMedia 并行下载时单个失败不影响其他资源', async () => {
    const { connector } = makeConnector();
    downloadResourceToFile.mockImplementation(
      async (_messageId: string, fileKey: string, _type: string, destPath: string) => {
        if (fileKey === 'key-2') throw new Error('boom');
        fs.writeFileSync(destPath, 'ok');
        return { contentType: 'text/plain', bytesWritten: 2 };
      },
    );
    const resources = Array.from({ length: 5 }, (_, i) => ({
      type: 'file' as const,
      kind: 'file' as const,
      fileKey: `key-${i}`,
      fileName: `f-${i}.txt`,
    }));

    const payload = await connector.downloadInboundMedia({
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'msg-partial-fail',
      rawContentType: 'file',
      resources,
    });

    expect(payload.media).toHaveLength(4);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0].fileName).toBe('f-2.txt');
    expect(payload.failures[0].reason).toContain('boom');
    // 成功的 media 保持资源相对顺序（key-2 缺席）。
    expect(payload.media.map((m) => m.fileName)).toEqual([
      'f-0.txt',
      'f-1.txt',
      'f-3.txt',
      'f-4.txt',
    ]);
  });

  it('超过大小限制的资源不进入 media，临时文件被清理', async () => {
    const { connector } = makeConnector();
    let writtenTo: string | undefined;
    downloadResourceToFile.mockImplementation(
      async (_m: string, _k: string, _t: string, destPath: string) => {
        writtenTo = destPath;
        // 门禁看的是 mock 自己返回的 bytesWritten，文件内容从不被读；这里保持
        // 落盘 size 与声称值一致（稀疏文件），万一门禁改成读 stat 行为不变。
        writeSizedFile(destPath, (config.inboundMedia.maxFileSizeMb + 1) * 1024 * 1024);
        return {
          contentType: 'application/pdf',
          bytesWritten: (config.inboundMedia.maxFileSizeMb + 1) * 1024 * 1024,
        };
      },
    );

    const payload = await connector.downloadInboundMedia({
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'msg-4',
      rawContentType: 'file',
      resources: [{ type: 'file', kind: 'file', fileKey: 'file-key-4', fileName: 'big.pdf' }],
    });

    expect(payload.media).toHaveLength(0);
    expect(payload.failures).toEqual([
      { kind: 'file', fileName: 'big.pdf', reason: expect.stringContaining('大小限制') },
    ]);
    expect(fs.existsSync(writtenTo!)).toBe(false);
  });

  it('maxFileSizeMb 由调用方传入（live config），覆盖默认上限', async () => {
    const { connector } = makeConnector();
    let writtenTo: string | undefined;
    downloadResourceToFile.mockImplementation(
      async (_m: string, _k: string, _t: string, destPath: string) => {
        writtenTo = destPath;
        writeSizedFile(destPath, 1024 * 1024 + 1);
        return { contentType: 'application/pdf', bytesWritten: 1024 * 1024 + 1 };
      },
    );

    const payload = await connector.downloadInboundMedia(
      {
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'msg-4b',
        rawContentType: 'file',
        resources: [{ type: 'file', kind: 'file', fileKey: 'file-key-4b', fileName: 'one-mb.pdf' }],
      },
      { maxFileSizeMb: 1 }, // 1MiB 上限，1MiB 文件超限
    );

    expect(payload.media).toHaveLength(0);
    expect(payload.failures[0].reason).toContain('超过 1MB 大小限制');
    expect(fs.existsSync(writtenTo!)).toBe(false);
  });

  it('下载超时进入 failures 并清理临时文件（SDK 无内置超时）', async () => {
    vi.useFakeTimers();
    try {
      const { connector } = makeConnector();
      downloadResourceToFile.mockImplementation(
        (_m: string, _k: string, _t: string, _destPath: string) => new Promise(() => {}),
      );

      const promise = connector.downloadInboundMedia(
        {
          userId: 'user-1',
          chatId: 'chat-1',
          messageId: 'msg-4c',
          rawContentType: 'file',
          resources: [{ type: 'file', kind: 'file', fileKey: 'file-key-4c', fileName: 'slow.pdf' }],
        },
        { downloadTimeoutMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(1001);
      const payload = await promise;

      expect(payload.media).toHaveLength(0);
      expect(payload.failures).toHaveLength(1);
      expect(payload.failures[0].reason).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('下载超时不提前删文件：等这次传输自己结束后补删（否则 os.tmpdir 留孤儿）', async () => {
    vi.useFakeTimers();
    try {
      const { connector } = makeConnector();
      const unlink = vi.spyOn(fs, 'unlinkSync');
      let writtenTo = '';
      let finish: (() => void) | undefined;
      downloadResourceToFile.mockImplementation(
        (_m: string, _k: string, _t: string, destPath: string) => {
          writtenTo = destPath;
          return new Promise((resolve) => {
            finish = () => {
              fs.writeFileSync(destPath, 'late-bytes');
              resolve({ contentType: 'application/pdf', bytesWritten: 10 });
            };
          });
        },
      );

      const promise = connector.downloadInboundMedia(
        {
          userId: 'user-1',
          chatId: 'chat-1',
          messageId: 'msg-4d',
          rawContentType: 'file',
          resources: [
            { type: 'file', kind: 'file', fileKey: 'file-key-4d', fileName: 'slow2.pdf' },
          ],
        },
        { downloadTimeoutMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(1001);
      const payload = await promise;

      expect(payload.failures[0].reason).toContain('timed out');
      // 超时当下不能 unlink：SDK 没有 abort 入参，这次传输还在往文件里写
      // （win32 会因句柄占用重试到放弃、posix 只删掉目录项把空间留给未关的 fd）。
      expect(unlink).not.toHaveBeenCalled();

      expect(finish).toBeDefined();
      finish?.(); // 传输迟到完成，文件真的落到 tmpdir
      await vi.advanceTimersByTimeAsync(0);
      expect(fs.existsSync(writtenTo)).toBe(false);

      unlink.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('下载失败进入 failures 并清理临时文件，不影响其他资源', async () => {
    const { connector } = makeConnector();
    const tempPaths: string[] = [];
    downloadResourceToFile
      .mockImplementationOnce(async (_m: string, _k: string, _t: string, _destPath: string) => {
        throw new Error('network down');
      })
      .mockImplementationOnce(async (_m: string, _k: string, _t: string, destPath: string) => {
        tempPaths.push(destPath);
        fs.writeFileSync(destPath, 'ok');
        return { contentType: 'image/png', bytesWritten: 2 };
      });

    const payload = await connector.downloadInboundMedia({
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'msg-5',
      rawContentType: 'image',
      resources: [
        { type: 'image', kind: 'image', fileKey: 'file-key-bad' },
        { type: 'image', kind: 'image', fileKey: 'file-key-good' },
      ],
    });

    expect(payload.media).toHaveLength(1);
    expect(payload.failures).toEqual([
      { kind: 'image', fileName: undefined, reason: '下载失败: network down' },
    ]);
    // 失败路径的临时文件被清理，成功路径的文件仍在（交给 bridge 移动）
    expect(fs.existsSync(payload.media[0].tempPath)).toBe(true);
  });

  it('普通文本消息不进入媒体路径', async () => {
    const { detected, textMessages } = makeConnector();
    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-6',
      chatId: 'chat-1',
      content: 'hello world',
      rawContentType: 'text',
      resources: [],
    });
    await Promise.resolve();
    expect(detected).toHaveLength(0);
    expect(textMessages).toHaveLength(1);
    expect(downloadResourceToFile).not.toHaveBeenCalled();
  });

  it('非 p2p 消息不处理', async () => {
    const { detected } = makeConnector();
    fireMessage({
      chatType: 'group',
      senderId: 'user-1',
      messageId: 'msg-7',
      chatId: 'chat-1',
      content: '[图片]',
      rawContentType: 'image',
      resources: [imageResource],
    });
    await Promise.resolve();
    expect(detected).toHaveLength(0);
    expect(downloadResourceToFile).not.toHaveBeenCalled();
  });
});
