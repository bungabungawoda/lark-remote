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

const WORKSPACE = '/tmp/queue-card-arm-nometa-anchor-ws';

/** Same stub-callback pattern as tests/anchor/queue-card-arm/queue-card-arm.test.ts. */
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

describe('QueueManager - queue card for a meta task enqueued while an interrupted no-taskMeta task runs (anchor A3)', () => {
  it('test_anchor_queue_card_sent_when_nometa_task_resumes_after_interrupt', async () => {
    // 验证什么行为：T1（带 taskMeta）执行中被 stop，resetExecutingCount 清零计数
    // 并发放 skip-credit；T1 settle 消耗 credit 后，队列链进入 T2（enqueue 不带
    // taskMeta 的任务）并接跑。此时 T2 实际上正在执行，随后带 taskMeta 的
    // T3 入队必须收到 "⏳ 消息排队中" 卡片——不变量是"只要 workspace 队列里还
    // 有任务在排队或执行，新入队消息必须收到排队卡"，与任务是否携带 taskMeta
    // 无关（卡片是发给用户消息的，T2 执行中意味着 T3 必然等待）。
    //
    // 缺失会导致什么问题：begin 路径的重新武装若被 `if (messageId)` 挡住
    // （queue-manager.ts begin 路径），无 taskMeta 任务接跑后
    // pendingOrExecutingCount 保持 0。T3 入队时 hasWaitingTasks = (count>0 ||
    // queueLen>0) = false → 不发排队卡，T3 静默排队、无卡片可编辑/撤销/立即执行
    // ——与历史生产事故（消息C 入队无卡）相同的用户可见
    // 失败：实际有任务在执行，新消息却拿不到排队反馈。
    //
    // 依据：编排者裁决（2026-08-01，round 2 分歧裁决）——spec 不变量按字面是
    // 通用的（"有任务在排队或执行"，未按 taskMeta 区分）；EnqueueOptions.taskMeta
    // 是可选字段，无 meta 是合法 API 形态；队列卡片服务于用户消息的可见性，
    // 与占用队列的任务是否带 meta 无关。当前无生产无-meta 调用点
    // （src/index.ts:455/565、src/router/index.ts:456、
    // src/router/order-exec-dispatch.ts:45 全传 taskMeta），属契约边界的防御性
    // 加固，红方原标 probe，经编排者裁决升级为 anchor。
    const { qm, sentCards } = makeQueueManager();

    // --- 步骤 1：enqueue T1（带 meta，挂起），等它开始执行 ---
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

    // --- 步骤 2：T1 执行中 enqueue T2（不带 taskMeta 的任务，挂起）---
    // 无 meta 任务不参与计数也不进 queuedTasks（设计如此），但它确实在队列链里。
    let rejectT2: (err: Error) => void = () => {};
    const t2Hang = new Promise<void>((_resolve, reject) => {
      rejectT2 = reject;
    });
    let t2Started = false;
    qm.enqueue(WORKSPACE, async () => {
      t2Started = true;
      await t2Hang;
    });

    // --- 步骤 3：模拟 stop：reset 计数 + T1 被杀 settle（生产顺序：reset 先于 settle）---
    qm.resetExecutingCount(WORKSPACE);
    rejectT1(new Error('simulated process kill'));

    // --- 步骤 4：等 T2（无 meta）从队列链接跑并保持执行中 ---
    expect(await waitFor(() => t2Started)).toBe(true);

    // --- 步骤 5：T2 执行中 enqueue T3（带 meta）→ 必须发 1 张排队卡 ---
    let resolveT3: () => void = () => {};
    const t3Done = new Promise<void>((resolve) => {
      resolveT3 = resolve;
    });
    qm.enqueue(
      WORKSPACE,
      async () => {
        await t3Done;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm3',
          messagePreview: 'T3 queued while no-meta task runs',
        },
      },
    );
    await sleep(50);
    // 当前实现：T2 无 messageId，begin 路径不重新武装计数（count 仍 0），
    // T3 入队时 hasWaitingTasks=false → 不发卡。这里必须真红（期望 1 张，实得 0）。
    expect(sentCards.length).toBe(1);

    // --- 清理：放行 T2、T3，让队列链自然收尾 ---
    rejectT2(new Error('cleanup'));
    resolveT3();
    await sleep(50);
  });
});
