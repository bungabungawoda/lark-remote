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

/**
 * 业务码拒绝必须传导回 await 的调用方（2026-08-11 run 卡定格事故的恢复链路）。
 *
 * 观测只解决了「日志里有」：`patchCard` 丢弃返回值 → `updateCard()` 正常 resolve
 * → `updateCardInPlace()` 用 try/catch 划成败，不抛就算成功 → 用户收到「已保存」
 * toast，卡片永远停在被打回的那一帧。
 */
describe('updateCard 业务码失败传导', () => {
  beforeEach(() => {
    warnFn = vi.fn();
    patchStub = vi.fn();
  });

  it('test_anchor_update_card_business_code_rejects', async () => {
    patchStub.mockResolvedValue({ code: 11310, msg: 'too many tables' });
    const connector = new FeishuConnector(config);

    await expect(connector.updateCard('om_test_010', { schema: '2.0' })).rejects.toThrow('11310');
  });

  it('业务码拒绝时不重试（确定性失败，重试只会同样被打回）', async () => {
    patchStub.mockResolvedValue({ code: 11310, msg: 'too many tables' });
    const connector = new FeishuConnector(config);

    await expect(connector.updateCard('om_test_011', { schema: '2.0' })).rejects.toThrow('11310');
    expect(patchStub).toHaveBeenCalledTimes(1);
  });

  it('code=0 正常返回，不抛不重发', async () => {
    patchStub.mockResolvedValue({ code: 0, msg: 'ok' });
    const connector = new FeishuConnector(config);
    const card = { schema: '2.0', body: { elements: [] } };

    await expect(connector.updateCard('om_test_012', card)).resolves.toBeUndefined();
    expect(patchStub).toHaveBeenCalledTimes(1);
    expect(patchStub.mock.calls[0][0]).toEqual({
      path: { message_id: 'om_test_012' },
      data: { content: JSON.stringify(card) },
    });
  });

  it('无 code 字段的响应按成功处理（SDK/mock 形状）', async () => {
    patchStub.mockResolvedValue({});
    const connector = new FeishuConnector(config);

    await expect(connector.updateCard('om_test_013', { schema: '2.0' })).resolves.toBeUndefined();
  });
});
