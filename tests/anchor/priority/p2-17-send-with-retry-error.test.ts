/**
 * Anchor Test: P2-17 sendWithRetry 重试失败必须抛出重试错误而非第一次错误
 *
 * 背景（review.md P2-17）：sendWithRetry 内层 catch 是 `catch { ...; throw err; }`，
 * 其中 `err` 是外层第一次失败捕获的错误。重试后若再次失败，抛出的仍是第一次
 * 的错误，掩盖了重试时的真实失败原因，误导诊断（如第一次是限流、重试是鉴权
 * 失效，但用户看到的是限流错误）。
 *
 * 修复：内层 `catch (retryErr) { ...; throw retryErr; }`。
 *
 * 这个 anchor 让 stub channel.send 第一次抛限流错误（可重试），第二次抛一个
 * 不同的鉴权错误（重试失败），断言最终 reject 的是重试错误。真红 = 当前实现
 * reject 第一次的限流错误。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const firstErr = Object.assign(new Error('first: rate limited 99991400'), {
  code: 'rate_limited',
});
const retryErr = Object.assign(new Error('retry: auth invalid 99991663'), {
  code: 'permission_denied',
  context: { feishuCode: 99991663 },
});

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

describe('P2-17: sendWithRetry throws the retry error, not the first error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_send_with_retry_throws_retry_error', async () => {
    // First send → rate-limited (retryable). Retry send → auth failure (different).
    mockChannel.send.mockRejectedValueOnce(firstErr).mockRejectedValueOnce(retryErr);

    const config = {
      feishu: { appId: 'a', appSecret: 's' },
    } as any;
    const conn = new FeishuConnector(config);

    let caught: unknown = null;
    try {
      await conn.sendWithRetry('chat-1', { text: 'hello' });
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    // GREEN: the retry error (auth invalid) is thrown, revealing the real
    // second-attempt failure. RED today: throws `firstErr` (rate limited),
    // hiding that the retry actually failed for a different reason.
    expect((caught as Error).message).toMatch(/retry: auth invalid|99991663/);
    expect((caught as Error).message).not.toMatch(/first: rate limited/);
  });
});
