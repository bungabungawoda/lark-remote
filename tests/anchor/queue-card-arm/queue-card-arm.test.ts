import { describe, it, expect, vi } from 'vitest';
import { QueueManager } from '../../../src/bridge/queue-manager.js';
import { sleep, waitFor } from '../../lib/wait-for.js';

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

const WORKSPACE = '/tmp/queue-card-arm-ws';

/**
 * Create a QueueManager with stub callbacks (same pattern as
 * src/bridge/queue-interrupt.test.ts: sendCard pushes to sentCards and
 * returns a fake Feishu card message id; updateCard records updates).
 */
function makeQueueManager() {
  const sentCards: Array<{ chatId: string; card: object }> = [];
  const updatedCards: Array<{ messageId: string; card: object }> = [];

  const sendCard = async (chatId: string, card: object) => {
    sentCards.push({ chatId, card });
    return `card-msg-${sentCards.length}`;
  };
  const updateCard = async (messageId: string, card: object) => {
    updatedCards.push({ messageId, card });
  };

  const qm = new QueueManager(() => false, sendCard, updateCard);
  return { qm, sentCards, updatedCards };
}

describe('QueueManager - queue card must be sent for a message enqueued after an interrupted task resumes (anchor A1)', () => {
  it('test_anchor_queue_card_sent_when_task_resumes_after_interrupt', async () => {
    // 验证什么行为：T2 在 T1 执行中入队（拿到排队卡）之后，用户 stop 触发
    // resetExecutingCount，T1 的挂起 promise settle 消耗 skip-credit，T2 从
    // 队列链 begin 路径接跑并保持执行中——此时再入队 T3，T3 必须收到
    // "⏳ 消息排队中"卡片（T2 + T3 共 2 张）。
    //
    // 缺失会导致什么问题：begin 路径只更新卡片 + 移除任务，不重新武装
    // pendingOrExecutingCount；resetExecutingCount 已把计数清零且 skip-credit
    // 被 T1 的 settle 消耗，T2 接跑后计数仍为 0 → T3 入队时
    // hasWaitingTasks = (count>0 || queueLen>0) = false → 排队卡不发，
    // T3 静默排队无任何用户反馈（历史生产事故：
    // 消息C 入队无排队卡，静默排队）。
    //
    // 依据（本 prompt spec）：只要 workspace 队列里还有任务在排队或执行，
    // 新入队消息必须收到排队卡；生产时序为 T2 入队(12:52:25) →
    // stop+reset(12:52:36) → T2 接跑(12:52:37) → T3 入队(12:53:57) 无卡。
    const { qm, sentCards } = makeQueueManager();

    // --- 步骤 1：enqueue T1（挂起不 resolve），等它开始执行 ---
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

    // --- 步骤 2：T1 执行中 enqueue T2（也挂起）→ 必须发 1 张排队卡 ---
    let resolveT2: () => void = () => {};
    const t2Hang = new Promise<void>((resolve) => {
      resolveT2 = resolve;
    });
    let t2Started = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        t2Started = true;
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
    expect(sentCards.length).toBe(1); // T2 的排队卡

    // --- 步骤 3：模拟 stop：reset 计数 + T1 进程被杀 settle ---
    qm.resetExecutingCount(WORKSPACE);
    rejectT1(new Error('simulated process kill'));

    // --- 步骤 4：等 T2 从队列链接跑（继续挂起 = 执行中）---
    expect(await waitFor(() => t2Started)).toBe(true);

    // --- 步骤 5：T2 执行中 enqueue T3 → 必须再发 1 张排队卡（共 2 张）---
    qm.enqueue(
      WORKSPACE,
      async () => {
        // no-op
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm3',
          messagePreview: 'T3 queued after interrupt resume',
        },
      },
    );
    await sleep(50);
    // 当前实现（begin 路径不重新武装计数）只发 1 张，这里必须真红。
    expect(sentCards.length).toBe(2);

    // --- 清理：放行 T2，让队列链自然收尾 ---
    resolveT2();
    await sleep(50);
  });
});
