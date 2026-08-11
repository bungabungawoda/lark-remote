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

const WORKSPACE = '/tmp/queue-card-arm-countleak-anchor-ws';

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

describe('QueueManager - no fake queue card when queue is idle after repeated interrupt resets (anchor)', () => {
  it('test_anchor_no_fake_queue_card_when_idle_after_repeated_reset', async () => {
    // 验证什么行为：多次 resetExecutingCount（连续 stop / stop 与 queue.immediate
    // 交错）且中间有新任务入队时，所有任务都 settle 后 workspace 队列空闲，
    // pendingOrExecutingCount 必须回到 0——此时新入队消息必须立即执行、
    // 不得收到 "⏳ 消息排队中" 卡片。
    //
    // 缺失会导致什么问题：resetExecutingCount 每次按 count>0 无条件发放一个
    // skip-credit，而 begin 路径又无条件把 count 重新武装为 1。三次 reset 与
    // 入队交错后，skip-credit 被"非陈旧"的 settle（T2、T3 的正常收尾）逐个消耗，
    // count 被 begin 重新武装的 1 却没人 decrement → count 永久泄漏为 1。
    // 队列已空仍 hasWaitingTasks=true → 之后每条新消息都收到假的排队卡
    // （消息实际立即执行，卡片却显示"第 1 位 / 排队中"），用户被持续误导；
    // 且 count 永不归零，后续每单都 +1 再 -1，泄漏永久化。这是 A1 修复的
    // 反向缺陷：不该弹卡时弹卡（原缺陷是该弹卡时不弹卡）。
    //
    // 依据：QueueManager 的公开契约不变量——排队卡只应在"队列里确有任务在
    // 排队或执行"时发送（enqueue 的 hasWaitingTasks 注释即此语义）；计数必须
    // 反映真实执行状态，任务全部 settle 后必须归零。resetExecutingCount 的
    // 文档注释承诺"计数为 0 时 no-op"，但连续 reset 后 count 停在 1 说明
    // skip-credit 与 re-arm 的组合不守恒。
    const { qm, sentCards } = makeQueueManager();

    // --- 步骤 1：T1（meta，挂起）开始执行，计数=1 ---
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

    // --- 步骤 2：T2（meta，挂起）入队 → 排队卡 #1（计数=2）---
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

    // --- 步骤 3：第一次 stop：reset #1（计数 2→0，credit=1）---
    const slot1 = qm.getExecutingSlot(WORKSPACE);
    expect(slot1).toBeDefined();
    qm.resetExecutingCount(WORKSPACE, slot1!);

    // --- 步骤 4：T3（meta，快速）入队 → 排队卡 #2（队列里还有 T2，排队卡照发）---
    let t3Ran = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        t3Ran = true;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm3',
          messagePreview: 'T3 queued',
        },
      },
    );
    await sleep(50);
    expect(sentCards.length).toBe(2); // T3 的排队卡

    // --- 步骤 5：第二次 stop：reset #2（计数因 T3 入队回到 1 → 0，credit=2）---
    const slot2 = qm.getExecutingSlot(WORKSPACE);
    expect(slot2).toBeDefined();
    qm.resetExecutingCount(WORKSPACE, slot2!);

    // --- 步骤 6：T1 被杀 settle（消耗 credit #1），链前进到 T2 接跑 ---
    rejectT1(new Error('simulated process kill'));
    expect(await waitFor(() => t2Started)).toBe(true);

    // --- 步骤 7：T2 执行中第三次 stop：reset #3（计数 1→0，credit=3）---
    const slot3 = qm.getExecutingSlot(WORKSPACE);
    expect(slot3).toBeDefined();
    qm.resetExecutingCount(WORKSPACE, slot3!);

    // --- 步骤 8：T2 正常结束（settle 消耗 credit #2），T3 接跑并结束 ---
    resolveT2();
    expect(await waitFor(() => t3Ran)).toBe(true);
    await sleep(50); // 等 T3 的 settle 执行完

    // 至此所有任务已 settle、队列已空。当前实现 count 泄漏为 1（T3 的 settle
    // 消耗了 credit #3 而不是 decrement 掉 begin 重新武装的 1）。

    // --- 步骤 9：空闲时新入队 T4 → 必须立即执行且不再发排队卡 ---
    let t4Ran = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        t4Ran = true;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm4',
          messagePreview: 'T4 should run immediately',
        },
      },
    );
    expect(await waitFor(() => t4Ran)).toBe(true);
    await sleep(50);

    // 当前实现：count 泄漏为 1 → T4 入队时 hasWaitingTasks=true → 发假排队卡
    // （共 3 张）。这里必须真红（期望 2 张）。
    expect(sentCards.length).toBe(2);
  });
});
