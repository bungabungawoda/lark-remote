import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import axios from 'axios';
import FormData from 'form-data';
import { FeishuConnector } from './index.js';
import type { AppConfig } from '../config/index.js';

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    updateCard: vi.fn(),
  }),
}));

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock('form-data', () => {
  const FormDataMock = vi.fn(function (this: {
    append: ReturnType<typeof vi.fn>;
    getHeaders: ReturnType<typeof vi.fn>;
  }) {
    this.append = vi.fn();
    this.getHeaders = vi.fn(() => ({ 'content-type': 'multipart/form-data' }));
  });
  return { default: FormDataMock };
});

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const config: AppConfig = {
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    effort: 'medium',
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  logging: { level: 'info' },
  defaultAgent: 'claude',
};

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
  vi.mocked(FormData).mockClear();
  vi.spyOn(fs, 'createReadStream').mockReturnValue('file-stream' as never);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-send-file-'));
  filePath = path.join(tmpDir, 'hello.txt');
  fs.writeFileSync(filePath, 'hello');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FeishuConnector.sendFile', () => {
  it('uploads ordinary files with Feishu stream file type', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 'token', expire: 7200 } })
      .mockResolvedValueOnce({ data: { code: 0, data: { file_key: 'file-key' } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { message_id: 'message-id' } } });

    await new FeishuConnector(config).sendFile('chat-1', filePath);

    const uploadForm = vi.mocked(FormData).mock.results[0].value as {
      append: ReturnType<typeof vi.fn>;
    };
    expect(uploadForm.append).toHaveBeenCalledWith('file_type', 'stream');
  });

  it('sends the uploaded file message to a chat_id receiver', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 'token', expire: 7200 } })
      .mockResolvedValueOnce({ data: { code: 0, data: { file_key: 'file-key' } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { message_id: 'message-id' } } });

    await new FeishuConnector(config).sendFile('chat-1', filePath);

    expect(axios.post).toHaveBeenNthCalledWith(
      3,
      'https://open.feishu.cn/open-apis/im/v1/messages',
      {
        receive_id: 'chat-1',
        msg_type: 'file',
        content: JSON.stringify({ file_key: 'file-key' }),
      },
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer token',
        },
        params: { receive_id_type: 'chat_id' },
        // P2-18: send-message segment now carries a 30s timeout.
        timeout: 30000,
        // Bun keep-alive stale-socket fix: dedicated Agent with keepAlive=false
        httpsAgent: expect.objectContaining({ keepAlive: false }),
      }),
    );
  });
});

describe('FeishuConnector.sendImage', () => {
  it('uploads images with the message image type', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 'token', expire: 7200 } })
      .mockResolvedValueOnce({ data: { code: 0, data: { image_key: 'image-key' } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { message_id: 'message-id' } } });

    const imagePath = path.join(tmpDir, 'qr.gif');
    fs.writeFileSync(imagePath, 'gif-bytes');

    await new FeishuConnector(config).sendImage('chat-1', imagePath);

    // 上传端点与 form 字段：im/v1/images + image_type=message
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'https://open.feishu.cn/open-apis/im/v1/images',
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
        timeout: 120000,
        httpsAgent: expect.objectContaining({ keepAlive: false }),
      }),
    );
    const uploadForm = vi.mocked(FormData).mock.results[0].value as {
      append: ReturnType<typeof vi.fn>;
    };
    expect(uploadForm.append).toHaveBeenCalledWith('image_type', 'message');
    expect(uploadForm.append).toHaveBeenCalledWith('image', 'file-stream');
  });

  it('sends the uploaded image message to a chat_id receiver', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 'token', expire: 7200 } })
      .mockResolvedValueOnce({ data: { code: 0, data: { image_key: 'image-key' } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { message_id: 'message-id' } } });

    const imagePath = path.join(tmpDir, 'qr.gif');
    fs.writeFileSync(imagePath, 'gif-bytes');

    await new FeishuConnector(config).sendImage('chat-1', imagePath);

    expect(axios.post).toHaveBeenNthCalledWith(
      3,
      'https://open.feishu.cn/open-apis/im/v1/messages',
      {
        receive_id: 'chat-1',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'image-key' }),
      },
      expect.objectContaining({
        params: { receive_id_type: 'chat_id' },
        timeout: 30000,
      }),
    );
  });

  it('rejects missing image files before any network call', async () => {
    await expect(
      new FeishuConnector(config).sendImage('chat-1', path.join(tmpDir, 'no.gif')),
    ).rejects.toThrow('file not found');
    expect(axios.post).not.toHaveBeenCalled();
  });
});

const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const tokenOk = (tok: string) => ({ data: { code: 0, tenant_access_token: tok, expire: 7200 } });
const uploadOk = (key: string) => ({ data: { code: 0, data: { file_key: key } } });
const sendOk = (id: string) => ({ data: { code: 0, data: { message_id: id } } });
/** 第 N 次 axios.post 的 Authorization 头。上传是 form 请求，options 在第 3 个参数位。 */
function authHeaderAt(callIndex: number): string | undefined {
  const call = vi.mocked(axios.post).mock.calls[callIndex] as unknown[] | undefined;
  const [a, b] = (call ?? []).slice(2);
  const hasHeaders = (v: unknown): v is { headers: Record<string, string> } =>
    typeof v === 'object' && v !== null && 'headers' in v;
  const opts = hasHeaders(a) ? a : hasHeaders(b) ? b : undefined;
  return opts?.headers.Authorization;
}

/**
 * clean_review §B13：tenant_access_token 缓存只按到期时间失效，鉴权失败不清
 * 缓存、并发请求也不合流。
 *
 * ① appSecret 在飞书后台被重置后，缓存里的旧 token 立刻失效，但缓存要到自然
 *   过期（~2h）才刷新——这期间 sendFile/sendImage 持续失败，用户看到的是
 *   "发文件一直报错"，且只能重启进程才能恢复。
 * ② 缓存过期的一瞬间，N 个并发发送会各发一次取 token 请求（飞书侧有限流）。
 */
describe('FeishuConnector tenant token 失效与合流（B13）', () => {
  it('上传被判 token 无效：清缓存重取，并用新 token 重做一次', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('stale'))
      .mockResolvedValueOnce({ data: { code: 99991663, msg: 'tenant access token invalid' } })
      .mockResolvedValueOnce(tokenOk('fresh'))
      .mockResolvedValueOnce(uploadOk('file-key'))
      .mockResolvedValueOnce(sendOk('message-id'));

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).resolves.toBe(
      'message-id',
    );

    // 取 token 两次（第 2 次必须是清缓存后重取，不是复用旧值）
    const calls = vi.mocked(axios.post).mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls[2]?.[0]).toBe(TOKEN_URL);
    expect(authHeaderAt(3)).toBe('Bearer fresh');
    expect(authHeaderAt(4)).toBe('Bearer fresh');
  });

  it('只重试一次：第二次仍被判无效就如实报错，不留无限循环', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('stale'))
      .mockResolvedValueOnce({ data: { code: 99991663, msg: 'tenant access token invalid' } })
      .mockResolvedValueOnce(tokenOk('stale-again'))
      .mockResolvedValueOnce({ data: { code: 99991663, msg: 'tenant access token invalid' } });

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).rejects.toThrow(
      /sendFile failed/,
    );
    expect(vi.mocked(axios.post).mock.calls).toHaveLength(4);
  });

  it('非鉴权类业务错误不清缓存、不重试（错误文案不变）', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('token'))
      .mockResolvedValueOnce({ data: { code: 230001, msg: 'invalid file format' } });

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).rejects.toThrow(
      /Upload failed: invalid file format/,
    );
    expect(vi.mocked(axios.post).mock.calls).toHaveLength(2);
  });

  it('并发发送只取一次 token（in-flight 合流）', async () => {
    let tokenFetches = 0;
    const gate = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));
    vi.mocked(axios.post).mockImplementation(async (url: unknown) => {
      if (url === TOKEN_URL) {
        tokenFetches += 1;
        await gate(20);
        return tokenOk('shared') as never;
      }
      if (url === 'https://open.feishu.cn/open-apis/im/v1/files') {
        return uploadOk('file-key') as never;
      }
      return sendOk('message-id') as never;
    });

    const connector = new FeishuConnector(config);
    const results = await Promise.all([
      connector.sendFile('chat-1', filePath),
      connector.sendFile('chat-1', filePath),
      connector.sendFile('chat-1', filePath),
    ]);

    expect(results).toEqual(['message-id', 'message-id', 'message-id']);
    expect(tokenFetches).toBe(1);
  });
});
