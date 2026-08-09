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

const WORKSPACE = '/tmp/queue-card-arm-latecard-anchor-ws';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a condition with real waits; returns false on timeout. */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

/**
 * QueueManager with a manually-controlled sendCard: the queue status card's
 * Feishu send promise stays pending until the test resolves it, reproducing
 * the production race where the card send resolves AFTER the task has already
 * begun executing (Feishu latency / 99991400 rate-limit retry).
 */
function makeQueueManagerWithLateCard() {
  const sentCards: Array<{ chatId: string; card: object }> = [];
  const updatedCards: Array<{ messageId: string; card: object }> = [];
  let resolveSendCard: (() => void) | undefined;

  const sendCard = async (chatId: string, card: object) => {
    sentCards.push({ chatId, card });
    return new Promise<string>((resolve) => {
      resolveSendCard = () => resolve('card-late-msg');
    });
  };
  const updateCard = async (messageId: string, card: object) => {
    updatedCards.push({ messageId, card });
  };

  const qm = new QueueManager(() => false, sendCard, updateCard);
  return { qm, sentCards, updatedCards, resolveSendCard: () => resolveSendCard?.() };
}

/** True if the update is the "已开始执行" card transition. */
function isExecutingUpdate(update: { messageId: string; card: object }): boolean {
  const header = (update.card as { header?: { title?: { content?: string } } }).header;
  return header?.title?.content === '▶️ 已开始执行';
}

describe('QueueManager - late-arriving queue card must still transition to executing (anchor)', () => {
  it('test_anchor_late_queue_card_resolving_after_task_begin_is_reconciled', async () => {
    // 验证什么行为: sendQueueStatusCard 是 fire-and-forget 异步发送，
    // queueCardMessages 映射只在 await sendCard 之后才写入。若排队卡在任务
    // 已接跑后才返回（生产：Feishu API 延迟 / 99991400 限流重试，而当前任务
    // 恰被 stop 快速 settle），begin 路径的 updateQueueCardToExecuting 因映射
    // 尚未建立而 no-op，晚到的卡片永远停留在 "⏳ 消息排队中" 且按钮可点。
    // 期望：无论卡片何时发送完成，只要任务已开始执行，该卡必须转为
    // "▶️ 已开始执行"（按钮禁用），不能残留可操作的 pending 卡。
    //
    // 缺失会导致什么问题：用户对一张已开始执行任务的卡片点 "❌ 撤销" →
    // "该消息不在队列中"（误导）；点 "⚡ 立即执行" → handleQueueImmediate
    // 先 interruptCurrentRun 停掉当前正在运行的（可能是不相关的）任务再
    // 清队列——pending 卡的活动按钮把用户控制动作导向错误的执行中任务。
    // 同时 queueCardMessages 映射无人清理（begin 的 no-op 不删除，
    // sendQueueStatusCard 之后也无 reconcile），长跑进程反复触发该竞态时
    // 映射持续增长。
    //
    // 依据：queue-manager.ts begin 路径注释 "Update queue card to 'executing'
    // status BEFORE running the task"——契约是每个接跑任务都必须把其排队卡
    // 转为执行态；buildQueueActionButtons 注释明确 executing/cancelled 状态
    // 必须 hard-disable 按钮，pending builder 只服务未执行任务。本测试构造
    // 映射晚建立的时序，断言该契约在竞态下仍然成立。
    const { qm, sentCards, updatedCards, resolveSendCard } = makeQueueManagerWithLateCard();

    // --- 步骤 1：T1（meta，挂起）开始执行 ---
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

    // --- 步骤 2：T2（meta，挂起）入队 → 排队卡发送挂起（sendCard 未 resolve）---
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
    expect(sentCards.length).toBe(1); // T2 的排队卡已发出（send 挂起）

    // --- 步骤 3：模拟 stop：reset 计数 + T1 被杀 settle ---
    qm.resetExecutingCount(WORKSPACE);
    rejectT1(new Error('simulated process kill'));

    // --- 步骤 4：等 T2 从队列链接跑（此时排队卡 send 仍未完成）---
    expect(await waitFor(() => t2Started)).toBe(true);

    // --- 步骤 5：卡片 send 此刻才完成，映射晚于 begin 写入 ---
    resolveSendCard();
    await sleep(50);

    // 当前实现：T2 begin 时映射不存在 → updateQueueCardToExecuting no-op；
    // send 完成后映射写入但无人 reconcile → updatedCards 永远没有执行态更新。
    // 这里必须真红（期望出现 '▶️ 已开始执行' 更新，实得 0 条）。
    const gotExecutingUpdate = await waitFor(() => updatedCards.some(isExecutingUpdate));
    expect(gotExecutingUpdate).toBe(true);

    // --- 清理：放行 T2，让队列链自然收尾 ---
    resolveT2();
    await sleep(50);
  });
});
