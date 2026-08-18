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

const WORKSPACE = '/tmp/queue-card-arm-edit-executing-card-ws';

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

describe('QueueManager - executing card for an edited task must show the edited content (anchor)', () => {
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
    // "▶️ 已开始执行" + `📝 <preview>`），A5 anchor 确立执行卡不得与事实相悖
    // （绿色执行卡是用户对实际执行内容的唯一卡片依据）；A11 anchor 已确立
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

    // 当前实现：begin 路径用 enqueue 时捕获的 taskMeta.messagePreview
    // （'original message'）构建执行卡，updatedCards 里只有旧预览。
    // 这里必须真红：期望执行卡展示 edited message，且不得展示 original。
    const executingUpdates = updatedCards.filter((u) => headerTitle(u) === '▶️ 已开始执行');
    expect(executingUpdates.length).toBe(1);
    const previewLine = divContents(executingUpdates[0]).find((c) => c.includes('📝'));
    expect(previewLine).toBeDefined();
    expect(previewLine!).toContain('edited message');
    expect(previewLine!).not.toContain('original message');
  });
});
