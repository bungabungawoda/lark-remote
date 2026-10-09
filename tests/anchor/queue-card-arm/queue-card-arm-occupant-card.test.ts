import { describe, it, expect, vi } from 'vitest';
import { makeQueueManager } from '../../lib/bridge-stubs.js';
import { sleep, waitFor } from '../../lib/wait-for.js';
import { expectNoV1ActionContainer } from '../../lib/card-view.js';

vi.mock('../../../src/logger/index.js', async () =>
  (await import('../../lib/logger-mock.js')).loggerModuleMock(),
);

const WORKSPACE = '/tmp/queue-card-arm-occupant-anchor-ws';

type ButtonView = { tag?: string; text?: { content?: string }; disabled?: boolean };

function cardBody(card: object): Record<string, unknown> {
  return (card as Record<string, unknown>).body as Record<string, unknown>;
}

function cardText(card: object): string {
  const elements = cardBody(card).elements as Array<Record<string, unknown>>;
  return elements
    .map((el) => (el.text as Record<string, unknown> | undefined)?.content)
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

function cardButtons(card: object): ButtonView[] {
  const elements = cardBody(card).elements as Array<Record<string, unknown>>;
  return elements.filter((el) => el.tag === 'button') as ButtonView[];
}

function cardHeaderTitle(card: object): string {
  const header = (card as Record<string, unknown>).header as Record<string, unknown>;
  return String((header.title as Record<string, unknown>).content);
}

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

describe('QueueManager - 排队卡按 lane 占用者渲染（anchor）', () => {
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

    const text = cardText(card);
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
    expect(cardText(sentCards[0].card)).not.toContain('前面还有');
    // 第二张：前面有 1 条等待中的消息 + 正在跑的 Compact
    const second = sentCards[1].card;
    expect(cardHeaderTitle(second)).toBe('⏳ 消息排队中');
    expect(cardText(second)).toContain('**队列位置:** 第 2 位');
    expect(cardText(second)).toContain('**前面还有:** 1 条消息');
    expect(cardText(second)).toContain('**正在执行:** 🗜 Compact');

    release();
    await sleep(50);
  });

  it('test_anchor_queue_card_keeps_immediate_enabled_for_message_occupant', async () => {
    // 验证什么行为：占用者不是 Compact 时行为不变——「⚡ 立即执行」仍可点，
    // 卡片照旧说明正在执行的是普通消息。
    const { qm, sentCards } = makeQueueManager();
    const { release } = await occupyLane(qm, { preview: '正在跑的消息', messageId: 'om-run-1' });

    enqueueMessage(qm, 'msg-2');
    await sleep(50);

    expect(sentCards).toHaveLength(1);
    const card = sentCards[0].card;
    expect(cardHeaderTitle(card)).toBe('⏳ 等待当前任务结束');
    expect(cardText(card)).toContain('**正在执行:** 💬 消息');
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

    expect(cardText(sentCards[0].card)).toContain('**正在执行:** 📋 config.save');

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
