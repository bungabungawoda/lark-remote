import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuConnector } from './index.js';
import type { AppConfig } from '../config/index.js';

/**
 * Mutable stub for rawClient.im.v1.message.patch.
 * The observability probe wraps patch in FeishuConnector constructor,
 * so we must provide a controllable stub on the fake channel.
 *
 * Implicit contract: patchStub is set in beforeEach(). The nullish-coalescing
 * fallback prevents "patchStub is not a function" if a test is added without
 * a proper beforeEach reset.
 */
let patchStub: ReturnType<typeof vi.fn>;

vi.mock('@larksuite/channel', () => ({
  createLarkChannel: () => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(),
    stream: vi.fn(),
    updateCard: vi.fn(),
    addReaction: vi.fn(),
    rawClient: {
      im: {
        v1: {
          message: {
            // Must be a writable property so FeishuConnector can reassign patch
            // with the observability wrapper. The closure reads patchStub at call
            // time so beforeEach controls the stub per test.
            patch: (...args: unknown[]) => (patchStub ??= vi.fn())(...args),
          },
        },
      },
    },
  }),
}));

let warnFn: ReturnType<typeof vi.fn>;

vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => warnFn(...args),
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
  defaultAgent: 'claude',
  output: { showThinking: true, showToolUse: false, showToolResult: false },
  logging: { level: 'info' },
};

function getWrappedPatch(connector: FeishuConnector) {
  return connector.channel.rawClient.im.v1.message.patch;
}

describe('message.patch business-code observability', () => {
  beforeEach(() => {
    warnFn = vi.fn();
    patchStub = vi.fn();
  });

  it('should log warn when patch returns code!=0', async () => {
    patchStub.mockResolvedValue({ code: 11310, msg: 'too many tables' });

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    const result = await wrappedPatch({
      path: { message_id: 'om_test_msg_001' },
      data: { content: '{"schema":"2.0"}' },
    });

    // Return value is passed through unchanged
    expect(result).toEqual({ code: 11310, msg: 'too many tables' });

    // warn was called with the expected log format
    expect(warnFn).toHaveBeenCalledTimes(1);
    const logMsg = warnFn.mock.calls[0][0] as string;
    expect(logMsg).toContain('[feishu] message.patch business error');
    expect(logMsg).toContain('code=11310');
    expect(logMsg).toContain('msg=too many tables');
    expect(logMsg).toContain('messageId=om_test_msg_001');
  });

  it('should transparently pass through the return value without throwing', async () => {
    const responseBody = { code: 11310, msg: 'too many tables', data: {} };
    patchStub.mockResolvedValue(responseBody);

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    // Must not throw — observability only, no behavior change
    const result = await wrappedPatch({
      path: { message_id: 'om_test_msg_002' },
      data: { content: '{}' },
    });

    // Exact same object returned
    expect(result).toBe(responseBody);
  });

  it('should NOT log warn when patch returns code=0', async () => {
    patchStub.mockResolvedValue({ code: 0, msg: 'ok' });

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    await wrappedPatch({
      path: { message_id: 'om_test_msg_003' },
      data: { content: '{}' },
    });

    expect(warnFn).not.toHaveBeenCalled();
  });

  it('should NOT log warn when patch returns empty object (no code field)', async () => {
    patchStub.mockResolvedValue({});

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    await wrappedPatch({
      path: { message_id: 'om_test_msg_004' },
      data: { content: '{}' },
    });

    expect(warnFn).not.toHaveBeenCalled();
  });

  it('should let transport-layer errors propagate unchanged', async () => {
    const transportError = new Error('ECONNRESET');
    patchStub.mockRejectedValue(transportError);

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    // Observability must not swallow transport errors
    await expect(
      wrappedPatch({
        path: { message_id: 'om_test_msg_005' },
        data: { content: '{}' },
      }),
    ).rejects.toThrow('ECONNRESET');

    // No warn for transport errors — they are not business-code issues
    expect(warnFn).not.toHaveBeenCalled();
  });

  it('should include bytes= in log when data.content is a string', async () => {
    const content = '{"schema":"2.0","body":{}}';
    patchStub.mockResolvedValue({ code: 11310, msg: 'too many tables' });

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    await wrappedPatch({
      path: { message_id: 'om_test_msg_006' },
      data: { content },
    });

    expect(warnFn).toHaveBeenCalledTimes(1);
    const logMsg = warnFn.mock.calls[0][0] as string;
    // bytes should be the UTF-8 byte length of the content string
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(logMsg).toContain(`bytes=${expectedBytes}`);
  });

  it('should show bytes=unknown when data.content is absent', async () => {
    patchStub.mockResolvedValue({ code: 11310, msg: 'card error' });

    const connector = new FeishuConnector(config);
    const wrappedPatch = getWrappedPatch(connector);

    await wrappedPatch({
      path: { message_id: 'om_test_msg_007' },
      // No data.content
    });

    expect(warnFn).toHaveBeenCalledTimes(1);
    const logMsg = warnFn.mock.calls[0][0] as string;
    expect(logMsg).toContain('bytes=unknown');
  });
});
