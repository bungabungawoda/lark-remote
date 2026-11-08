import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import axios from 'axios';
import { FeishuConnector } from './index.js';
import { AppConfigSchema, type AppConfig } from '../config/index.js';

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

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const config: AppConfig = AppConfigSchema.parse({
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    effort: 'medium',
    permissionMode: 'auto',
    approvalTimeoutMs: 300000,
    idleTtlMinutes: 30,
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  logging: { level: 'info' },
  defaultAgent: 'claude',
});

const FILES_URL = 'https://open.feishu.cn/open-apis/im/v1/files';
const IMAGES_URL = 'https://open.feishu.cn/open-apis/im/v1/images';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

const tokenOk = (tok: string) => ({ data: { code: 0, tenant_access_token: tok, expire: 7200 } });
const sendOk = (id: string) => ({ data: { code: 0, data: { message_id: id } } });

/** fetch 的响应外壳：只实现本模块用到的 ok/status/json。 */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let tmpDir: string;
let filePath: string;

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-send-file-'));
  filePath = path.join(tmpDir, 'hello.txt');
  fs.writeFileSync(filePath, 'hello');
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FeishuConnector.sendFile', () => {
  it('上传走 fetch multipart：文件字节、文件名与 stream 类型都到位', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('token'))
      .mockResolvedValueOnce(sendOk('m'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, data: { file_key: 'file-key' } }));

    await new FeishuConnector(config).sendFile('chat-1', filePath);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FILES_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    // 不手动设 Content-Type：boundary 必须由 fetch 生成。
    expect(init.headers).not.toHaveProperty('Content-Type');

    const body = init.body as FormData;
    expect(body.get('file_type')).toBe('stream');
    expect(body.get('file_name')).toBe('hello.txt');
    const uploaded = body.get('file') as File;
    expect(uploaded.name).toBe('hello.txt');
    expect(await uploaded.text()).toBe('hello');
    // 上传不再走 axios（multipart 流在 Bun 的代理隧道上会被截断）。
    expect(axios.post).not.toHaveBeenCalledWith(FILES_URL, expect.anything(), expect.anything());
  });

  it('sends the uploaded file message to a chat_id receiver', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('token'))
      .mockResolvedValueOnce(sendOk('message-id'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, data: { file_key: 'file-key' } }));

    await new FeishuConnector(config).sendFile('chat-1', filePath);

    expect(axios.post).toHaveBeenNthCalledWith(
      2,
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
        timeout: 30000,
      }),
    );
  });
});

describe('FeishuConnector.sendImage', () => {
  it('uploads images with the message image type', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('token'))
      .mockResolvedValueOnce(sendOk('m'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, data: { image_key: 'image-key' } }));

    const imagePath = path.join(tmpDir, 'qr.gif');
    fs.writeFileSync(imagePath, 'gif-bytes');

    await new FeishuConnector(config).sendImage('chat-1', imagePath);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(IMAGES_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    const body = init.body as FormData;
    expect(body.get('image_type')).toBe('message');
    expect(await (body.get('image') as File).text()).toBe('gif-bytes');
  });

  it('sends the uploaded image message to a chat_id receiver', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('token'))
      .mockResolvedValueOnce(sendOk('message-id'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, data: { image_key: 'image-key' } }));

    const imagePath = path.join(tmpDir, 'qr.gif');
    fs.writeFileSync(imagePath, 'gif-bytes');

    await new FeishuConnector(config).sendImage('chat-1', imagePath);

    expect(axios.post).toHaveBeenNthCalledWith(
      2,
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
    expect(fetchMock).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});

/**
 * tenant_access_token 缓存只按到期时间失效，鉴权失败不清
 * 缓存、并发请求也不合流。
 *
 * ① appSecret 在飞书后台被重置后，缓存里的旧 token 立刻失效，但缓存要到自然
 *   过期（~2h）才刷新——这期间 sendFile/sendImage 持续失败，用户看到的是
 *   "发文件一直报错"，且只能重启进程才能恢复。
 * ② 缓存过期的一瞬间，N 个并发发送会各发一次取 token 请求（飞书侧有限流）。
 */
describe('FeishuConnector tenant token 失效与合流', () => {
  it('上传被判 token 无效：清缓存重取，并用新 token 重做一次', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('stale'))
      .mockResolvedValueOnce(tokenOk('fresh'))
      .mockResolvedValueOnce(sendOk('message-id'));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 99991663, msg: 'tenant access token invalid' },
          { ok: false, status: 400 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { file_key: 'file-key' } }));

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).resolves.toBe(
      'message-id',
    );

    // 取 token 两次（第 2 次必须是清缓存后重取，不是复用旧值），上传用新 token。
    expect(vi.mocked(axios.post).mock.calls.map((c) => c[0])).toEqual([
      TOKEN_URL,
      TOKEN_URL,
      'https://open.feishu.cn/open-apis/im/v1/messages',
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fresh',
    });
  });

  it('只重试一次：第二次仍被判无效就如实报错，不留无限循环', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('stale'))
      .mockResolvedValueOnce(tokenOk('again'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 99991663, msg: 'tenant access token invalid' }))
      .mockResolvedValueOnce(jsonResponse({ code: 99991663, msg: 'tenant access token invalid' }));

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).rejects.toThrow(
      /sendFile failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(axios.post).mock.calls.filter((c) => c[0] === TOKEN_URL)).toHaveLength(2);
  });

  it('非鉴权类业务错误不清缓存、不重试（错误文案不变）', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce(tokenOk('token'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 230001, msg: 'invalid file format' }));

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).rejects.toThrow(
      /Upload failed: invalid file format/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.post).mock.calls).toHaveLength(1);
  });

  it('HTTP 401 与业务码 99991663 同口径：清缓存重取后重做一次', async () => {
    // token 被拒有两种外壳：飞书返回业务码，或整跳被网关拦成 HTTP 401。
    // 只认前者的话，401 会一直用坏 token 撞到自然过期（~2h）才恢复。
    vi.mocked(axios.post)
      .mockResolvedValueOnce(tokenOk('stale'))
      .mockResolvedValueOnce(tokenOk('fresh'))
      .mockResolvedValueOnce(sendOk('message-id'));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ msg: 'Unauthorized' }, { ok: false, status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { file_key: 'file-key' } }));

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).resolves.toBe(
      'message-id',
    );

    expect(vi.mocked(axios.post).mock.calls.map((c) => c[0])).toEqual([
      TOKEN_URL,
      TOKEN_URL,
      'https://open.feishu.cn/open-apis/im/v1/messages',
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fresh',
    });
  });

  it('其它 HTTP 状态不算 token 失效，不清缓存重取', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce(tokenOk('token'));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 502 }));

    await expect(new FeishuConnector(config).sendFile('chat-1', filePath)).rejects.toThrow(
      /sendFile failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.post).mock.calls).toHaveLength(1);
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
      return sendOk('message-id') as never;
    });
    fetchMock.mockResolvedValue(jsonResponse({ code: 0, data: { file_key: 'file-key' } }));

    const connector = new FeishuConnector(config);
    const results = await Promise.all([
      connector.sendFile('chat-1', filePath),
      connector.sendFile('chat-1', filePath),
      connector.sendFile('chat-1', filePath),
    ]);

    expect(results).toEqual(['message-id', 'message-id', 'message-id']);
    expect(tokenFetches).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
