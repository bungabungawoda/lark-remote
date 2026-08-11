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

/**
 * Stub connector whose card PATCH (`updateCard`) stays in flight until the
 * test releases it. This reproduces the production race where a Feishu card
 * update API round trip (updateQueueCardToCancelled → connector.updateCard)
 * yields to the event loop while the serial queue chain advances.
 */
function createStubConnectorWithGatedCardUpdate() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
  const cards: object[] = [];
  const updateCalls: string[] = [];
  const gateResolvers: Array<() => void> = [];

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
      const header = (card as { header?: { title?: { content?: string } } }).header;
      updateCalls.push(header?.title?.content ?? '');
      // Block the card PATCH until the test releases it.
      await new Promise<void>((resolve) => gateResolvers.push(resolve));
      cards.push(card);
    },
    connected: true,
    _sent: sent,
    _cards: cards,
    _updateCalls: updateCalls,
    // Resolve ALL parked card updates: with the fix, several updateCard calls
    // (cancelled A/B cards + the target's executing card, incl. the begin-path
    // update) can be parked concurrently; a single-last-resolver gate would
    // leave the handler awaiting an older gate forever.
    releaseCardGate: () => {
      for (const resolve of gateResolvers.splice(0)) resolve();
    },
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-clear-yield-'));
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

describe('queue.immediate must clear EVERY task before the target before yielding to card updates', () => {
  it('test_anchor_immediate_task_before_target_not_running_ahead_while_removal_card_update_in_flight', async () => {
    // 验证什么行为：队列 [T1执行中, A, B, T目标] 上用户对 T 点「⚡ 立即执行」。
    // handleQueueImmediate 步骤 3 的快照 [A, B, T] 中 T 在中间，清除循环先
    // removeFromQueue(A) 成功，然后 `await updateQueueCardToCancelled(A)`
    // （Feishu 卡片 PATCH 往返）让出事件循环。此时 T1 恰好结束，串行队列链
    // 前进：A 的槽位（已被移除）跳过，**B 的槽位仍持有元数据 → B 开始执行**。
    // 期望：排在目标任务**之前**的 B 必须被清除、不得先于 T 执行——步骤 3 的
    // 语义是"Remove all tasks BEFORE this one"，B 属于被清除集合；清除动作
    // 必须在任何 await 之前完成（removeFromQueue 是同步的），不能让卡片更新
    // 往返给排在目标之前的任务留出抢先执行的窗口。
    //
    // 缺失会导致什么问题：当前实现把 `await updateQueueCardToCancelled` 放在
    // 移除循环内部，B 在 A 的卡片更新在途期间接跑：①用户明确要求清除的
    // B 实际执行了——与 A8 锚点确立的不变量（立即执行只清除目标之前的任务、
    // 目标随后执行）直接冲突；②步骤 4.5 仍把 T 的排队卡翻成
    // "▶️ 已开始执行"、toast 承诺"您的消息将立即执行"，而 T 实际还排在正在
    // 执行的 B 后面——卡片与 toast 双双撒谎，用户没有可用的补救入口
    // （T 的按钮已禁用）；③B 本应被撤销却收到了自己的 "已开始执行" 卡
    // （B 的 begin 路径照常发执行卡），同一张卡从"排队中"跳成"执行中"，
    // 与用户点击立即执行时的意图相反。该竞态在生产上真实可达：步骤 3 的
    // 注释自己承认 "The chain advances concurrently"，而 interruptCurrentRun
    // 停止的进程退出到队列链 settle 之间的窗口恰与卡片 PATCH 往返重叠。
    //
    // 依据：router handleQueueImmediate 步骤 3 注释 "Remove all tasks BEFORE
    // this one (by position in the current queue)"——B 在快照中位于 T 之前，
    // 属于必须清除的集合；步骤 4 注释 "The queue will naturally execute it
    // after the current task (which we just stopped)"——目标 T 是停止后下一个
    // 执行的任务，B 抢先执行违反该顺序承诺；A8 锚点
    // (queue-card-arm-edit-immediate-order) 已确立目标任务之前的
    // 任务全部清除、目标保持位置的排序契约。
    const sessionStore = new SessionStore();
    const connector = createStubConnectorWithGatedCardUpdate();
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
    let releaseT1: () => void = () => {};
    const hangT1 = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    let t1Started = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        t1Started = true;
        await hangT1;
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

    // --- 步骤 2：A（目标之前）、B（目标之前）、T（目标）依次入队挂起 ---
    let releaseA: () => void = () => {};
    const hangA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hangA;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'mA',
          messagePreview: 'A before target',
        },
      },
    );
    let releaseB: () => void = () => {};
    const hangB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let bStarted = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        bStarted = true;
        await hangB;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'mB',
          messagePreview: 'B before target',
        },
      },
    );
    let releaseT: () => void = () => {};
    const hangT = new Promise<void>((resolve) => {
      releaseT = resolve;
    });
    let tStarted = false;
    bridge.enqueue(
      tmpDir,
      async () => {
        tStarted = true;
        await hangT;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'mT',
          messagePreview: 'T immediate target',
        },
      },
    );
    await sleep(50);
    expect(bridge.getQueuedTask(tmpDir, 'mA')).toBeDefined();
    expect(bridge.getQueuedTask(tmpDir, 'mB')).toBeDefined();
    expect(bridge.getQueuedTask(tmpDir, 'mT')).toBeDefined();

    // --- 步骤 3：触发「立即执行」（不 await）；让它在卡片更新处挂起 ---
    const immediateDone = router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'mT' },
      ctx,
    );
    // 修复后：步骤 3 先同步移除 A、B（目标之前的全部任务，不 await），再发
    // 撤销卡（被 gate 卡住）；观察点 = A、B 均已被移除（不依赖被 gate 阻塞的
    // 卡片更新计数）。若 B 此时仍在队列，说明清除被卡片更新 await 打断，
    // B 会在 T1 结束后抢先执行（原缺陷）。
    expect(
      await waitFor(
        () =>
          bridge.getQueuedTask(tmpDir, 'mA') === undefined &&
          bridge.getQueuedTask(tmpDir, 'mB') === undefined,
      ),
    ).toBe(true);
    expect(bridge.getQueuedTask(tmpDir, 'mB')).toBeUndefined();

    // --- 步骤 4：T1 结束，队列链前进（A/B 槽位均已移除，被取消检查跳过）---
    releaseT1();
    // 等队列链前进到观察点：目标之前任务已全部清除，T 应为停止后下一个执行。
    expect(await waitFor(() => bStarted || tStarted)).toBe(true);
    // B（目标之前、用户要求清除的任务）不得开始执行，T 才是停止后下一个执行。
    expect(bStarted).toBe(false);
    expect(tStarted).toBe(true);

    // --- 步骤 5：放行卡片更新，让 immediate 处理完成；T 自然收尾 ---
    connector.releaseCardGate();
    await immediateDone;
    releaseB();
    releaseT();
    releaseA();
    await sleep(50);
  });
});
