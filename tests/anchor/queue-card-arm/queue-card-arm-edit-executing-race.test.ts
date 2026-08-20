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

const WORKSPACE = '/tmp/queue-card-arm-edit-executing-race-ws';

/** Header title of a card update, e.g. '▶️ 已开始执行'. */
function headerTitle(update: { messageId: string; card: object }): string {
  const header = (update.card as { header?: { title?: { content?: string } } }).header;
  return header?.title?.content ?? '';
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

describe('QueueManager - immediate executing card must re-read live preview after card send resolves (anchor)', () => {
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
    // 卡片与事实相反；同一条编辑消息在 A12 的自然轮到路径显示编辑后内容，
    // 在 immediate 路径却显示旧内容，展示不一致。A12 只覆盖了编辑先于 begin
    // 的静止时序，本测试覆盖编辑发生在卡片 send 在途期间的竞态时序。
    //
    // 依据：queue-manager.ts updateQueueCardToExecuting 的 started=false 分支
    // 注释明文契约——"a membership guard re-checks the task right before the
    // card update"（成员资格都可能因 await 而变，任务内容同理）；A12 锚点已
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
        // T2 闭包不需要真的执行；本测试只验证卡片内容。
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

    // 当前实现：执行卡仍使用参数里的 'original message'（await 前快照）。
    // 这里必须真红：期望执行卡展示 edited message，且不得展示 original。
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
