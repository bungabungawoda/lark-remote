import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner, AgentRunner } from '../../../src/runner/index.js';
import { AgentRegistry } from '../../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

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

/**
 * A runner whose run() hangs forever until stop() releases it — faithful to a
 * real runner holding a live subprocess that only exits when stop() kills it.
 * Each instance counts its own stop() calls so the test can distinguish which
 * workspace's run was stopped (same pattern as
 * tests/bridge/bridge-clear-runners-active-run.test.ts).
 */
interface TrackingHangingRunner extends Runner {
  stopCalls: number;
}

function createTrackingHangingRunner(): TrackingHangingRunner & AgentRunner {
  let release!: () => void;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: TrackingHangingRunner & AgentRunner = {
    isRunning: false,
    stopCalls: 0,
    stop: async () => {
      runner.stopCalls++;
      // Resolving the hang simulates the subprocess being killed and the run()
      // generator settling — which is what unblocks the workspace's queue chain.
      release();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      await hang;
    },
    kind: 'claude',
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: 'claude', model: 'test' }),
  };
  return runner;
}

function createStubConnector() {
  const sent: Array<{ chatId: string; input: unknown; opts?: unknown }> = [];
  const cards: object[] = [];
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
        update(next: object | ((current: object) => object)): Promise<void>;
      }) => Promise<void>,
    ) => {
      sent.push({ chatId, input: { card: initial }, opts: undefined });
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

let tmpDir: string;
let ws1: string;
let ws2: string;
let config: AppConfig;

beforeEach(() => {
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-ws-test-'));
  ws1 = path.join(tmpDir, 'ws1');
  ws2 = path.join(tmpDir, 'ws2');
  fs.mkdirSync(ws1);
  fs.mkdirSync(ws2);
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    defaultAgent: 'claude',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.immediate must stop the run blocking the SAME workspace, not a parallel run in another workspace', () => {
  it('test_anchor_queue_immediate_stops_run_blocking_same_workspace', async () => {
    // 验证什么行为：同一用户在两个 workspace 并行各有一个活跃 run（Bridge 明确
    // 支持："Multiple workspaces can have runs in parallel"，activeRuns 按 cwd
    // 键控、interruptCurrentRun 按 (userId, chatId) 匹配）。用户在 ws2 的排队卡
    // 上点「⚡ 立即执行」（卡片 payload 带 workspace=ws2、目标任务在 ws2 队列里），
    // 期望：被停止的必须是 ws2 队列头部正在运行的 R2（阻塞目标任务的 run），
    // ws1 的并行 run R1 必须原样继续执行；随后 ws2 队列链前进，目标任务立即接跑。
    //
    // 缺失会导致什么问题：handleQueueImmediate 调 interruptCurrentRun 时不传
    // workspace/runId，interruptCurrentRun 遍历 activeRuns（Map 按 cwd 插入序），
    // 命中第一个 (userId, chatId) 匹配的活跃 run——即先启动的 ws1 的 R1。于是
    // 「立即执行」停掉了**另一个 workspace** 的无关任务：①R1 的现场被毁
    // （用户另一个正在执行的任务被 SIGKILL）；②真正阻塞 ws2 队列的 R2 没被停，
    // 目标消息不会"立即执行"——卡片已被 markQueueCardExecuting 翻成
    // "▶️ 已开始执行"（按钮禁用、无法撤销），toast 承诺"您的消息将立即执行"，
    // 实际 ws2 队列仍被 R2 阻塞，目标任务遥遥无期；用户看到执行中卡片却收不到
    // 结果，且没有可用的停止入口（按钮已禁用、/stop 会再次命中错误的 run）。
    // 这是 round 6/7 引入 replacement 原位替换后仍存在的 workspace 维度串扰。
    //
    // 依据：router handleQueueImmediate 文档注释——"Stop current run, clear
    // queue before this message, execute this message immediately"；"current
    // run" 的上下文是卡片所在 workspace 的串行队列（queue-manager 按 workspace
    // 分队列、Bridge 注释 "Each workspace has its own serial queue for parallel
    // execution across workspaces"）。卡片回调 value 携带 workspace 正是用来
    // 标识队列身份；立即执行清的是该 workspace 队列中目标任务**之前**的任务，
    // 停的也必须是该 workspace 当前执行的任务，否则"立即执行"的承诺对象与实际
    // 副作用对象不一致。
    const created: TrackingHangingRunner[] = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createTrackingHangingRunner();
      created.push(r);
      return r;
    });

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner: createTrackingHangingRunner(), // fallback, unused (registry path)
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      idleTimeoutMs: 0,
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
    let run1Done: Promise<void> = Promise.resolve();
    let run2Done: Promise<void> = Promise.resolve();
    let t2Ran = false;

    try {
      // --- 步骤 1：ws1 先启动一个并行 run R1（经队列链，计数=1）---
      sessionStore.setCwd('u1', ws1);
      bridge.enqueue(
        ws1,
        async () => {
          run1Done = bridge.forwardToClaude('run in ws1', ctx);
          await run1Done;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm-r1',
            messagePreview: 'R1 running in ws1',
          },
        },
      );
      expect(await waitFor(() => created.length >= 1 && bridge.isBusyFor(ws1))).toBe(true);
      const runner1 = created[0];

      // --- 步骤 2：用户 /cd 到 ws2 并启动并行 run R2（阻塞 ws2 队列）---
      sessionStore.setCwd('u1', ws2);
      bridge.enqueue(
        ws2,
        async () => {
          run2Done = bridge.forwardToClaude('run in ws2', ctx);
          await run2Done;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm-r2',
            messagePreview: 'R2 running in ws2',
          },
        },
      );
      expect(await waitFor(() => created.length >= 2 && bridge.isBusyFor(ws2))).toBe(true);
      const runner2 = created[1];

      // --- 步骤 3：ws2 中排入目标消息 T2（拿到排队卡）---
      bridge.enqueue(
        ws2,
        async () => {
          t2Ran = true;
        },
        {
          taskMeta: {
            userId: 'u1',
            chatId: 'c1',
            messageId: 'm-target',
            messagePreview: 'target queued in ws2',
          },
        },
      );
      expect(await waitFor(() => bridge.getQueuedTask(ws2, 'm-target') !== undefined)).toBe(true);

      // --- 步骤 4：对 ws2 的排队卡点「⚡ 立即执行」---
      await router.handleCardAction(
        { cmd: 'queue.immediate', workspace: ws2, messageId: 'm-target' },
        ctx,
      );
      await sleep(50);

      // 当前实现：interruptCurrentRun 先命中 activeRuns 里的 ws1 run（Map 插入序
      // ws1 在前），runner1.stopCalls=1、runner2.stopCalls=0；ws1 被误停、
      // ws2 的阻塞 run 仍在。以下断言在正确实现下应全绿、当前实现必须真红。
      expect(runner1.stopCalls).toBe(0); // ws1 的并行 run 不得被停
      expect(runner2.stopCalls).toBe(1); // 阻塞 ws2 队列的 run 必须被停
      expect(bridge.isBusyFor(ws1)).toBe(true); // ws1 任务继续运行
      expect(bridge.isBusyFor(ws2)).toBe(false); // ws2 阻塞任务已停

      // --- 步骤 5：ws2 队列链前进，目标任务立即接跑（"您的消息将立即执行"）---
      expect(await waitFor(() => t2Ran)).toBe(true);
    } finally {
      // 清理：无论断言成败，停掉剩余活跃 run，让两条队列链 settle，避免悬空 promise。
      await bridge.interruptCurrentRun({ userId: 'u1', chatId: 'c1' });
      await Promise.allSettled([run1Done, run2Done]);
      await sleep(50);
    }
  });
});
