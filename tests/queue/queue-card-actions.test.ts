import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  cleanupQueueTestContext,
  makeQueueTestContext,
  setupTwoTaskQueueScenario,
  type QueueTestContext,
} from '../lib/queue-scenario.js';
import { makeBridge } from '../lib/bridge-stubs.js';
import { mockLogger } from '../lib/logger-mock.js';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
import { expectNoV1ActionContainer } from '../lib/card-view.js';
import { cardButtons, type Card } from '../lib/card-tree.js';

vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

/**
 * queue 卡片动作簇：queue.edit / queue.input / queue.immediate 的用户可见反馈、
 * 原地编辑卡片渲染、以及 queue.diagnose 诊断卡的 CardKit 2.0 结构。
 */

/** Plain-text sent via sendWithRetry (excludes cards). */
function sentTexts(ctx: QueueTestContext): string[] {
  return ctx.connector._sent
    .map((s) => (s.input as { text?: string } | undefined)?.text)
    .filter((t): t is string => typeof t === 'string');
}

describe('queue card actions (queue.edit / queue.input / queue.immediate)', () => {
  let ctx: QueueTestContext;

  beforeEach(() => {
    ctx = makeQueueTestContext();
  });

  afterEach(() => {
    cleanupQueueTestContext(ctx);
  });

  describe('queue.input returns toast instead of sending message', () => {
    it('test_anchor_queue_input_returns_success_toast', async () => {
      // Bug: 编辑排队消息提交后，handleQueueInput 调 sendResult({ text: '✅ 消息已更新' })
      // 发了一条正文消息，冗余。应改为返回 CardActionResponse toast，由 SDK 作为飞书
      // 回调响应给点击用户即时反馈，不再发送正文。
      // 链路：connector cardAction listener return + index.ts return + router return toast。

      const { bridge, router, connector, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        firstMessagePreview: 'task 1',
        secondMessagePreview: 'original',
      });

      const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

      // Submit edited content via queue.input
      const result = await router.handleCardAction(
        { cmd: 'queue.input', cwd: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
        cardCtx,
      );

      // Assert: returns a CardActionResponse with a success toast AND an
      // in-place card update (card.data) so Feishu renders the updated queue
      // card and closes the edit form. A toast-only response leaves the card
      // stuck in edit state (Feishu keeps the pre-click card when the callback
      // response has no `card` field).
      expect(result).toMatchObject({ toast: { type: 'success', content: '消息已更新' } });
      expect(result).toMatchObject({ card: { type: 'raw' } });
      expect((result as { card?: { data?: { schema?: string } } }).card?.data?.schema).toBe('2.0');

      // Assert: did NOT send a separate "✅ 消息已更新" text message
      expect(sentTexts(ctx)).not.toContain('✅ 消息已更新');

      release1();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('queue.input isBusyFor blocking', () => {
    it('test_anchor_handleQueueInput_allows_editing_queued_task_when_workspace_busy', async () => {
      // Bug: handleQueueInput checks isBusyFor(cwd) and blocks editing
      // if the cwd is busy. But the task being edited is QUEUED (not
      // executing) — editing its message preview should work even when another
      // task is running in the same cwd.

      const { bridge, router, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, ctx.connector, tmpDir, {
        firstMessagePreview: 'task 1 running',
        secondMessagePreview: 'original content',
      });

      // Verify task 2 is in the queue
      const task = bridge.getQueuedTask(tmpDir, 'msg-2');
      expect(task).toBeDefined();

      // Spy on isBusyFor to simulate a busy cwd (another task running)
      vi.spyOn(bridge, 'isBusyFor').mockReturnValue(true);

      // Spy on updateMessagePreview to verify it gets called
      const updateSpy = vi.spyOn(bridge, 'updateMessagePreview');

      // Simulate submitting new content via queue.input
      const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
      await router.handleCardAction(
        {
          cmd: 'queue.input',
          cwd: tmpDir,
          messageId: 'msg-2',
          inputValue: 'new edited content',
        },
        cardCtx,
      );

      // Bug: handleQueueInput returns early when isBusyFor returns true,
      // so updateMessagePreview is never called. But the task is QUEUED —
      // editing its message should work even when the cwd is busy.
      expect(updateSpy).toHaveBeenCalledWith(tmpDir, 'msg-2', 'new edited content');

      // Cleanup
      release1();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('queue.edit misleading error when busy', () => {
    it('test_anchor_handleQueueEdit_does_not_say_task_started_executing_for_queued_task', async () => {
      // Bug: handleQueueEdit checks isBusyFor(cwd) and if true, returns
      // "⚠️ 任务已开始执行，无法编辑". But the task being edited is QUEUED —
      // it hasn't started executing. Another task is running in the cwd.
      // The error message is misleading: it says THIS task has started
      // executing when it hasn't.

      const { bridge, router, connector, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        firstMessagePreview: 'task 1 running',
        secondMessagePreview: 'queued task',
      });

      // Verify task 2 is in the queue (it's queued, NOT executing)
      const task = bridge.getQueuedTask(tmpDir, 'msg-2');
      expect(task).toBeDefined();

      // Spy on isBusyFor to simulate a busy cwd (another task running)
      vi.spyOn(bridge, 'isBusyFor').mockReturnValue(true);

      // Simulate clicking "✏️ 编辑" on task 2's queue card
      const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
      await router.handleCardAction(
        { cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' },
        cardCtx,
      );

      // Bug: handleQueueEdit returns "⚠️ 任务已开始执行，无法编辑" when
      // isBusyFor returns true. But task 2 is QUEUED, not executing — it's
      // the cwd that's busy with ANOTHER task. The error message should
      // NOT say "任务已开始执行" (which implies THIS task has started).
      const misleadingMessage = sentTexts(ctx).find((t) => t.includes('任务已开始执行'));
      expect(misleadingMessage).toBeUndefined();

      // Cleanup
      release1();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('queue.immediate stale card', () => {
    it('test_anchor_handleQueueImmediate_updates_cancelled_cards_for_removed_tasks', async () => {
      // Bug: handleQueueImmediate removes tasks before the target from the queue
      // via removeFromQueue, but does NOT call updateQueueCardToCancelled for
      // those removed tasks. Their queue cards remain showing "⏳ 消息排队中"
      // instead of being updated to "❌ 已撤销".

      const { bridge, router, connector, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        firstMessagePreview: 'task 1 running',
        secondMessagePreview: 'task 2 queued',
      });

      // Spy on updateQueueCardToCancelled to track calls
      const cancelSpy = vi.spyOn(bridge, 'updateQueueCardToCancelled');

      // Task 3: queued behind task 1 and 2 (gets a queue card) — this is the target
      bridge.enqueue(tmpDir, async () => {}, {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 queued',
        },
      });

      // Wait for queue cards to be sent
      await new Promise((r) => setTimeout(r, 100));

      // Verify both task 2 and task 3 are in the queue
      const tasks = bridge.getQueuedTasks(tmpDir);
      expect(tasks.find((t) => t.messageId === 'msg-2')).toBeDefined();
      expect(tasks.find((t) => t.messageId === 'msg-3')).toBeDefined();

      // Simulate clicking "立即执行" on task 3's queue card
      const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-3' };
      await router.handleCardAction(
        { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-3' },
        cardCtx,
      );

      // Bug: handleQueueImmediate removes task 2 from the queue but does NOT
      // call updateQueueCardToCancelled for it. Task 2's queue card remains
      // showing "⏳ 消息排队中" instead of being updated to "❌ 已撤销".
      expect(cancelSpy).toHaveBeenCalledWith(tmpDir, 'msg-2');

      // Cleanup
      release1();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('queue.immediate marks target card executing', () => {
    it('test_anchor_handleQueueImmediate_updates_target_card_to_executing', async () => {
      // Bug: handleQueueImmediate stops the current run and clears tasks ahead of
      // the target, but does NOT update the TARGET's own queue card. The card stays
      // "⏳ 消息排队中" with all buttons enabled until the task actually starts
      // executing (updateQueueCardToExecuting in the queue callback). User clicks
      // 立即执行 but sees no immediate feedback; the button remains clickable.
      // Fix: handleQueueImmediate should mark the target card as executing right
      // away so buttons grey out immediately.

      const { bridge, router, connector, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        firstMessagePreview: 'task 1 running',
        secondMessagePreview: 'task 2 queued',
      });

      // Verify task 2 is still queued (not yet executing)
      const task = bridge.getQueuedTask(tmpDir, 'msg-2');
      expect(task).toBeDefined();

      // Simulate clicking "⚡ 立即执行" on task 2's queue card
      const cardCtx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
      await router.handleCardAction(
        { cmd: 'queue.immediate', cwd: tmpDir, messageId: 'msg-2' },
        cardCtx,
      );

      // Bug: handleQueueImmediate does not update the target's card. After the
      // fix, the target card should be updated to "▶️ 已开始执行" (green header)
      // with all buttons disabled.
      const executingCard = connector._cards.find((c) => {
        const card = c as Record<string, unknown>;
        const header = card.header as Record<string, unknown> | undefined;
        const title = header?.title as Record<string, unknown> | undefined;
        return (title?.content as string | undefined)?.includes('已开始执行');
      });
      expect(executingCard).toBeDefined();

      // All buttons on the executing card must be disabled
      const buttons = cardButtons(executingCard as Card);
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) {
        expect(b.disabled).toBe(true);
      }

      // Cleanup
      release1();
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  describe('queue.edit 原地更新修复', () => {
    it('test_anchor_queueEdit_uses_input_with_default_value_and_behaviors', async () => {
      // Bug: queue.edit 的 input 用了 `value` + 独立 button（button 上 behaviors）
      // 这导致飞书 callback 不回传 input 值 -> "缺少新消息内容"
      // 预期：input 应使用 default_value + 自带 behaviors（对齐 config.input）

      const { bridge, router, connector, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        firstMessageId: 'msg-1-blocking',
        firstMessagePreview: 'blocking task',
        secondMessagePreview: 'original message',
        // 不拦截 updateCard：本文件断言依赖 stub 的 _updateCardCalls 记录
        interceptUpdateCard: false,
      });

      // 触发编辑
      await router.handleCardAction(
        { cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' },
        { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
      );

      // 找到发出的编辑卡片（可能在 _updateCardCalls 或 _sent 中，取决于是否 fallback）
      const findEditCard = (store: { input?: unknown; card?: object }[]) =>
        store.find((s) => {
          const card =
            (s as { input?: { card?: Record<string, unknown> }; card?: Record<string, unknown> })
              .input?.card ?? (s as { card?: Record<string, unknown> }).card;
          if (!card) return false;
          const header = card.header as Record<string, unknown> | undefined;
          return (header?.title as { content?: string } | undefined)?.content?.includes('编辑');
        });

      const editCardEntry =
        findEditCard(connector._sent as { input?: unknown }[]) ??
        (findEditCard(connector._updateCardCalls as { card?: object }[]) as
          { input?: unknown } | undefined);
      expect(editCardEntry).toBeDefined();

      // _updateCardCalls 的 entry 形如 { messageId, card }，_sent 形如 { chatId, input: { card } }
      const card =
        (editCardEntry as { input?: { card?: Record<string, unknown> } }).input?.card ??
        (editCardEntry as { card?: Record<string, unknown> }).card;
      const body = card!.body as Record<string, unknown>;
      const elements = body.elements as Array<Record<string, unknown>>;

      // 参考 lark-notes 编辑实现：CardKit 2.0 input 提交图标（✓）点击时，输入值走
      // raw.action.input_value（SDK normalizer 丢弃，需 connector includeRawEvent: true
      // + index.ts 从 raw 提取）。卡片用 column_set + input（自带 behaviors），
      // 不用 form 容器（form 触发 300123 无 submit button / 200621 嵌套 column）。
      expect(elements.find((el) => el.tag === 'form')).toBeUndefined();

      // input 在 column_set -> column -> elements 内，递归查找
      const findInput = (
        els: Array<Record<string, unknown>>,
      ): Record<string, unknown> | undefined => {
        for (const el of els) {
          if (el.tag === 'input') return el;
          const columns = el.columns as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(columns)) {
            for (const col of columns) {
              const colElements = col.elements as Array<Record<string, unknown>> | undefined;
              if (Array.isArray(colElements)) {
                const found = findInput(colElements);
                if (found) return found;
              }
            }
          }
        }
        return undefined;
      };
      const inputElement = findInput(elements);
      expect(inputElement).toBeDefined();

      // 1. 用 default_value 预填旧内容
      expect(inputElement).toHaveProperty('default_value');
      expect(inputElement).toHaveProperty('name', 'newMessage');

      // 2. input 自带 behaviors callback（提交图标触发 queue.input）
      const behaviors = inputElement?.behaviors as Array<Record<string, unknown>> | undefined;
      expect(behaviors?.[0]?.value).toMatchObject({ cmd: 'queue.input' });

      release1();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('test_anchor_queueInput_succeeds_with_inputValue', async () => {
      // 完整流程：编辑 -> 提交新内容 -> 消息预览更新
      // 验证 queue.input 能正确读取 inputValue（由 index.ts 从 raw.action.input_value 提取）

      const { bridge, router, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, ctx.connector, tmpDir, {
        firstMessageId: 'msg-1-blocking',
        firstMessagePreview: 'blocking task',
        secondMessagePreview: 'original message',
        // 不拦截 updateCard：本文件断言依赖 stub 的 _updateCardCalls 记录
        interceptUpdateCard: false,
      });

      // 1. 点击编辑
      await router.handleCardAction(
        { cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' },
        { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
      );

      // 2. 模拟 input ✓ 提交图标回调：index.ts 从 action.raw.action.input_value 提取
      //    （SDK normalizer 丢弃，需 connector includeRawEvent: true）后传给 router 的 inputValue
      const updateSpy = vi.spyOn(bridge, 'updateMessagePreview');
      await router.handleCardAction(
        { cmd: 'queue.input', cwd: tmpDir, messageId: 'msg-2', inputValue: 'edited content' },
        { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
      );

      // 验证消息已更新
      expect(updateSpy).toHaveBeenCalledWith(tmpDir, 'msg-2', 'edited content');

      // 验证任务预览已更新
      const task = bridge.getQueuedTask(tmpDir, 'msg-2');
      expect(task?.messagePreview).toBe('edited content');

      release1();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('test_anchor_queueEdit_uses_updateCardInPlace_not_new_card', async () => {
      // Bug: handleQueueEdit 用 sendResult 发送新卡片
      // 预期：使用 updateCardInPlace 原地更新原卡片

      const { bridge, router, connector, tmpDir } = ctx;
      const { release1 } = await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        firstMessageId: 'msg-1-blocking',
        firstMessagePreview: 'blocking task',
        secondMessagePreview: 'original message',
        // 不拦截 updateCard：本文件断言依赖 stub 的 _updateCardCalls 记录
        interceptUpdateCard: false,
      });

      // 监视 updateCardInPlace
      const updateInPlaceSpy = vi.spyOn(bridge, 'updateCardInPlace');
      const sendResultSpy = vi.spyOn(bridge, 'sendResult');

      await router.handleCardAction(
        { cmd: 'queue.edit', cwd: tmpDir, messageId: 'msg-2' },
        { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
      );

      // 验证：应该调用 updateCardInPlace（而不是只调用 sendResult 发新卡片）
      expect(updateInPlaceSpy).toHaveBeenCalledTimes(1);

      // sendResult 不应该被直接调用（updateCardInPlace 内部 fallback 才会调）
      // 即 handleQueueEdit 不应该直接调用 sendResult
      expect(sendResultSpy).not.toHaveBeenCalled();

      release1();
      await new Promise((r) => setTimeout(r, 100));
    });
  });
});

describe('Queue message edit', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_queue_message_edit', async () => {
    const { bridge, connector } = makeBridge();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();

    const { updateCardCalls, initialCards, release1, restoreUpdateCard } =
      await setupTwoTaskQueueScenario(bridge, connector, tmpDir);
    expect(initialCards.length).toBeGreaterThan(0);

    // Verify the initial card contains an edit button (cmd: queue.edit)
    const initialCard = (initialCards[0].input as Record<string, unknown>).card as Record<
      string,
      unknown
    >;
    const initialBody = initialCard.body as Record<string, unknown>;
    const initialElements = initialBody.elements as Array<Record<string, unknown>>;
    const editButton = initialElements.find((el: Record<string, unknown>) => {
      if (el.tag !== 'button') return false;
      const behaviors = el.behaviors as Array<Record<string, unknown>> | undefined;
      if (!behaviors?.length) return false;
      const value = behaviors[0].value as Record<string, unknown> | undefined;
      return value?.cmd === 'queue.edit';
    });
    expect(editButton).toBeDefined();

    // Step 2: Simulate clicking edit button -> card shows input with default_value
    // This would be handled by router.handleCardAction for cmd 'queue.edit'
    // The card should update to show an input element with the current message as default_value
    const updatedNewContent = 'edited message content';

    // Step 3: Simulate submitting new content via queue.input
    // This would be handled by router.handleCardAction for cmd 'queue.input'
    // The queue manager should update the messagePreview for the queued task
    // and return the updated card object (sent as the cardAction callback
    // response `card.data`, not via a PATCH updateCard call).
    const editCard = await bridge.updateMessagePreview(tmpDir, 'msg-2', updatedNewContent);

    // Verify the queued task's messagePreview was updated
    const updatedTask = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(updatedTask?.messagePreview).toBe(updatedNewContent);

    // Step 4: Verify the returned card shows the new content
    expect(editCard).not.toBeNull();
    const editBody = (editCard as Record<string, unknown> | null)?.body as
      Record<string, unknown> | undefined;
    const editElements = editBody?.elements as Array<Record<string, unknown>> | undefined;
    const hasNewContent = editElements?.some((el: Record<string, unknown>) => {
      const text = el.text as Record<string, unknown> | undefined;
      const content = text?.content as string | undefined;
      return content?.includes(updatedNewContent) ?? false;
    });
    expect(hasNewContent).toBe(true);

    // Step 5: Verify the edit button is disabled once task starts executing
    release1();
    await new Promise((r) => setTimeout(r, 150));

    // The executing-state card should have disabled edit button
    const executingUpdateCall = updateCardCalls.find((call) => {
      const card = call.card as Record<string, unknown>;
      const header = card.header as Record<string, unknown>;
      const titleContent = (header?.title as { content?: string } | undefined)?.content;
      return titleContent?.includes('已开始执行') ?? false;
    });
    // 执行态卡片必须移除 queue.edit 按钮（执行中不可编辑），仅保留禁用的
    // cancel/immediate 按钮（实际行为：编辑按钮随执行态移除，而非禁用）
    expect(executingUpdateCall, '任务开始执行后必须发送「已开始执行」卡片').toBeDefined();
    const execCard = executingUpdateCall!.card as Record<string, unknown>;
    const execBody = execCard.body as Record<string, unknown>;
    const execElements = execBody.elements as Array<Record<string, unknown>>;
    const execButtons = execElements.filter((el: Record<string, unknown>) => el.tag === 'button');
    const hasEditButton = execButtons.some((el: Record<string, unknown>) => {
      const behaviors = el.behaviors as Array<Record<string, unknown>> | undefined;
      const value = behaviors?.[0]?.value as Record<string, unknown> | undefined;
      return value?.cmd === 'queue.edit';
    });
    expect(hasEditButton).toBe(false);
    const cancelBtn = execButtons.find((el: Record<string, unknown>) => {
      const value = (el.behaviors as Array<{ value?: Record<string, unknown> }> | undefined)?.[0]
        ?.value;
      return value?.cmd === 'queue.cancel';
    });
    const immediateBtn = execButtons.find((el: Record<string, unknown>) => {
      const value = (el.behaviors as Array<{ value?: Record<string, unknown> }> | undefined)?.[0]
        ?.value;
      return value?.cmd === 'queue.immediate';
    });
    expect(cancelBtn, '执行态卡片必须保留 queue.cancel 按钮').toBeDefined();
    expect(immediateBtn, '执行态卡片必须保留 queue.immediate 按钮').toBeDefined();
    expect(cancelBtn!.disabled).toBe(true);
    expect(immediateBtn!.disabled).toBe(true);

    restoreUpdateCard();
  });
});

describe('anchor: queue diagnose card v2', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-anchor-queue-diag-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(): AppConfig {
    return AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
    });
  }

  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

  it('test_anchor_queue_diagnose_card_must_be_cardkit_2_0', async () => {
    // (red): handleQueueDiagnose 的诊断卡片仍是 CardKit V1 结构
    // （缺 schema:'2.0'，缺 body:{elements}，顶层用 elements）。这是全项目最后一张
    // V1 卡。通过 handleCardAction 触发 queue.diagnose：handleQueueDiagnose 只读取
    // bridge.getQueuedTask / getQueueInfo / getAllActiveRuns，然后用
    // bridge.sendResult 发卡片。我们用一个伪造 bridge 满足这几个 seam，
    // 并捕获 sendResult 收到的诊断卡片做断言。
    const sentCards: object[] = [];
    const fakeBridge = createMockBridge({
      sendResult: async (result: { card?: object }) => {
        if (result.card) sentCards.push(result.card);
        return true;
      },
      getQueuedTask: () => ({
        messageId: 'queued-msg-1',
        messagePreview: 'hello preview',
        text: 'hello',
      }),
      getQueueInfo: () => ({ position: 1, tasksAhead: 0, isRunning: true }),
      getAllActiveRuns: () => new Map(),
    });

    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    const router = new CommandRouter({
      sessionStore,
      bridge: fakeBridge,
      config: makeConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    await router.handleCardAction(
      {
        cmd: 'queue.diagnose',
        cwd: fs.realpathSync(tmpDir),
        messageId: 'queued-msg-1',
        userId: 'user1',
        chatId: 'chat1',
      },
      ctx,
    );

    expect(sentCards.length).toBe(1);
    const card = sentCards[0] as {
      schema?: string;
      body?: { elements?: unknown[] };
      elements?: unknown[];
      config?: { wide_screen_mode?: boolean };
    };
    const cardStr = JSON.stringify(card);

    // 缺陷契约 1：必须含 schema:'2.0'（当前缺 → fail）
    expect(cardStr).toMatch(/"schema"\s*:\s*"2\.0"/);

    // 缺陷契约 2：必须用 body:{elements} 而非顶层 elements（当前用顶层 → fail）
    expect(card.body).toBeDefined();
    expect(Array.isArray(card.body?.elements)).toBe(true);
    expect(card.elements).toBeUndefined();

    // 200861 铁律正则：禁止 V1/V2 混用
    expectNoV1ActionContainer(cardStr);

    // NOTE: wide_screen_mode 是合法 CardKit 2.0 config 字段（/active、/ls、/order 卡
    // 均在 schema:'2.0' 下使用），不是 V1 残留。故不断言 card.config 为 undefined。
    // 真正的缺陷是缺 schema:'2.0' + 缺 body:{elements} + 顶层 elements，已由上面三条断言覆盖。
  });
});
