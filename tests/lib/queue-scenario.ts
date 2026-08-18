import type { Bridge } from '../../src/bridge/index.js';
import type { createStubConnector } from './bridge-stubs.js';

export interface TwoTaskQueueScenario {
  /** 拦截到的 updateCard 调用（task 状态卡 PATCH）。 */
  updateCardCalls: Array<{ messageId: string; card: object }>;
  /** 初始排队卡（header orange + 标题含「排队」）。 */
  initialCards: Array<{ chatId: string; input: unknown; opts?: unknown }>;
  /** 释放 task1，让队列前进到 task2。 */
  release1: () => void;
  /** 恢复 connector.updateCard 原实现（测试收尾用）。 */
  restoreUpdateCard: () => void;
}

/**
 * 搭建「task1 挂起 + task2 排队」的双任务场景，并拦截 updateCard 调用。
 *
 * queue-message-edit / bridge-queue-card 两个测试此前复制了同一份 ~60 行
 * setup（DRY），收敛到这里；各自只保留后半段断言。
 */
export async function setupTwoTaskQueueScenario(
  bridge: Bridge,
  connector: ReturnType<typeof createStubConnector>,
  workspace: string,
  opts: { secondMessagePreview?: string } = {},
): Promise<TwoTaskQueueScenario> {
  const updateCardCalls: Array<{ messageId: string; card: object }> = [];
  const originalUpdateCard = connector.updateCard;
  connector.updateCard = async (messageId: string, card: object) => {
    updateCardCalls.push({ messageId, card });
    connector._cards.push(card);
  };

  let release1: () => void = () => {};
  const hang1 = new Promise<void>((resolve) => {
    release1 = resolve;
  });

  // Task 1: starts immediately, blocks
  bridge.enqueue(
    workspace,
    async () => {
      await hang1;
    },
    { taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-1', messagePreview: 'long task' } },
  );

  // Give task1 time to start
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Task 2: queued behind task 1 (taskList.length > 1 triggers queue card)
  bridge.enqueue(workspace, async () => {}, {
    taskMeta: {
      userId: 'u1',
      chatId: 'c1',
      messageId: 'msg-2',
      messagePreview: opts.secondMessagePreview ?? 'original message content',
    },
  });

  // Wait for queue card to be sent
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify initial queue card was sent (header: orange, title: "排队中")
  // FIXED: Use header.title?.content instead of String(header?.title)
  const initialCards = connector._sent.filter((s: { input: unknown }) => {
    const inp = s.input as Record<string, unknown>;
    const card = inp.card as Record<string, unknown> | undefined;
    if (!card) return false;
    const header = card.header as Record<string, unknown> | undefined;
    const titleContent = (header?.title as { content?: string } | undefined)?.content;
    return header?.template === 'orange' && (titleContent?.includes('排队') ?? false);
  });

  return {
    updateCardCalls,
    initialCards,
    release1,
    restoreUpdateCard: () => {
      connector.updateCard = originalUpdateCard;
    },
  };
}
