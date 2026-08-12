import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { _Runner } from '../../../src/runner/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

/**
 * Stub connector whose queue status card send ("⏳ 消息排队中" via
 * sendWithRetry({ card })) stays in flight until the test resolves it. This
 * reproduces the A5 production race: Feishu API latency / 99991400 rate-limit
 * retry keeps the queue card's send promise pending while the running task is
 * stopped and its settle advances the queue chain. Text sends resolve
 * immediately so the router's final confirmation toast never blocks.
 */
function createStubConnectorWithPendingQueueCard() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
  const cards: object[] = [];
  let resolveQueueCardSend: (() => void) | undefined;

  return {
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      const hasCard =
        !!input && typeof input === 'object' && 'card' in (input as Record<string, unknown>);
      if (hasCard) {
        // Queue status card send stays pending until the test releases it.
        return new Promise<string>((resolve) => {
          resolveQueueCardSend = () => resolve('queue-card-msg');
        });
      }
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
    resolveQueueCardSend: () => resolveQueueCardSend?.(),
  };
}

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

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-race-test-'));
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

describe('edited queue.immediate must register its replacement before any awaiting card update', () => {
  it('test_anchor_edited_immediate_replacement_not_lost_to_pending_card_send', async () => {
    // 验证什么行为：用户编辑排队消息 T2（editedMessage='edited message'）后点
    // 「⚡ 立即执行」。T2 的排队卡 send 仍在途（A5 生产竞态：Feishu API 延迟 /
    // 99991400 限流重试，映射 promise 未 resolve）时，被立即执行停掉的当前任务
    // T1 settle，队列链前进到 T2 begin。期望：T2 无论如何必须执行编辑后的内容
    // （'edited message'）——replacement 必须在 handleQueueImmediate 任何可能
    // 阻塞的 await（markQueueCardExecuting 等卡片 promise）之前注册，使 begin
    // 路径总能消费到它。当前实现把 setTaskReplacement 放在 markQueueCardExecuting
    // 之后：mark 卡在挂起的卡片 send 上，T2 已先 begin 且消费不到 replacement，
    // 执行了 enqueue 时冻结的旧闭包（'original message'）。
    //
    // 缺失会导致什么问题：用户看到卡片显示编辑后的内容并点了"您的消息将立即执行"
    // 的承诺，实际运行的却是编辑前的旧消息——与 round 6 修复前 queue-immediate-edited
    // 的 bug 同症状，只是触发条件变成"目标卡片的 send 晚于被停任务 settle"。
    // 若编辑内容是对危险命令的修正（删参数/改路径），修正不会生效，副作用按旧
    // 内容执行；且 setTaskReplacement 在 begin 之后注册，replacement 永远不会被
    // 消费（一次性、无归属清理），taskReplacements 泄漏一条死闭包。
    //
    // 依据：round 6 确立的编辑+立即执行契约（A7 anchor / queue-immediate-edited
    // 测试：编辑后的任务必须执行编辑后内容）；router handleQueueImmediate 注释
    // 步骤 5 "If the user edited the message, the original closure ... must NOT
    // run"。该契约不能依赖卡片 send 的完成时序——A5 已证明 send 可晚于任务接跑，
    // 契约必须对任何 send 时序成立。
    const connector = createStubConnectorWithPendingQueueCard();
    const sessionStore = new SessionStore();
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

    // Spy forwardToClaude（mock 掉真实 spawn，捕获调用参数与顺序）。
    const fwdSpy = vi.spyOn(bridge, 'forwardToClaude').mockResolvedValue(undefined);

    // --- 步骤 1：T1 挂起，阻塞队列链（raw hang，不进 activeRuns）---
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
    await sleep(50);

    // --- 步骤 2：T2（编辑目标）排队，闭包冻结原始内容；排队卡 send 挂起 ---
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
    // 等 T2 的排队卡 send 已注册（映射为挂起 promise）
    expect(await waitFor(() => connector._sent.length === 1)).toBe(true);

    // --- 步骤 3：编辑 T2 → 'edited message' ---
    await router.handleCardAction(
      { cmd: 'queue.edit', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // --- 步骤 4：fire-and-forget 触发 queue.immediate（不 await）---
    // handleQueueImmediate 会停在 markQueueCardExecuting → await 挂起的卡片 send。
    const immediatePromise = router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    await sleep(50);

    // --- 步骤 5：此时放行 T1 —— 队列链前进到 T2 begin ---
    // 当前实现：replacement 尚未注册（markQueueCardExecuting 还在等卡片 send），
    // T2 begin 消费不到 replacement → 执行旧闭包 'original message'。
    release1();
    expect(await waitFor(() => fwdSpy.mock.calls.length >= 1)).toBe(true);

    // --- 步骤 6：卡片 send 此刻才完成，mark 路径继续 → setTaskReplacement 太迟注册 ---
    connector.resolveQueueCardSend();
    await immediatePromise;
    await sleep(20);

    const calls = fwdSpy.mock.calls.map((c) => c[0] as string);
    // 当前实现：calls = ['original message']（旧闭包先跑，编辑内容从未执行）。
    // 这里必须真红：期望编辑后的内容执行，且旧内容不得执行。
    expect(calls).toEqual(['edited message']);
  });
});
