import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner } from '../../../src/runner/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
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

/** Same stub connector pattern as tests/anchor/queue-card-arm/queue-card-arm-edit-immediate-order.test.ts. */
function createStubConnector() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-began-test-'));
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
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.immediate must not remove tasks queued BEHIND the target when the target began while the stop was in flight', () => {
  it('test_anchor_immediate_target_began_keeps_tasks_behind_target', async () => {
    // 验证什么行为：用户对排队任务 T2 点「⚡ 立即执行」后，handleQueueImmediate
    // 在 `await interruptCurrentRun` 期间队列链前进（T1 结束、T2 的槽位 begin 并
    // 从 queuedTasks 移除、T2 开始执行）；stop 恢复后，步骤 3 的"清除目标任务之前
    // 消息"循环必须仍然只删除 T2 **之前**的任务——T3（排在 T2 之后）必须原样保留
    // 排队状态，绝不能因目标任务已不在队列快照里而被一并撤销。
    //
    // 缺失会导致什么问题：步骤 3 的循环 `for (task of tasks) { if (task.messageId
    // === messageId) break; ... }` 只在快照里**遇到目标任务**时才 break。若 T2 在
    // interrupt 挂起期间已经 begin（被移除），快照里没有 messageId 可命中，循环
    // 把**剩余全部**排队任务都 removeFromQueue——包括排在 T2 之后的 T3/T4。用户
    // 没撤销过 T3，却收到"❌ 已撤销"卡片，T3 永远不执行；toast 还报告
    // "清除了 N 条排队消息"（N 含目标之后的消息），与 A8 锚点确立的不变量
    // （"立即执行只清除目标任务之前的消息，之后的保持原相对顺序"）直接冲突。
    // 该竞态是真实可达的：handleQueueImmediate 自身注释明确承认 "The queue chain
    // can advance while later awaits (interruptCurrentRun / markQueueCardExecuting's
    // card send) are in flight"；生产上 runner.stop 与卡片 finish 均含 Feishu API
    // 往返，进程退出到 handler 恢复之间的窗口足以让目标任务 begin。
    //
    // 依据：router handleQueueImmediate 步骤 3 注释 "Remove all tasks BEFORE this
    // one (by messageId, not index)"——语义边界是"目标之前"；A8 锚点
    // (queue-card-arm-edit-immediate-order) 已确立 T3 保持原相对顺序、
    // 不得先于或替代目标被清除。步骤 4 注释 "DO NOT remove the target task" 同样
    // 只豁免目标本身，未授权清除目标之后的任务。
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

    // --- 步骤 1：T1（meta，挂起）开始执行，阻塞队列 ---
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

    // --- 步骤 2：T2（目标任务，挂起）与 T3（排在 T2 之后）依次排队 ---
    let release2: () => void = () => {};
    const hang2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    let t2Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t2Started = true;
        await hang2;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'task 2 immediate target',
        },
      },
    );
    bridge.enqueue(
      tmpDir,
      async () => {
        // T3 应保持排队；本闭包不应执行
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 queued behind target',
        },
      },
    );
    await sleep(100);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeDefined();
    expect(bridge.getQueuedTask(tmpDir, 'msg-3')).toBeDefined();

    // --- 步骤 3：挂起 interruptCurrentRun（模拟 runner.stop / 卡片 finish 在途，
    // 即 A5/A9 同类生产竞态：外部停止操作尚未返回，队列链已可前进）---
    let resolveStop: (v: boolean) => void = () => {};
    const stopInFlight = new Promise<boolean>((resolve) => {
      resolveStop = resolve;
    });
    const stopSpy = vi.spyOn(bridge, 'interruptCurrentRun').mockReturnValue(stopInFlight);

    // --- 步骤 4：触发「立即执行」（不 await，让它停在 interrupt 挂起点）---
    const immediateDone = router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-2' },
      ctx,
    );
    expect(await waitFor(() => stopSpy.mock.calls.length === 1)).toBe(true);

    // --- 步骤 5：队列链前进：T1 结束 → T2 begin（从 queuedTasks 移除、执行中挂起）---
    release1();
    expect(await waitFor(() => t2Started)).toBe(true);
    expect(bridge.getQueuedTask(tmpDir, 'msg-2')).toBeUndefined(); // T2 已开始执行
    expect(bridge.getQueuedTask(tmpDir, 'msg-3')).toBeDefined(); // T3 仍在排队（T2 之后）

    // --- 步骤 6：stop 此刻完成，handler 恢复并执行步骤 3 的清除循环 ---
    resolveStop(true);
    await immediateDone;

    // 当前实现：快照 [msg-3] 中没有 msg-2 可 break → T3 被 removeFromQueue 误删。
    // 这里必须真红（期望 T3 仍在排队，因为它排在目标任务**之后**）。
    expect(bridge.getQueuedTask(tmpDir, 'msg-3')).toBeDefined();

    // --- 清理：放行 T2，让队列链自然收尾 ---
    release2();
    await sleep(50);
  });
});
