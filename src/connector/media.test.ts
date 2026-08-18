import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { FeishuConnector, type InboundMediaMessage } from './index.js';
import { AppConfigSchema } from '../config/index.js';

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

vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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
  messageHandlers.clear();
});

describe('FeishuConnector inbound media 两阶段流程（先认证后下载）', () => {
  it('媒体消息到达只上报 detected（不下载），且不转发文本消息', async () => {
    const { detected, textMessages } = makeConnector();

    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-1',
      chatId: 'chat-1',
      content: '[图片]',
      rawContentType: 'image',
      resources: [imageResource],
      replyToMessageId: undefined,
    });

    await Promise.resolve();
    expect(detected).toHaveLength(1);
    expect(detected[0].userId).toBe('user-1');
    expect(detected[0].chatId).toBe('chat-1');
    expect(detected[0].messageId).toBe('msg-1');
    expect(detected[0].resources[0]).toMatchObject({ type: 'image', fileKey: 'file-key-1' });
    expect(detected[0].resources[0].fileName).toBeUndefined();
    // 认证之前绝不发生下载
    expect(downloadResourceToFile).not.toHaveBeenCalled();
    // 媒体消息不得进入普通文本消息路径（content 是占位文案）
    expect(textMessages).toHaveLength(0);
  });

  it('file 消息 detected 保留原始文件名与 file 类型', async () => {
    const { detected } = makeConnector();
    fireMessage({
      chatType: 'p2p',
      senderId: 'user-1',
      messageId: 'msg-2',
      chatId: 'chat-1',
      content: '[文件]',
      rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'file-key-2', fileName: 'report.pdf' }],
    });
    await Promise.resolve();
    expect(detected[0].resources).toEqual([
      { type: 'file', fileKey: 'file-key-2', fileName: 'report.pdf' },
    ]);
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
      resources: [{ type: 'file', fileKey: 'file-key-3', fileName: 'a.txt' }],
    });

    expect(downloadResourceToFile).toHaveBeenCalledWith(
      'msg-3',
      'file-key-3',
      'file',
      expect.any(String),
    );
    expect(payload.media).toHaveLength(1);
    const item = payload.media[0];
    expect(item).toMatchObject({ type: 'file', fileName: 'a.txt', mimeType: 'text/plain' });
    expect(item.tempPath).toBe(writtenTo);
    expect(fs.existsSync(item.tempPath)).toBe(true);
    expect(fs.readFileSync(item.tempPath, 'utf-8')).toBe('hello');
    expect(payload.failures).toEqual([]);
  });

  it('超过大小限制的资源不进入 media，临时文件被清理', async () => {
    const { connector } = makeConnector();
    let writtenTo: string | undefined;
    downloadResourceToFile.mockImplementation(
      async (_m: string, _k: string, _t: string, destPath: string) => {
        writtenTo = destPath;
        fs.writeFileSync(
          destPath,
          Buffer.alloc((config.inboundMedia.maxFileSizeMb + 1) * 1024 * 1024),
        );
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
      resources: [{ type: 'file', fileKey: 'file-key-4', fileName: 'big.pdf' }],
    });

    expect(payload.media).toHaveLength(0);
    expect(payload.failures).toEqual([
      { fileName: 'big.pdf', reason: expect.stringContaining('大小限制') },
    ]);
    expect(fs.existsSync(writtenTo!)).toBe(false);
  });

  it('maxFileSizeMb 由调用方传入（live config），覆盖默认上限', async () => {
    const { connector } = makeConnector();
    let writtenTo: string | undefined;
    downloadResourceToFile.mockImplementation(
      async (_m: string, _k: string, _t: string, destPath: string) => {
        writtenTo = destPath;
        fs.writeFileSync(destPath, Buffer.alloc(1024 * 1024 + 1));
        return { contentType: 'application/pdf', bytesWritten: 1024 * 1024 + 1 };
      },
    );

    const payload = await connector.downloadInboundMedia(
      {
        userId: 'user-1',
        chatId: 'chat-1',
        messageId: 'msg-4b',
        resources: [{ type: 'file', fileKey: 'file-key-4b', fileName: 'one-mb.pdf' }],
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
          resources: [{ type: 'file', fileKey: 'file-key-4c', fileName: 'slow.pdf' }],
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
      resources: [
        { type: 'image', fileKey: 'file-key-bad' },
        { type: 'image', fileKey: 'file-key-good' },
      ],
    });

    expect(payload.media).toHaveLength(1);
    expect(payload.failures).toEqual([{ fileName: undefined, reason: '下载失败: network down' }]);
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
