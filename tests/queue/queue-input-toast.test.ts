import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanupQueueTestContext,
  makeQueueTestContext,
  setupTwoTaskQueueScenario,
  type QueueTestContext,
} from '../lib/queue-scenario.js';

vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

let ctx: QueueTestContext;

beforeEach(() => {
  ctx = makeQueueTestContext();
});

afterEach(() => {
  cleanupQueueTestContext(ctx);
});

describe('queue.input returns toast instead of sending message', () => {
  it('test_anchor_queue_input_returns_success_toast', async () => {
    // Bug: 编辑排队消息提交后，handleQueueInput 调 sendResult({ text: '✅ 消息已更新' })
    // 发了一条正文消息，冗余。应改为返回 CardActionResponse toast，由 SDK 作为飞书
    // 回调响应给点击用户即时反馈，不再发送正文。
    // 链路：connector cardAction listener return + index.ts return + router return toast。

    const { bridge, router, connector, tmpDir } = ctx;
    const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
      firstMessagePreview: 'task 1',
      secondMessagePreview: 'original',
    });

    const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // Submit edited content via queue.input
    const result = await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      cardCtx,
    );

    // Assert: returns a CardActionResponse with a success toast AND an
    // in-place card update (card.data) so Feishu renders the updated queue
    // card and closes the edit form. A toast-only response leaves the card
    // stuck in edit state (Feishu keeps the pre-click card when the callback
    // response has no `card` field).
    expect(result).toMatchObject({ toast: { type: 'success', content: '消息已更新' } });
    expect(result).toMatchObject({ card: { type: 'raw' } });
    expect((result as { card?: { data?: { schema?: string } } }).card?.data?.schema).toBe('2.0');

    // Assert: did NOT send a separate "✅ 消息已更新" text message
    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');
    expect(sentTexts).not.toContain('✅ 消息已更新');

    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
