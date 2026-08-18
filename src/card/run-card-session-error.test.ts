import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { RunCardSession } from './run-card-session.js';

// Mock controller that throws 500 on update
const mockController = {
  messageId: 'msg-123',
  current: {},
  update: vi.fn().mockRejectedValue(new Error('Request failed with status code 500')),
  ready: Promise.resolve(),
};

// Mock connector that throws 500 on updateCard
function createFailingConnector(): {
  streamCard: (
    chatId: string,
    initial: object,
    producer: (ctrl: CardStreamController) => Promise<void>,
  ) => Promise<string>;
  updateCard: (messageId: string, card: object) => Promise<void>;
} {
  return {
    streamCard: async (
      _chatId: string,
      _initial: object,
      producer: (ctrl: CardStreamController) => Promise<void>,
    ) => {
      await producer(mockController);
      return 'msg-123';
    },
    updateCard: vi.fn().mockRejectedValue(new Error('Request failed with status code 500')),
  };
}

describe('RunCardSession error handling', () => {
  let connector: ReturnType<typeof createFailingConnector>;
  let session: RunCardSession;

  beforeEach(() => {
    connector = createFailingConnector();
    session = new RunCardSession({
      connector,
      chatId: 'chat-1',
      replyTo: 'msg-1',
      runId: 'run-1',
      coalesceMs: 0, // 禁用 push 合批：本测试断言 push 后立即 flush 的错误处理契约
    });
  });

  it('should NOT crash process when updateCard throws 500 error', async () => {
    // Start a card session
    await session.start();

    // Push a thinking event (proper AgentEvent format)
    const event = {
      type: 'assistant' as const,
      message: {
        content: [
          { type: 'thinking' as const, thinking: 'I need to think about this problem carefully.' },
        ],
      },
      timestamp: new Date().toISOString(),
    };

    // This should NOT throw and crash the process
    // It should be caught and logged
    await expect(session.push(event)).resolves.toBeUndefined();

    // Verify updateCard was called (even though it failed)
    expect(connector.updateCard).toHaveBeenCalled();
  });

  it('should handle settle() when updateCard throws 500', async () => {
    await session.start();

    // Finish the run
    await session.finish('done', {});

    // settle() should handle the error gracefully
    const result = await session.settle();

    // streamCard 本身成功（messageId 存在），updateCard 500 只影响运行中的 patch
    // 与 fallback finalize，settle 按 stream 是否 clean 收敛 → streamed
    expect(result).toBe('streamed');
  });
});
