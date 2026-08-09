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
  const cards: object[] = [];
  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined });
      return 'file-msg-id';
    },
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async (
      chatId: string,
      initial: object,
      producer: (controller: {
        messageId: string;
        current: object;
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
      opts?: unknown,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts });
      cards.push(initial);
      let current = initial;
      await producer({
        messageId: 'stream-msg-id',
        get current() {
          return current;
        },
        update: async (next) => {
          current = typeof next === 'function' ? next(current) : next;
          cards.push(current);
        },
      });
      return 'stream-msg-id';
    },
    updateCard: async (_messageId: string, card: object) => {
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
  };
}

function createStubRunner(): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      throw new Error('run not expected in stub');
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-edit-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      binary: 'claude',
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

describe('queue.immediate after edit uses edited content', () => {
  it('test_anchor_immediate_after_edit_forwards_edited_message', async () => {
    // Bug: 编辑排队消息后点「立即执行」，实际跑的是编辑前的旧内容。
    // 根因：task 闭包在 enqueue 时冻结原始 message（"original message"），
    // updateQueuedTaskMessage 只改 messagePreview（显示层），handleQueueImmediate
    // 走原逻辑让旧闭包自然执行 -> forwardToClaude("original message")。
    // 修复：QueuedTask 加 editedMessage；updateQueuedTaskMessage 同步写入；
    // handleQueueImmediate 检测 editedMessage -> removeFromQueue(旧闭包靠
    // stillQueued 守卫跳过) + 重新 enqueue 新内容闭包（新 messageId 避免旧闭包
    // stillQueued 命中新任务）。

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

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // Spy forwardToClaude (mock to avoid real spawn; captures the message arg).
    // Set up before any closure runs (closures call bridge.forwardToClaude at
    // execution time, so the spy captures whenever they run).
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);

    // Task 1: hang (blocks the queue so task 2 queues)
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
          messageId: 'msg-1',
          messagePreview: 'task 1 running',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    // Task 2: queued behind task 1. Its closure runs the ORIGINAL content
    // ("original message") - simulating the production closure that captures
    // msg.content at enqueue time. Without the fix this closure runs after
    // immediate, forwarding the stale content.
    bridge.enqueue(
      tmpDir,
      async () => {
        await bridge.forwardToClaude('original message', ctx);
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'original message',
        },
      },
    );
    await new Promise((r) => setTimeout(r, 100));

    // Edit msg-2 -> "edited message"
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // Click ⚡ 立即执行
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );

    // Release task 1 -> queue advances. With the fix: old msg-2 closure skips
    // (removed from queue -> stillQueued guard), new closure runs
    // forwardToClaude("edited message").
    release1();
    await new Promise((r) => setTimeout(r, 300));

    const calls = fwdSpy.mock.calls.map((c) => c[0] as string);

    // Assert: forwardToClaude called with edited content
    expect(calls).toContain('edited message');

    // NOT called with original content (old closure must be skipped)
    expect(calls).not.toContain('original message');
  });
});
