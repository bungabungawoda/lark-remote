import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeishuConnector } from './index.js';
import type { AppConfig } from '../config/index.js';

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
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
    binary: 'claude',
    model: 'claude-opus-4-8',
    effort: 'medium',
    stopGraceMs: 5000,
  },
  idle: { watchdogMinutes: 15 },
  defaultAgent: 'claude',
  output: { showThinking: true, showToolUse: false, showToolResult: false },
  logging: { level: 'info' },
};

describe('FeishuConnector.sendWithRetry', () => {
  let connector: FeishuConnector;
  let mockChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new FeishuConnector(config);
    mockChannel = (connector as unknown as { channel: { send: ReturnType<typeof vi.fn> } }).channel
      .send as ReturnType<typeof vi.fn>;
  });

  it('should succeed on first attempt', async () => {
    mockChannel.mockResolvedValueOnce({ messageId: 'msg-123' });

    const result = await connector.sendWithRetry('chat-1', { text: 'hello' });

    expect(result).toBe('msg-123');
    expect(mockChannel).toHaveBeenCalledTimes(1);
  });

  it('should retry once on rate limit error', async () => {
    mockChannel
      .mockRejectedValueOnce({ code: 'rate_limited', message: 'rate limited' })
      .mockResolvedValueOnce({ messageId: 'msg-456' });

    const result = await connector.sendWithRetry('chat-1', { text: 'hello' });

    expect(result).toBe('msg-456');
    expect(mockChannel).toHaveBeenCalledTimes(2);
  });

  it('should throw after retry fails on rate limit', async () => {
    mockChannel
      .mockRejectedValueOnce({ code: 'rate_limited', message: 'rate limited' })
      .mockRejectedValueOnce({ code: 'rate_limited', message: 'rate limited' });

    await expect(connector.sendWithRetry('chat-1', { text: 'hello' })).rejects.toEqual({
      code: 'rate_limited',
      message: 'rate limited',
    });
    expect(mockChannel).toHaveBeenCalledTimes(2);
  });

  it('should throw immediately on non-rate-limit errors', async () => {
    mockChannel.mockRejectedValueOnce({ code: 'internal_error', message: 'internal error' });

    await expect(connector.sendWithRetry('chat-1', { text: 'hello' })).rejects.toEqual({
      code: 'internal_error',
      message: 'internal error',
    });
    expect(mockChannel).toHaveBeenCalledTimes(1);
  });

  it('should handle 502 Bad Gateway and throw gracefully', async () => {
    const axiosError = new Error('Request failed with status code 502');
    Object.assign(axiosError, {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      response: { status: 502 },
    });
    mockChannel.mockRejectedValueOnce(axiosError);

    // Should throw, not crash
    await expect(connector.sendWithRetry('chat-1', { text: 'hello' })).rejects.toBeDefined();
    expect(mockChannel).toHaveBeenCalledTimes(1);
  });

  it('should handle network errors gracefully', async () => {
    const networkError = new Error('ECONNREFUSED');
    Object.assign(networkError, { code: 'ECONNREFUSED' });
    mockChannel.mockRejectedValueOnce(networkError);

    await expect(connector.sendWithRetry('chat-1', { text: 'hello' })).rejects.toBeDefined();
    expect(mockChannel).toHaveBeenCalledTimes(1);
  });
});

describe('FeishuConnector.updateCard', () => {
  let connector: FeishuConnector;
  let mockChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new FeishuConnector(config);
    mockChannel = (connector as unknown as { channel: { updateCard: ReturnType<typeof vi.fn> } })
      .channel.updateCard as ReturnType<typeof vi.fn>;
  });

  it('should handle 502 error without crashing', async () => {
    const axiosError = new Error('Bad Gateway');
    Object.assign(axiosError, {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      response: { status: 502 },
    });
    mockChannel.mockRejectedValueOnce(axiosError);

    // Should not throw unhandled rejection, should be catchable
    await expect(connector.updateCard('msg-123', { config: {} })).rejects.toBeDefined();
  });

  it('should handle 503 error gracefully', async () => {
    const axiosError = new Error('Service Unavailable');
    Object.assign(axiosError, {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      response: { status: 503 },
    });
    mockChannel.mockRejectedValueOnce(axiosError);

    await expect(connector.updateCard('msg-123', { config: {} })).rejects.toBeDefined();
  });

  it('should handle timeout errors', async () => {
    const axiosError = new Error('timeout');
    Object.assign(axiosError, { code: 'ETIMEDOUT' });
    mockChannel.mockRejectedValueOnce(axiosError);

    await expect(connector.updateCard('msg-123', { config: {} })).rejects.toBeDefined();
  });

  it('should return successfully when updateCard succeeds', async () => {
    mockChannel.mockResolvedValueOnce(undefined);

    await expect(connector.updateCard('msg-123', { config: {} })).resolves.not.toThrow();
    expect(mockChannel).toHaveBeenCalledTimes(1);
  });
});

describe('FeishuConnector.streamCard', () => {
  let connector: FeishuConnector;
  let mockChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new FeishuConnector(config);
    mockChannel = (connector as unknown as { channel: { stream: ReturnType<typeof vi.fn> } })
      .channel.stream as ReturnType<typeof vi.fn>;
  });

  it('should return messageId on success', async () => {
    mockChannel.mockResolvedValueOnce({ messageId: 'msg-123' });

    const result = await connector.streamCard('chat-1', { config: {} }, async () => {});

    expect(result).toBe('msg-123');
    expect(mockChannel).toHaveBeenCalledTimes(1);
  });

  it('should throw formatted error on 502', async () => {
    const axiosError = new Error('Bad Gateway');
    Object.assign(axiosError, {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      response: { status: 502 },
    });
    mockChannel.mockRejectedValueOnce(axiosError);

    await expect(connector.streamCard('chat-1', { config: {} }, async () => {})).rejects.toThrow(
      /streamCard failed/,
    );
  });

  it('should throw formatted error on network error', async () => {
    const networkError = new Error('ECONNRESET');
    Object.assign(networkError, { code: 'ECONNRESET' });
    mockChannel.mockRejectedValueOnce(networkError);

    await expect(connector.streamCard('chat-1', { config: {} }, async () => {})).rejects.toThrow(
      /streamCard failed/,
    );
  });
});

describe('FeishuConnector.sendFile', () => {
  let axiosMock: ReturnType<typeof vi.fn>;
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    axiosMock = vi.mocked(axios.post);
    // Create a real temp file for the test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-test-'));
    filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should throw formatted error when token request fails', async () => {
    const networkError = new Error('Network Error');
    Object.assign(networkError, { code: 'ENOTFOUND' });
    axiosMock.mockRejectedValueOnce(networkError);

    const connector = new FeishuConnector(config);
    await expect(connector.sendFile('chat-1', filePath)).rejects.toThrow(/sendFile failed/);
  });

  it('should throw formatted error when upload fails', async () => {
    axiosMock
      .mockResolvedValueOnce({ data: { tenant_access_token: 'token' } })
      .mockRejectedValueOnce(new Error('upload failed'));

    const connector = new FeishuConnector(config);
    await expect(connector.sendFile('chat-1', filePath)).rejects.toThrow(/sendFile failed/);
  });

  it('should throw formatted error when message send fails', async () => {
    axiosMock
      .mockResolvedValueOnce({ data: { tenant_access_token: 'token' } })
      .mockResolvedValueOnce({ data: { code: 0, data: { file_key: 'key' } } })
      .mockRejectedValueOnce(new Error('message failed'));

    const connector = new FeishuConnector(config);
    await expect(connector.sendFile('chat-1', filePath)).rejects.toThrow(/sendFile failed/);
  });
});

describe('FeishuConnector.disconnect', () => {
  let connector: FeishuConnector;
  let mockChannel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new FeishuConnector(config);
    mockChannel = (connector as unknown as { channel: { disconnect: ReturnType<typeof vi.fn> } })
      .channel.disconnect as ReturnType<typeof vi.fn>;
  });

  it('should handle disconnect error gracefully', async () => {
    mockChannel.mockRejectedValueOnce(new Error('WebSocket error'));

    // Should not throw unhandled rejection - error is logged but not propagated
    await expect(connector.disconnect()).resolves.not.toThrow();
  });
});

describe('FeishuConnector.reconnect', () => {
  let connector: FeishuConnector;
  let mockChannel: { disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    connector = new FeishuConnector(config);
    mockChannel = (
      connector as unknown as {
        channel: { disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };
      }
    ).channel;
  });

  it('should handle disconnect failure during reconnect gracefully', async () => {
    mockChannel.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    mockChannel.connect.mockResolvedValueOnce(undefined);

    // Should not throw unhandled rejection
    await expect(connector.reconnect()).resolves.not.toThrow();
  });

  it('should propagate connect failure during reconnect', async () => {
    mockChannel.disconnect.mockResolvedValueOnce(undefined);
    mockChannel.connect.mockRejectedValueOnce(new Error('connect failed'));

    // reconnect should throw but not crash
    await expect(connector.reconnect()).rejects.toThrow();
  });
});
