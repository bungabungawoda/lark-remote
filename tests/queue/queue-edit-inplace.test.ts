import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const updateCardCalls: { messageId: string; card: object }[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async (
      chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update: (next: object) => Promise<void>;
      }) => Promise<void>,
      opts?: unknown,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts });
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async (messageId: string, card: object) => {
      updateCardCalls.push({ messageId, card });
    },
    connected: true,
    _sent: sent,
    _updateCardCalls: updateCardCalls,
  };
}

function createStubRunner(): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      throw new Error('run not expected');
    },
  };
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  // 重置 mock
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-edit-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Set up: task-1 hangs (blocks queue), task-2 is queued behind it. */
async function setupQueuedTask(bridge: Bridge, queuedMessageId: string, preview: string) {
  let release1: () => void = () => {};
  const hang1 = new Promise<void>((resolve) => {
    release1 = resolve;
  });
  bridge.enqueue(
    tmpDir,
    async () => {
      await hang1;
    },
    {
      taskMeta: {
        userId: 'u1',
        chatId: 'c1',
        messageId: 'msg-1-blocking',
        messagePreview: 'blocking task',
      },
    },
  );
  await new Promise((r) => setTimeout(r, 50));
  bridge.enqueue(
    tmpDir,
    async () => {
      /* quick */
    },
    {
      taskMeta: { userId: 'u1', chatId: 'c1', messageId: queuedMessageId, messagePreview: preview },
    },
  );
  await new Promise((r) => setTimeout(r, 100));
  return release1;
}

describe('queue.edit 原地更新修复', () => {
  it('test_anchor_queueEdit_uses_input_with_default_value_and_behaviors', async () => {
    // Bug: queue.edit 的 input 用了 `value` + 独立 button（button 上 behaviors）
    // 这导致飞书 callback 不回传 input 值 -> "缺少新消息内容"
    // 预期：input 应使用 default_value + 自带 behaviors（对齐 config.input）

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const release = await setupQueuedTask(bridge, 'msg-2', 'original message');

    // 触发编辑
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
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

    release();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('test_anchor_queueInput_succeeds_with_inputValue', async () => {
    // 完整流程：编辑 -> 提交新内容 -> 消息预览更新
    // 验证 queue.input 能正确读取 inputValue（由 index.ts 从 raw.action.input_value 提取）

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const release = await setupQueuedTask(bridge, 'msg-2', 'original message');

    // 1. 点击编辑
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
    );

    // 2. 模拟 input ✓ 提交图标回调：index.ts 从 action.raw.action.input_value 提取
    //    （SDK normalizer 丢弃，需 connector includeRawEvent: true）后传给 router 的 inputValue
    const updateSpy = vi.spyOn(bridge, 'updateMessagePreview');
    await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited content' },
      { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
    );

    // 验证消息已更新
    expect(updateSpy).toHaveBeenCalledWith(tmpDir, 'msg-2', 'edited content');

    // 验证任务预览已更新
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task?.messagePreview).toBe('edited content');

    release();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('test_anchor_queueEdit_uses_updateCardInPlace_not_new_card', async () => {
    // Bug: handleQueueEdit 用 sendResult 发送新卡片
    // 预期：使用 updateCardInPlace 原地更新原卡片

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    const release = await setupQueuedTask(bridge, 'msg-2', 'original message');

    // 监视 updateCardInPlace
    const updateInPlaceSpy = vi.spyOn(bridge, 'updateCardInPlace');
    const sendResultSpy = vi.spyOn(bridge, 'sendResult');

    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' },
    );

    // 验证：应该调用 updateCardInPlace（而不是只调用 sendResult 发新卡片）
    expect(updateInPlaceSpy).toHaveBeenCalledTimes(1);

    // sendResult 不应该被直接调用（updateCardInPlace 内部 fallback 才会调）
    // 即 handleQueueEdit 不应该直接调用 sendResult
    expect(sendResultSpy).not.toHaveBeenCalled();

    release();
    await new Promise((r) => setTimeout(r, 100));
  });
});
