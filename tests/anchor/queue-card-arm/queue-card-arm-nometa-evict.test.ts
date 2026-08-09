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

const WORKSPACE = '/tmp/queue-card-arm-nometa-evict-ws';

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

describe('QueueManager - a no-taskMeta task must not evict the next queued meta task (anchor)', () => {
  it('test_anchor_nometa_task_begin_keeps_queued_meta_task_and_it_still_executes', async () => {
    // 验证什么行为：T1（带 meta，挂起）执行中时依次入队 T2（不带 taskMeta 的
    // 合法任务）和 T3（带 meta，拿到排队卡）。T1 结束后 T2 先接跑——T2 的 begin
    // 路径绝不能动 queuedTasks 里 T3 的元数据（T2 从未在 queuedTasks 里登记过，
    // 没有可清理的条目）；T3 必须保持排队状态，并在 T2 结束后轮到自己执行。
    //
    // 缺失会导致什么问题：begin 路径对无 messageId 的任务走 `taskList.shift()`
    // 兜底——它把**下一个** meta 任务（T3）从 queuedTasks/taskIndex 提前清掉。
    // T3 自己轮到时取消检查（indexGet 找不到）直接 return 跳过，**永远不执行**
    // ——用户既没撤销也没编辑，消息静默消失；其排队卡残留 "⏳ 消息排队中" 且按钮
    // 可点，点「撤销」报 "该消息不在队列中（可能已开始执行）"（事实是根本没开始），
    // 点「立即执行」报 "该消息已开始执行" 并顺带停掉当前任务——卡片/提示与真实
    // 队列状态完全相反，用户无法补救。若 T3 曾编辑过，其 replacement 也因 begin
    // 提前 return 永不消费，taskReplacements 泄漏一条死闭包。
    //
    // 依据：QueueManager 串行队列契约——每个入队任务在其槽位轮到时执行，除非被
    // 显式取消（begin 路径 "task skipped (cancelled)" 只应为 removeFromQueue 的
    // 结果）；无 meta 任务从未写入 queuedTasks，其 begin 没有自己的元数据可移除，
    // 移除头部等价于替下一个任务执行取消。A3 编排者裁决已确立无 meta 是合法 API
    // 形态（EnqueueOptions.taskMeta 可选），队列不变量不因 taskMeta 有无而失效。
    const { qm, sentCards } = makeQueueManager();

    // --- 步骤 1：T1（meta，挂起）开始执行 ---
    let resolveT1: () => void = () => {};
    const t1Hang = new Promise<void>((resolve) => {
      resolveT1 = resolve;
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

    // --- 步骤 2：T2（不带 taskMeta，挂起）入队——合法 API 形态，无排队卡 ---
    let resolveT2: () => void = () => {};
    const t2Hang = new Promise<void>((resolve) => {
      resolveT2 = resolve;
    });
    let t2Started = false;
    qm.enqueue(WORKSPACE, async () => {
      t2Started = true;
      await t2Hang;
    });

    // --- 步骤 3：T3（meta，挂起）入队——T1 仍在跑，必须拿到排队卡 ---
    let resolveT3: () => void = () => {};
    const t3Hang = new Promise<void>((resolve) => {
      resolveT3 = resolve;
    });
    let t3Started = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        t3Started = true;
        await t3Hang;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm3',
          messagePreview: 'T3 queued behind no-meta task',
        },
      },
    );
    await sleep(50);
    expect(sentCards.length).toBe(1); // T3 的排队卡
    expect(qm.getQueuedTask(WORKSPACE, 'm3')).toBeDefined(); // T3 排队中

    // --- 步骤 4：T1 正常结束，T2（无 meta）接跑 ---
    resolveT1();
    expect(await waitFor(() => t2Started)).toBe(true);
    await sleep(50);

    // 当前实现：T2 的 begin 走 else 分支把 T3 从 queuedTasks 提前 shift 掉，
    // T3 已不在队列。这里必须真红：期望 T3 仍排队（它排在本该轮到它之前）。
    expect(qm.getQueuedTask(WORKSPACE, 'm3')).toBeDefined();

    // --- 步骤 5：T2 正常结束，T3 轮到自己 ---
    resolveT2();
    // 当前实现：T3 的 begin 取消检查 indexGet 找不到 → return 跳过，永远不执行。
    // 这里必须真红（期望 t3Started=true）。
    expect(await waitFor(() => t3Started)).toBe(true);

    // --- 清理：放行 T3，让队列链自然收尾 ---
    resolveT3();
    await sleep(50);
  });
});
