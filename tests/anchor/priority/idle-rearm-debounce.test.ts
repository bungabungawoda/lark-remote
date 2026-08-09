import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { AgentEvent, Runner } from '../../../src/runner/index.js';

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

// --- Stubs（与 src/bridge/bridge.test.ts 同构的边界替身） ---

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

function createStreamingRunner(events: AgentEvent[]): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      for (const e of events) yield e;
    },
  };
}

/** A runner that yields a few events, then hangs forever until stop() releases it.
 *  Used to test that the idle watchdog still fires after some events were received. */
interface EventThenHangRunner extends Runner {
  stopCalled: boolean;
}
function createEventThenHangRunner(events: AgentEvent[]): EventThenHangRunner {
  let resolveHang: () => void = () => {};
  const hangPromise = new Promise<void>((r) => {
    resolveHang = r;
  });
  const runner: EventThenHangRunner = {
    isRunning: false,
    stopCalled: false,
    stop: async () => {
      runner.stopCalled = true;
      resolveHang();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      for (const e of events) yield e;
      // then hang until stop() releases (simulates a stalled process)
      await hangPromise;
    },
  };
  return runner;
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-idle-rearm-anchor-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'opus', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

function makeBridge(
  opts: {
    runner?: Runner;
    idleTimeoutMs?: number;
    connector?: ReturnType<typeof createStubConnector>;
  } = {},
) {
  const sessionStore = new SessionStore();
  const connector = opts.connector ?? createStubConnector();
  const runner = opts.runner ?? createStreamingRunner([]);
  const bridge = new Bridge({
    runner,
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  });
  return { bridge, sessionStore, connector, runner };
}

/** Build N non-result text events to simulate a high-frequency event stream. */
function makeTextEvents(n: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `chunk ${i}` }] },
    });
  }
  return events;
}

describe('P2-1 idle watchdog re-arm debounce (anchor)', () => {
  /**
   * Anchor (a) — 行为契约：15min 无事件仍必触发看门狗 stop。
   *
   * 验证什么（target）:
   *   事件流中途停滞后，时间推进过 idleTimeoutMs，runner.stop() 必被调用，
   *   卡片显示"已自动终止"。
   *
   * 缺失导致什么（importance）:
   *   若 P2-1 改成 interval 方案时漏掉"事件停滞超时即 stop"语义
   *   （如 interval 间隔设错、或 lastEventTs 未更新），看门狗失效，
   *   串行 queue 永久阻塞（§9.12 原问题回归）。
   *
   * 当前状态：应通过（pin 住行为，防 P2-1 改造时退化）。
   */
  it('anchor: idle watchdog fires runner.stop() after event stream stalls past idleTimeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [
        { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      ];
      const runner = createEventThenHangRunner(events);
      const { bridge, sessionStore, connector } = makeBridge({
        runner,
        idleTimeoutMs: 1000,
      });
      sessionStore.setCwd(ctx.userId, tmpDir);

      const promise = bridge.forwardToClaude('hello', ctx);
      // Advance past the idle timeout; timer fires → stop() → generator completes
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(runner.stopCalled).toBe(true);
      expect(JSON.stringify(connector._cards.at(-1))).toContain('已自动终止');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Anchor (b) — 反退化网：高频事件流下 timer 重建次数远小于事件数。
   *
   * 验证什么（target）:
   *   连续 N 个非-result 事件到来时，全局 setTimeout 调用次数必须远小于 N
   *   （interval 方案 = 1 个 interval，与事件数无关；debounce 方案 ≤ 1 次/秒）。
   *   断言上界 ≤ 8：允许 cardSession 内部少量 timer（start/settle/flush 各 1 次）
   *   + 1 个 interval，但拒绝"每事件 clearTimeout + setTimeout"的 N 次重建。
   *
   * 缺失导致什么（importance）:
   *   现实现每非-result 事件都 clearTimeout + setTimeout（src/bridge/index.ts:832-928），
   *   50 事件/秒 = 50 次 timer 重建 + 50 个闭包/秒。看门狗语义只需"15min 无事件才触发"，
   *   不需要每事件 re-arm。§P2-1 推荐 interval 方案。
   *
   * 当前状态：真红。30 个事件 → 30 次 watchdog setTimeout + ~3 次 cardSession timer
   *           = ~33 次，远超上界 8。
   */
  it('anchor: high-frequency event stream must not re-arm the idle timer per event (setTimeout calls << event count)', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const N = 30;
      const events = makeTextEvents(N);
      const runner = createStreamingRunner(events);
      const { bridge, sessionStore } = makeBridge({
        runner,
        idleTimeoutMs: 60_000, // large so watchdog never fires during the run
      });
      sessionStore.setCwd(ctx.userId, tmpDir);

      const promise = bridge.forwardToClaude('hello', ctx);
      // Let the synchronous event stream drain (microtasks resolve; no time
      // advance needed since push() is fire-and-forget within the coalesce
      // window). Flush any pending timers so settle() completes.
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      const setTimeoutCalls = setTimeoutSpy.mock.calls.length;
      // Upper bound independent of event count: cardSession timers
      // (start timeout, flush timer, settle timeout) ~3 + 1 interval = ~4.
      // Allow headroom to 8. Current per-event re-arm = ~33 → must fail.
      expect(setTimeoutCalls).toBeLessThanOrEqual(8);
      // Sanity: confirm we actually emitted N events (otherwise the bound
      // is trivially satisfied by an empty stream).
      expect(setTimeoutCalls).toBeGreaterThan(0);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
