import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentEvent, Runner, SpawnOptions } from '../../../src/runner/index.js';

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

function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
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
    updateCard: async () => {},
    connected: true,
    _sent: sent,
  };
}

/** Runner that yields events then hangs until stop() releases it. */
function createBackgroundRunningRunner(
  events: AgentEvent[],
  runs: { message: string; cwd: string }[],
): Runner & { release: () => void } {
  let releaseRun: () => void = () => {};
  const waitForRelease = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  return {
    isRunning: false,
    stop: async () => {
      releaseRun();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* (message: string, opts: SpawnOptions) {
      runs.push({ message, cwd: opts.cwd });
      for (const e of events) yield e;
      await waitForRelease;
    },
    release: releaseRun,
  };
}

describe('P1-14 queue lane vs execution cwd', () => {
  afterEach(() => {
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('test_anchor_queued_message_not_busy_dropped_after_cd', async () => {
    // ① 验证什么行为：消息入队时（lane）的 workspace 就是它执行时的 workspace；
    //    排队期间 /cd 切换 cwd 后，旧 lane 的排队消息不得被 busy-drop（执行顺序
    //    与「消息将按顺序执行」的排队卡承诺保持一致）。
    // ② 缺失/错误会导致什么：lane 按入队时 cwd、执行时重新 resolveCwd 取新 cwd，
    //    两条旧/新 lane 变并行且都 resolve 到新 cwd → 先到者占 activeRuns、
    //    后到者命中 busy-drop「此 workspace 正在处理中」→ 消息静默丢失，
    //    且执行顺序不再保证。
    // ③ 依据：review.md §P1-14「普通消息入队时 lane = 当时的 sessionStore cwd…
    //    任务真正执行时 forwardToClaude 重新 resolveCwd…拿到的是新 cwd…
    //    M2 的排队卡之前已承诺『消息将按顺序执行』——消息实际丢失」。
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-14-lane-a-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-14-lane-b-'));
    const runs: { message: string; cwd: string }[] = [];
    const blocker = createBackgroundRunningRunner([], runs);
    try {
      const config: AppConfig = AppConfigSchema.parse({
        feishu: { appId: 'test', appSecret: 'test' },
        claude: { model: 'opus', stopGraceMs: 5000 },
        workspace: { default: '' },
        output: { showThinking: true, showToolUse: false, showToolResult: false },
      });
      const sessionStore = new SessionStore();
      const connector = createStubConnector();
      const bridge = new Bridge({
        runner: blocker,
        agentRegistry: createStubAgentRegistry(blocker),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        connector,
        sessionStore,
        config,
      });

      const ctx = (messageId: string) => ({ userId: 'u1', chatId: 'c1', messageId });

      // M1 在 cwd=tmpA 时入队（lane = tmpA）
      sessionStore.setCwd('u1', tmpA);
      bridge.enqueue(tmpA, () => bridge.forwardToClaude('M1', ctx('m1'), { cwdOverride: tmpA }));

      // 模拟 /cd tmpB（斜杠命令绕过队列立即生效）
      sessionStore.setCwd('u1', tmpB);

      // M2 在 cwd=tmpB 时入队（lane = tmpB）
      bridge.enqueue(tmpB, () => bridge.forwardToClaude('M2', ctx('m2'), { cwdOverride: tmpB }));

      // 等两个 lane 的任务都 begin（promise 链微任务）
      await new Promise((r) => setTimeout(r, 300));

      const drops = connector._sent.filter((m) =>
        String((m.input as Record<string, unknown> | undefined)?.text ?? '').includes('正在处理中'),
      );
      expect(drops).toHaveLength(0);
      // lane 与执行 cwd 必须同源：M1（入队时 tmpA）跑在 tmpA，M2（入队时 tmpB）
      // 跑在 tmpB —— 光「不丢消息」不够，把两条消息串到同一条 lane 的退化实现
      // 也会不丢消息，但会破坏多 workspace 并行与 lane 语义。
      expect(runs.map((r) => [r.message, r.cwd])).toEqual([
        ['M1', tmpA],
        ['M2', tmpB],
      ]);
    } finally {
      blocker.release();
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});
