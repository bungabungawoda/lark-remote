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

vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const config: AppConfig = {
  feishu: { appId: 'app-id', appSecret: 'app-secret' },
  claude: {
    model: 'claude-opus-4-8',
    effort: 'medium',
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  output: { showThinking: true, showToolUse: false, showToolResult: false },
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
