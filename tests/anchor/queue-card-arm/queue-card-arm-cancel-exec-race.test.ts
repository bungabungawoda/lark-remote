import { describe, it, expect, vi } from 'vitest';
import { makeQueueManagerWithPendingCard } from '../../lib/bridge-stubs.js';
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

const WORKSPACE = '/tmp/queue-card-arm-cancel-exec-race-ws';

/** Header title of a card update, e.g. '❌ 已撤销' / '▶️ 已开始执行'. */
function headerTitle(update: { messageId: string; card: object }): string {
  const header = (update.card as { header?: { title?: { content?: string } } }).header;
  return header?.title?.content ?? '';
}

describe('QueueManager - cancelled task card must not be flipped back to executing by a racing queue.immediate mark (anchor)', () => {
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

    // 当前实现：cancelled 先落卡、executing 后落卡 → 最终卡片是"▶️ 已开始执行"，
    // 且存在 executing 更新。这里必须真红（期望最终是"❌ 已撤销"且无 executing 更新）。
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
