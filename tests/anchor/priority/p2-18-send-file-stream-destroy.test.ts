/**
 * Anchor Test: P2-18 sendFile 失败时必须销毁文件读取流
 *
 * 背景（review.md P2-18）：sendFile 三段 HTTP 全部无超时，上传失败路径里
 * fs.createReadStream(filePath) 从不 destroy——成功路径靠 axios 消费完自然
 * 关闭，但任何失败（token 拒绝、上传 code!=0、网络异常）都让流泄漏（fd 不
 * 释放，频繁发文件耗尽 fd）。每次发文件还重新获取 tenant_access_token 且
 * 不校验 data.code。
 *
 * 修复：流引用捕获，catch 里显式 destroy；三处 axios.post 加 timeout；
 * token 响应校验 data.code；token 简单缓存（有效期内复用）。
 *
 * 这个 anchor 让 token 请求成功但上传请求 reject，断言文件读取流在失败路径
 * 被显式 destroy。真红 = 当前实现 catch 里不碰流，流泄漏。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

const { mockAxios } = vi.hoisted(() => ({
  mockAxios: { post: vi.fn() },
}));
vi.mock('axios', () => ({ default: mockAxios }));

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    statSync: vi.fn(),
    createReadStream: vi.fn(),
  },
}));
vi.mock('node:fs', () => ({ default: mockFs }));

function MockFormData(this: any) {
  this.append = vi.fn();
  this.getHeaders = vi.fn(() => ({}));
}
vi.mock('form-data', () => ({ default: MockFormData }));

const { mockChannel } = vi.hoisted(() => ({
  mockChannel: {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    updateCard: vi.fn(),
    stream: vi.fn(),
    addReaction: vi.fn(),
  },
}));
vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => mockChannel,
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { FeishuConnector } from '../../../src/connector/index.js';

describe('P2-18: sendFile destroys the read stream on failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_send_file_destroys_stream_on_failure', async () => {
    // Token request succeeds.
    mockAxios.post.mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'tok-123' },
    });
    // Upload request fails (e.g. network/timeout) → rejects.
    mockAxios.post.mockRejectedValueOnce(new Error('upload timeout'));

    mockFs.statSync.mockReturnValue({ size: 100 });
    // Capture the read stream so we can assert it is destroyed.
    const stream = new Readable({ read() {} });
    stream.push('file-bytes');
    stream.push(null);
    const destroySpy = vi.spyOn(stream, 'destroy');
    mockFs.createReadStream.mockReturnValue(stream);

    const conn = new FeishuConnector({
      feishu: { appId: 'a', appSecret: 's' },
    } as any);

    await expect(conn.sendFile('chat-1', '/tmp/file.bin')).rejects.toThrow();

    // GREEN: the read stream must be explicitly destroyed on the failure path
    // so the fd is released. RED today: sendFile's catch never touches the
    // stream — destroy is never called, the fd leaks.
    expect(destroySpy).toHaveBeenCalled();
  });
});
