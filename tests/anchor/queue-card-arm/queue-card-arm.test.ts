import { describe, it, expect, vi } from 'vitest';
import {
  makeQueueManager,
  makeQueueManagerWithPendingCard,
  makeQueueManagerWithFailingCardSend,
} from '../../lib/bridge-stubs.js';
import { sleep, waitFor } from '../../lib/wait-for.js';
import { expectNoV1ActionContainer } from '../../lib/card-view.js';
import { cardButtons, cardHeaderTitle, cardTexts } from '../../lib/card-tree.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * QueueManager 纯单元簇：排队卡的发送时机、接跑/撤销的状态迁移、计数守恒、
 * 编辑后执行卡内容、以及按 lane 占用者渲染的卡片契约。
 */

/** Header title of a card update, e.g. '❌ 已撤销' / '▶️ 已开始执行'. */
function headerTitle(update: { messageId: string; card: object }): string {
  const header = (update.card as { header?: { title?: { content?: string } } }).header;
  return header?.title?.content ?? '';
}

/** True if the update is the "已开始执行" card transition. */
function isExecutingUpdate(update: { messageId: string; card: object }): boolean {
  return headerTitle(update) === '▶️ 已开始执行';
}

/** Plain-text div content of a card (the `📝 <preview>` line in queue cards). */
function divContents(update: { messageId: string; card: object }): string[] {
  const elements = (update.card as { body?: { elements?: object[] } }).body?.elements ?? [];
  return elements
    .filter(
      (el): el is { tag: string; text?: { tag?: string; content?: string } } =>
        (el as { tag?: string }).tag === 'div',
    )
    .map((el) => el.text?.content ?? '');
}

describe('QueueManager - queue card must be sent for a message enqueued after an interrupted task resumes (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-ws';

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
    // 静默排队无任何用户反馈（历史生产事故：
    // 消息C 入队无排队卡，静默排队）。
    //
    // 依据：只要 cwd 队列里还有任务在排队或执行，
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
    // 修复前（begin 路径不重新武装计数）只发 1 张。
    expect(sentCards.length).toBe(2);

    // --- 清理：放行 T2，让队列链自然收尾 ---
    resolveT2();
    await sleep(50);
  });
});

describe('QueueManager - queue card for a meta task enqueued while an interrupted no-taskMeta task runs (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-nometa-anchor-ws';

  it('test_anchor_queue_card_sent_when_nometa_task_resumes_after_interrupt', async () => {
    // 验证什么行为：T1（带 taskMeta）执行中被 stop，resetExecutingCount 清零计数
    // 并发放 skip-credit；T1 settle 消耗 credit 后，队列链进入 T2（enqueue 不带
    // taskMeta 的任务）并接跑。此时 T2 实际上正在执行，随后带 taskMeta 的
    // 入队必须收到 "⏳ 消息排队中" 卡片——不变量是"只要 cwd 队列里还
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
    // 依据：编排者裁决（2026-08-01，round 2 分歧裁决）——按字面是
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
    // 修复前：T2 无 messageId，begin 路径不重新武装计数（count 仍 0），
    // 入队时 hasWaitingTasks=false → 不发卡。本用例钉住（期望 1 张，实得 0）。
    expect(sentCards.length).toBe(1);

    // --- 清理：放行 T2、T3，让队列链自然收尾 ---
    rejectT2(new Error('cleanup'));
    resolveT3();
    await sleep(50);
  });
});

describe('QueueManager - a no-taskMeta task must not evict the next queued meta task (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-nometa-evict-ws';

  it('test_anchor_nometa_task_begin_keeps_queued_meta_task_and_it_still_executes', async () => {
    // 验证什么行为：T1（带 meta，挂起）执行中时依次入队 T2（不带 taskMeta 的
    // 合法任务）和 T3（带 meta，拿到排队卡）。T1 结束后 T2 先接跑——T2 的 begin
    // 路径绝不能动 queuedTasks 里 T3 的元数据（T2 从未在 queuedTasks 里登记过，
    // 没有可清理的条目）；T3 必须保持排队状态，并在 T2 结束后轮到自己执行。
    //
    // 缺失会导致什么问题：begin 路径对无 messageId 的任务走 `taskList.shift()`
    // 兜底——它把**下一个** meta 任务从 queuedTasks/taskIndex 提前清掉。
    // 自己轮到时取消检查（indexGet 找不到）直接 return 跳过，**永远不执行**
    // ——用户既没撤销也没编辑，消息静默消失；其排队卡残留 "⏳ 消息排队中" 且按钮
    // 可点，点「撤销」报 "该消息不在队列中（可能已开始执行）"（事实是根本没开始），
    // 点「立即执行」报 "该消息已开始执行" 并顺带停掉当前任务——卡片/提示与真实
    // 队列状态完全相反，用户无法补救。若 T3 曾编辑过，其 replacement 也因 begin
    // 提前 return 永不消费，taskReplacements 泄漏一条死闭包。
    //
    // 依据：QueueManager 串行队列契约——每个入队任务在其槽位轮到时执行，除非被
    // 显式取消（begin 路径 "task skipped (cancelled)" 只应为 removeFromQueue 的
    // 结果）；无 meta 任务从未写入 queuedTasks，其 begin 没有自己的元数据可移除，
    // 移除头部等价于替下一个任务执行取消。编排者裁决已确立无 meta 是合法 API
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

    // 修复前：T2 的 begin 走 else 分支把 T3 从 queuedTasks 提前 shift 掉，
    // 已不在队列。本用例钉住：期望 T3 仍排队（它排在本该轮到它之前）。
    expect(qm.getQueuedTask(WORKSPACE, 'm3')).toBeDefined();

    // --- 步骤 5：T2 正常结束，T3 轮到自己 ---
    resolveT2();
    // 修复前：T3 的 begin 取消检查 indexGet 找不到 → return 跳过，永远不执行。
    // 本用例钉住（期望 t3Started=true）。
    expect(await waitFor(() => t3Started)).toBe(true);

    // --- 清理：放行 T3，让队列链自然收尾 ---
    resolveT3();
    await sleep(50);
  });
});

describe('QueueManager - late-arriving queue card must still transition to executing (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-latecard-anchor-ws';

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
    const { qm, sentCards, updatedCards, resolveSendCard } =
      makeQueueManagerWithPendingCard('card-late-msg');

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

    // 修复前：T2 begin 时映射不存在 → updateQueueCardToExecuting no-op；
    // send 完成后映射写入但无人 reconcile → updatedCards 永远没有执行态更新。
    // 本用例钉住（期望出现 '▶️ 已开始执行' 更新，实得 0 条）。
    const gotExecutingUpdate = await waitFor(() => updatedCards.some(isExecutingUpdate));
    expect(gotExecutingUpdate).toBe(true);

    // --- 清理：放行 T2，让队列链自然收尾 ---
    resolveT2();
    await sleep(50);
  });
});

describe('QueueManager - queue card send failure must clean up the promise mapping (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-send-failure-ws';

  it('test_anchor_failed_queue_card_send_does_not_leave_stale_mapping', async () => {
    // 验证什么行为：排队卡 send（Feishu 发送）失败时，queueCardMessages 中该
    // messageId 的映射必须被删除——后续 updateQueueCardToExecuting/Cancelled
    // 对该消息 no-op，且映射不会随每次失败累积。
    //
    // 缺失会导致什么问题：sendQueueStatusCard 先注册 promise 再 await，失败后
    // promise resolve undefined；若映射不删除，长跑进程在飞书限流/瞬时失败下
    // 每条失败消息都残留一条 `messageId → resolved(undefined)` 条目，无界增长
    // （finding：旧代码只在发送成功后写映射，无此泄漏）。
    //
    // 依据：queueCardMessages 的契约是"排队卡发送到更新消费"的一次性映射，
    // 发送失败即无卡可更新，必须清理；bridge.test.ts 已有直接访问该私有字段
    // 的先例（Map 注入）。
    const { qm, sentCards, updatedCards, getSendFailures } = makeQueueManagerWithFailingCardSend();
    // 白盒观察点：queueCardMessages 是 public 字段，直接读取。

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
    expect(await waitFor(() => qm.queueCardMessages.has('m2') === false)).toBe(true);

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

describe('QueueManager - no fake queue card when queue is idle after repeated interrupt resets (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-countleak-anchor-ws';

  it('test_anchor_no_fake_queue_card_when_idle_after_repeated_reset', async () => {
    // 验证什么行为：多次 resetExecutingCount（连续 stop / stop 与 queue.immediate
    // 交错）且中间有新任务入队时，所有任务都 settle 后 cwd 队列空闲，
    // pendingOrExecutingCount 必须回到 0——此时新入队消息必须立即执行、
    // 不得收到 "⏳ 消息排队中" 卡片。
    //
    // 缺失会导致什么问题：resetExecutingCount 每次按 count>0 无条件发放一个
    // skip-credit，而 begin 路径又无条件把 count 重新武装为 1。三次 reset 与
    // 入队交错后，skip-credit 被"非陈旧"的 settle（T2、T3 的正常收尾）逐个消耗，
    // count 被 begin 重新武装的 1 却没人 decrement → count 永久泄漏为 1。
    // 队列已空仍 hasWaitingTasks=true → 之后每条新消息都收到假的排队卡
    // （消息实际立即执行，卡片却显示"第 1 位 / 排队中"），用户被持续误导；
    // 且 count 永不归零，后续每单都 +1 再 -1，泄漏永久化。这是修复的
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
    qm.resetExecutingCount(WORKSPACE);

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
    qm.resetExecutingCount(WORKSPACE);

    // --- 步骤 6：T1 被杀 settle（消耗 credit #1），链前进到 T2 接跑 ---
    rejectT1(new Error('simulated process kill'));
    expect(await waitFor(() => t2Started)).toBe(true);

    // --- 步骤 7：T2 执行中第三次 stop：reset #3（计数 1→0，credit=3）---
    qm.resetExecutingCount(WORKSPACE);

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

    // 修复前：count 泄漏为 1 → T4 入队时 hasWaitingTasks=true → 发假排队卡
    // （共 3 张）。本用例钉住（期望 2 张）。
    expect(sentCards.length).toBe(2);
  });
});

describe('QueueManager - executing card for an edited task must show the edited content (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-edit-executing-card-ws';

  it('test_anchor_executing_card_shows_edited_content_not_stale_enqueue_preview', async () => {
    // 验证什么行为：排队中的任务 T2 被 queue.edit → queue.input 编辑为
    // 'edited message'（updateQueuedTaskMessage 已把 live QueuedTask 的
    // messagePreview/editedMessage 更新为编辑后内容），随后当前任务 T1 正常
    // 结束、T2 自然轮到时，T2 的 "▶️ 已开始执行" 排队卡必须显示编辑后的内容
    // （📝 edited message）——与实际执行的内容一致，不能显示 enqueue 时冻结的
    // 旧预览（📝 original message）。
    //
    // 缺失会导致什么问题：begin 路径调用 updateQueueCardToExecuting 时传的是
    // enqueue 闭包捕获的 taskMeta.messagePreview（不可变字符串），而不是
    // updateQueuedTaskMessage 更新过的 live 任务预览。编辑后自然执行的任务
    // 卡片显示旧内容：用户看到 "▶️ 已开始执行 📝 original message"（自己已
    // 明确撤回/修正的旧指令），实际 Claude 运行的是 'edited message'——
    // 卡片内容与真实执行内容相反。若编辑是对危险指令的修正（删参数/改路径），
    // 用户会误以为修正未生效并采取错误行动（如再次 /stop 或重发旧指令），
    // 且同一编辑在 queue.immediate 路径（markQueueCardExecuting 读 live
    // getQueuedTask().messagePreview）显示的是编辑后内容——同一条编辑消息的
    // 执行卡内容因启动路径而异，展示与事实不一致。
    //
    // 依据：queue 卡的 "已开始执行" 状态契约是展示"正在执行什么"（header
    // "▶️ 已开始执行" + `📝 <preview>`），确立执行卡不得与事实相悖
    // （绿色执行卡是用户对实际执行内容的唯一卡片依据）；已确立
    // 编辑后自然轮到必须执行 edited content——执行卡展示的 preview 必须与
    // 该实际内容一致。markQueueCardExecuting（immediate 路径）已从 live
    // task.messagePreview 取编辑后内容，begin 路径（自然运行路径）必须一致，
    // 不能回退到 enqueue 时的旧预览。
    const { qm, sentCards, updatedCards } = makeQueueManager();

    // --- 步骤 1：enqueue T1（挂起），等它开始执行 ---
    let releaseT1: () => void = () => {};
    const t1Hang = new Promise<void>((resolve) => {
      releaseT1 = resolve;
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

    // --- 步骤 2：enqueue T2（挂起），排队卡已发 ---
    let t2Started = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        t2Started = true;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm2',
          messagePreview: 'original message',
        },
      },
    );
    await sleep(50);
    expect(sentCards.length).toBe(1); // T2 的排队卡

    // --- 步骤 3：queue.input 编辑 T2 → live 预览更新为 edited message ---
    expect(qm.updateQueuedTaskMessage(WORKSPACE, 'm2', 'edited message')).toBe(true);

    // --- 步骤 4：T1 正常结束（非 interrupt），T2 自然轮到并开始执行 ---
    releaseT1();
    expect(await waitFor(() => t2Started)).toBe(true);
    await sleep(50);

    // 修复前：begin 路径用 enqueue 时捕获的 taskMeta.messagePreview
    // （'original message'）构建执行卡，updatedCards 里只有旧预览。
    // 本用例钉住：期望执行卡展示 edited message，且不得展示 original。
    const executingUpdates = updatedCards.filter((u) => headerTitle(u) === '▶️ 已开始执行');
    expect(executingUpdates.length).toBe(1);
    const previewLine = divContents(executingUpdates[0]).find((c) => c.includes('📝'));
    expect(previewLine).toBeDefined();
    expect(previewLine!).toContain('edited message');
    expect(previewLine!).not.toContain('original message');
  });
});

describe('QueueManager - immediate executing card must re-read live preview after card send resolves (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-edit-executing-race-ws';

  it('test_anchor_immediate_executing_card_uses_live_preview_after_card_send', async () => {
    // 验证什么行为：queue.immediate 的 markQueueCardExecuting（started=false）
    // 在排队卡 send 仍在途时快照了任务预览 'original message'，随后用户经
    // queue.input 把同一排队任务编辑为 'edited message'；send 完成后方法按
    // 成员资格守卫确认任务仍在队列，此时必须展示**当前** live 任务的
    // messagePreview（edited message），而不是调用方在 await 之前捕获的旧
    // 字符串（original message）。本测试直接以 QueueManager 的公共方法复现
    // Bridge.markQueueCardExecuting 的真实调用形状：先取 task.messagePreview
    // 再 await updateQueueCardToExecuting。
    //
    // 缺失会导致什么问题：当前实现 updateQueueCardToExecuting 在 await
    // queueCardMessages 之后仍用参数里的旧预览构建 "▶️ 已开始执行" 卡；该卡
    // 落卡后映射在 finally 删除，稍后 begin 路径的 started=true 更新因映射
    // 已不存在而 no-op——旧预览成为这张执行卡的最终状态。用户看到自己已经
    // 修正过的旧指令（如去掉危险参数）在执行卡上，而实际执行的是编辑后内容，
    // 卡片与事实相反；同一条编辑消息在的自然轮到路径显示编辑后内容，
    // 在 immediate 路径却显示旧内容，展示不一致。只覆盖了编辑先于 begin
    // 的静止时序，本测试覆盖编辑发生在卡片 send 在途期间的竞态时序。
    //
    // 依据：queue-manager.ts updateQueueCardToExecuting 的 started=false 分支
    // 注释明文契约——"a membership guard re-checks the task right before the
    // card update"（成员资格都可能因 await 而变，任务内容同理）；锚点已
    // 确立执行卡展示的 preview 必须与实际执行内容一致（"不能显示 enqueue 时
    // 冻结的旧预览"）。方法在守卫处已能通过 indexGet 拿到 live 任务，重新读取
    // preview 是同一契约的自然延伸。
    const { qm, sentCards, updatedCards, resolveSendCard } =
      makeQueueManagerWithPendingCard('card-preview-race-msg');

    // --- 步骤 1：T1（meta，挂起）开始执行，制造 T2 必须排队 ---
    let releaseT1: () => void = () => {};
    const t1Hang = new Promise<void>((resolve) => {
      releaseT1 = resolve;
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

    // --- 步骤 2：T2（meta，挂起）入队 → 排队卡 send 挂起（映射已注册）---
    qm.enqueue(
      WORKSPACE,
      async () => {
        // 闭包不需要真的执行；本测试只验证卡片内容。
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'm2',
          messagePreview: 'original message',
        },
      },
    );
    expect(await waitFor(() => sentCards.length === 1)).toBe(true);

    // --- 步骤 3：immediate 路径开始 mark executing（started=false），
    // 卡在 await 排队卡 send 上；调用方在调用前已快照旧预览 ---
    const markPromise = qm.updateQueueCardToExecuting(WORKSPACE, 'm2', 'original message', false);
    await sleep(20); // 让 markPromise 注册到挂起的 sendPromise 上

    // --- 步骤 4：send 在途期间用户编辑该任务 → live 预览变为 edited message ---
    expect(qm.updateQueuedTaskMessage(WORKSPACE, 'm2', 'edited message')).toBe(true);

    // --- 步骤 5：卡片 send 此刻才完成，mark 恢复并按守卫确认任务仍在队列 ---
    resolveSendCard();
    await markPromise;
    await sleep(20);

    // 修复前：执行卡仍使用参数里的 'original message'（await 前快照）。
    // 本用例钉住：期望执行卡展示 edited message，且不得展示 original。
    const executingUpdates = updatedCards.filter((u) => headerTitle(u) === '▶️ 已开始执行');
    expect(executingUpdates.length).toBe(1);
    const previewLine = divContents(executingUpdates[0]).find((c) => c.includes('📝'));
    expect(previewLine).toBeDefined();
    expect(previewLine!).toContain('edited message');
    expect(previewLine!).not.toContain('original message');

    // --- 清理：放行 T1，让队列链自然收尾 ---
    releaseT1();
    await sleep(50);
  });
});

describe('QueueManager - cancelled task card must not be flipped back to executing by a racing queue.immediate mark (anchor)', () => {
  const WORKSPACE = '/tmp/queue-card-arm-cancel-exec-race-ws';

  it('test_anchor_cancelled_card_not_overwritten_by_stale_executing_mark', async () => {
    // 验证什么行为：任务 T2 的排队卡 send 仍在途（queueCardMessages 映射挂起）时，
    // 用户点「撤销」：removeFromQueue 成功移除 T2，updateQueueCardToCancelled await
    // 同一个映射 promise。随后 handleQueueImmediate（已在撤销前通过 getQueuedTask
    // 存在性检查、因清除前方任务的 updateQueueCardToCancelled await 挂起而迟到）经
    // markQueueCardExecuting → updateQueueCardToExecuting 也 await 同一映射 promise。
    // send 完成后两个更新按注册顺序落卡：已撤销卡必须先落，且**绝不允许**再被
    // "已开始执行"卡覆盖——T2 已从队列移除，其闭包接跑时会被取消守卫跳过，永远不会
    // 执行，绿色"已开始执行"卡是永久谎言（无完成卡跟随）。
    //
    // 缺失会导致什么问题：撤销与立即执行同属 immediate lane（src/index.ts
    // enqueueImmediate fire-and-forget，二者无串行化），该交错真实可达：immediate
    // 的 getQueuedTask 检查通过后，其"清除前方任务"循环 await 其他卡片的发送，
    // 此时 cancel 移除目标任务并注册 cancelled 更新；immediate 恢复后 mark
    // executing 再注册 executing 更新——映射 finally 删除发生在更新**之后**，
    // 于是两个更新都落卡，最终卡片状态取决于注册顺序而非队列事实。当前实现
    // updateQueueCardToExecuting 只查映射、不查任务是否仍在队列（begin 路径有
    // indexGet 守卫，markQueueCardExecuting 路径没有），撤消卡被翻回执行态：
    // 用户看到"▶️ 已开始执行"但任务永远不会跑，也无法再撤销（按钮已禁用）。
    //
    // 依据：queue-manager.ts begin 路径注释明确声明契约——"a skipped/cancelled
    // task must keep its '❌ 已撤销' card, not be flipped to executing"；该守卫只
    // 存在于 begin 路径，updateQueueCardToExecuting 公共方法本身无成员资格检查，
    // 而 bridge.markQueueCardExecuting 无条件调用它。方向 #1（撤销与接跑在 send
    // 完成瞬间的交错）即此竞态。
    const { qm, sentCards, updatedCards, resolveSendCard } =
      makeQueueManagerWithPendingCard('card-late-msg');

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

    // --- 步骤 2：T2（meta，挂起）入队 → 排队卡 send 挂起（映射已注册）---
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
    expect(await waitFor(() => sentCards.length === 1)).toBe(true);

    // --- 步骤 3：handleQueueCancel 已通过 removeFromQueue 移除 T2，并开始等待
    // 挂起的 send 把卡片更新为"已撤销"（注册 cancelled 更新）---
    expect(qm.removeFromQueue(WORKSPACE, 'm2')).toBe(true);
    const cancelledUpdate = qm.updateQueueCardToCancelled(WORKSPACE, 'm2');

    // --- 步骤 4：handleQueueImmediate 的 markQueueCardExecuting 迟到到达
    // （其存在性检查在步骤 3 移除前已通过），注册 executing 更新 ---
    const executingUpdate = qm.updateQueueCardToExecuting(WORKSPACE, 'm2', 'T2 queued');

    // --- 步骤 5：send 此刻完成，两个更新都按注册顺序落卡 ---
    resolveSendCard();
    await Promise.all([cancelledUpdate, executingUpdate]);
    await sleep(20);

    // 修复前：cancelled 先落卡、executing 后落卡 → 最终卡片是"▶️ 已开始执行"，
    // 且存在 executing 更新。本用例钉住（期望最终是"❌ 已撤销"且无 executing 更新）。
    const cardUpdates = updatedCards.filter((u) => u.messageId === 'card-late-msg');
    expect(cardUpdates.length).toBeGreaterThan(0);
    expect(cardUpdates.some((u) => headerTitle(u) === '▶️ 已开始执行')).toBe(false);
    expect(headerTitle(cardUpdates[cardUpdates.length - 1])).toBe('❌ 已撤销');

    // --- 清理：放行 T1（被杀）与 T2（已被移除，闭包不会执行），队列自然收尾 ---
    rejectT1(new Error('simulated process kill'));
    resolveT2();
    await sleep(50);
  });
});

describe('QueueManager - 排队卡按 lane 占用者渲染（anchor）', () => {
  const WORKSPACE = '/tmp/queue-card-arm-occupant-anchor-ws';

  /** 入队一个挂起任务（lane 占用者）并等它 begin。返回放行函数。 */
  async function occupyLane(
    qm: ReturnType<typeof makeQueueManager>['qm'],
    opts: { kind?: 'message' | 'compact' | 'command'; preview: string; messageId: string },
  ): Promise<{ release: () => void }> {
    let release: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    qm.enqueue(
      WORKSPACE,
      async () => {
        started = true;
        await hang;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: opts.messageId,
          feishuReplyTo: 'om-occupant-card',
          messagePreview: opts.preview,
          editable: false,
          ...(opts.kind ? { kind: opts.kind } : {}),
        },
      },
    );
    expect(await waitFor(() => started)).toBe(true);
    return { release };
  }

  /** 入队一条用户消息（会被排队）。 */
  function enqueueMessage(
    qm: ReturnType<typeof makeQueueManager>['qm'],
    messageId: string,
    preview = '用户消息',
  ): void {
    qm.enqueue(WORKSPACE, async () => {}, {
      taskMeta: { userId: 'u1', chatId: 'c1', messageId, messagePreview: preview },
    });
  }

  it('test_anchor_queue_card_names_compact_occupant_and_drops_empty_position', async () => {
    // 验证什么行为：Compact 占着 lane 时，排在它后面的消息收到的卡片必须
    // 指出"正在执行的是 Compact"，并且不再渲染「位置: 第 1 位 / 前面还有: 0
    // 条消息」——那段文案与"排队中"字面矛盾，用户据此得出"前面什么都没有，
    // 为什么排队"的疑问（2026-10-09 线上实例）。
    //
    // 缺失会导致什么问题：卡片只能回答"要等"，不能回答"等谁"，用户无法把等待
    // 归因到自己去点的那次 Compact；同时「⚡ 立即执行」保持可点，一点就会走
    // interruptCurrentRun 杀掉正在跑的压缩。
    const { qm, sentCards } = makeQueueManager();
    const { release } = await occupyLane(qm, {
      kind: 'compact',
      preview: 'card action: compact',
      messageId: 'card-compact-1',
    });

    enqueueMessage(qm, 'msg-2');
    await sleep(50);

    expect(sentCards).toHaveLength(1);
    const card = sentCards[0].card;
    expectNoV1ActionContainer(card);
    expect(cardHeaderTitle(card)).toBe('⏳ 等待当前任务结束');

    const text = cardTexts(card).join('\n');
    expect(text).toContain('**正在执行:** 🗜 Compact');
    expect(text).toContain('压缩结束后将按顺序执行你的消息');
    // 关键回归：不再出现「排队中 + 前面还有 0 条」的自相矛盾
    expect(text).not.toContain('前面还有');
    expect(text).not.toContain('第 1 位');

    const buttons = cardButtons(card);
    // 立即执行被替换为禁用按钮：不再有「⚡ 立即执行」可点
    expect(buttons.some((b) => b.text?.content === '⚡ 立即执行')).toBe(false);
    expect(buttons.find((b) => b.text?.content === '压缩完成后按顺序执行')?.disabled).toBe(true);
    // 撤销保持可用：它只移除等待中的消息，不触碰 Compact
    expect(buttons.find((b) => b.text?.content === '❌ 撤销')?.disabled ?? false).toBe(false);

    release();
    await sleep(50);
    // 占用者结束后记录清除，不再影响后续卡片
    expect(qm.getExecutingInfo(WORKSPACE)).toBeUndefined();
  });

  it('test_anchor_queue_card_numbers_waiting_position_when_messages_are_ahead', async () => {
    // 验证什么行为：只有"前面确实还有等待中的消息"时才说排队并给出位置；位置
    // 数字只数等待队列，正在执行的占用者单独一行说明。
    const { qm, sentCards } = makeQueueManager();
    const { release } = await occupyLane(qm, {
      kind: 'compact',
      preview: 'card action: compact',
      messageId: 'card-compact-1',
    });

    enqueueMessage(qm, 'msg-2', '第一条');
    enqueueMessage(qm, 'msg-3', '第二条');
    await sleep(50);

    expect(sentCards).toHaveLength(2);
    // 第一张：前面只有正在跑的 Compact
    expect(cardHeaderTitle(sentCards[0].card)).toBe('⏳ 等待当前任务结束');
    expect(cardTexts(sentCards[0].card).join('\n')).not.toContain('前面还有');
    // 第二张：前面有 1 条等待中的消息 + 正在跑的 Compact
    const second = sentCards[1].card;
    expect(cardHeaderTitle(second)).toBe('⏳ 消息排队中');
    expect(cardTexts(second).join('\n')).toContain('**队列位置:** 第 2 位');
    expect(cardTexts(second).join('\n')).toContain('**前面还有:** 1 条消息');
    expect(cardTexts(second).join('\n')).toContain('**正在执行:** 🗜 Compact');

    release();
    await sleep(50);
  });

  it('test_anchor_queue_card_keeps_immediate_enabled_for_message_occupant', async () => {
    // 验证什么行为：占用者是普通消息时「⚡ 立即执行」仍可点，但不渲染
    // 「正在执行: 💬 消息」与「💡 消息将按顺序执行…」——这两行对消息占用者
    // 没有信息量（用户刚发的就是消息），只复述排队本身（2026-10-11）。
    const { qm, sentCards } = makeQueueManager();
    const { release } = await occupyLane(qm, { preview: '正在跑的消息', messageId: 'om-run-1' });

    enqueueMessage(qm, 'msg-2');
    await sleep(50);

    expect(sentCards).toHaveLength(1);
    const card = sentCards[0].card;
    expect(cardHeaderTitle(card)).toBe('⏳ 等待当前任务结束');
    expect(cardTexts(card).join('\n')).not.toContain('正在执行');
    expect(cardTexts(card).join('\n')).not.toContain('消息将按顺序执行');
    const buttons = cardButtons(card);
    expect(buttons.find((b) => b.text?.content === '⚡ 立即执行')?.disabled).toBe(false);
    expect(buttons.find((b) => b.text?.content === '❌ 撤销')?.disabled).toBe(false);

    release();
    await sleep(50);
  });

  it('test_anchor_queue_card_labels_command_occupant', async () => {
    // 验证什么行为：其他卡片动作占 lane 时也自报身份（去掉 `card action: ` 前缀）。
    const { qm, sentCards } = makeQueueManager();
    const { release } = await occupyLane(qm, {
      kind: 'command',
      preview: 'card action: config.save',
      messageId: 'card-cfg-1',
    });

    enqueueMessage(qm, 'msg-2');
    await sleep(50);

    expect(cardTexts(sentCards[0].card).join('\n')).toContain('**正在执行:** 📋 config.save');

    release();
    await sleep(50);
  });

  it('test_anchor_executing_info_belongs_to_successor_after_interrupt', async () => {
    // 验证什么行为：占用者记录与执行槽位同寿且按 slotId 判定归属。前一条任务
    // 被 stop（resetExecutingCount 发 skip-credit）后由后继任务接跑，后继任务的
    // 占用者身份必须正确落在自己身上，全部 settle 后记录清空。
    //
    // 缺失会导致什么问题：若清除不校验 slotId，一条迟到的 settle 会清掉后继
    // 任务的占用者 → 后继 run 期间新入队的消息又变成"说不出在等谁"。
    const { qm } = makeQueueManager();
    const first = await occupyLane(qm, {
      kind: 'compact',
      preview: 'card action: compact',
      messageId: 'card-compact-1',
    });
    const firstSlot = qm.getExecutingInfo(WORKSPACE)?.slotId;
    expect(firstSlot).toBeDefined();
    expect(qm.getExecutingSlot(WORKSPACE)).toBe(firstSlot);

    let secondStarted = false;
    let releaseSecond: () => void = () => {};
    const secondHang = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    qm.enqueue(
      WORKSPACE,
      async () => {
        secondStarted = true;
        await secondHang;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: '后继消息',
        },
      },
    );

    // 生产顺序：先 reset（绑定正在执行的槽位）再让被停任务 settle
    qm.resetExecutingCount(WORKSPACE, firstSlot!);
    first.release();
    expect(await waitFor(() => secondStarted)).toBe(true);

    const successor = qm.getExecutingInfo(WORKSPACE);
    expect(successor?.kind).toBe('message');
    expect(successor?.slotId).not.toBe(firstSlot);
    expect(qm.getExecutingSlot(WORKSPACE)).toBe(successor?.slotId);

    releaseSecond();
    await sleep(50);
    expect(qm.getExecutingInfo(WORKSPACE)).toBeUndefined();
  });
});
