import { describe, it, expect, vi } from 'vitest';
import { QueueManager } from '../../../src/bridge/queue-manager.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const WORKSPACE = '/tmp/queue-card-arm-send-failure-ws';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

/**
 * QueueManager whose queue-card send FAILS (Feishu error / rate limit): the
 * queue status card is never delivered, and the promise mapping must be
 * cleaned up so a long-running bridge does not accumulate a stale entry per
 * failed send (review P2).
 */
function makeQueueManagerWithFailingCardSend() {
  const sentCards: Array<{ chatId: string; card: object }> = [];
  const updatedCards: Array<{ messageId: string; card: object }> = [];
  let sendFailures = 0;

  const sendCard = async (chatId: string, card: object) => {
    sentCards.push({ chatId, card });
    sendFailures++;
    throw new Error('simulated Feishu send failure');
  };
  const updateCard = async (messageId: string, card: object) => {
    updatedCards.push({ messageId, card });
  };

  const qm = new QueueManager(() => false, sendCard, updateCard);
  return { qm, sentCards, updatedCards, getSendFailures: () => sendFailures };
}

describe('QueueManager - queue card send failure must clean up the promise mapping (anchor A23)', () => {
  it('test_anchor_failed_queue_card_send_does_not_leave_stale_mapping', async () => {
    // 验证什么行为：排队卡 send（Feishu 发送）失败时，queueCardMessages 中该
    // messageId 的映射必须被删除——后续 updateQueueCardToExecuting/Cancelled
    // 对该消息 no-op，且映射不会随每次失败累积。
    //
    // 缺失会导致什么问题：sendQueueStatusCard 先注册 promise 再 await，失败后
    // promise resolve undefined；若映射不删除，长跑进程在飞书限流/瞬时失败下
    // 每条失败消息都残留一条 `messageId → resolved(undefined)` 条目，无界增长
    // （review P2 finding：旧代码只在发送成功后写映射，无此泄漏）。
    //
    // 依据：queueCardMessages 的契约是"排队卡发送到更新消费"的一次性映射，
    // 发送失败即无卡可更新，必须清理；bridge.test.ts 已有直接访问该私有字段
    // 的先例（Map 注入）。
    const { qm, sentCards, updatedCards, getSendFailures } = makeQueueManagerWithFailingCardSend();
    // 白盒观察点：与 src/bridge/bridge.test.ts 相同的私有字段访问模式。
    const qmPrivate = qm as unknown as {
      queueCardMessages: Map<string, Promise<string | undefined>>;
    };

    // --- 步骤 1：T1（挂起）开始执行 ---
    let rejectT1: (err: Error) => void = () => {};
    const t1Hang = new Promise<void>((_resolve, reject) => {
      rejectT1 = reject;
    });
    let t1Started = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        t1Started = true;
        await t1Hang;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm1',
          messagePreview: 'T1 running',
        },
      },
    );
    expect(await waitFor(() => t1Started)).toBe(true);

    // --- 步骤 2：T2 入队 → 排队卡发送失败 ---
    let resolveT2: () => void = () => {};
    const t2Hang = new Promise<void>((resolve) => {
      resolveT2 = resolve;
    });
    qm.enqueue(
      WORKSPACE,
      async () => {
        await t2Hang;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm2',
          messagePreview: 'T2 queued',
        },
      },
    );
    await sleep(50);
    expect(sentCards.length).toBe(1); // T2 的排队卡尝试发送
    expect(getSendFailures()).toBe(1);

    // --- 步骤 3：发送失败 settle 后，映射必须已清理 ---
    expect(await waitFor(() => qmPrivate.queueCardMessages.has('m2') === false)).toBe(true);

    // --- 步骤 4：后续对 m2 的卡片更新必须 no-op（不调 updateCard）---
    await qm.updateQueueCardToExecuting(WORKSPACE, 'm2', 'T2 queued', true);
    await qm.updateQueueCardToCancelled(WORKSPACE, 'm2');
    expect(updatedCards).toHaveLength(0);

    // --- 清理：放行 T2，队列链自然收尾 ---
    resolveT2();
    rejectT1(new Error('cleanup'));
    await sleep(50);
  });
});
