import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner, AgentRunner } from '../../src/runner/index.js';
import { AgentRegistry } from '../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

/**
 * A runner whose run() hangs forever until stop() releases it -- faithful to a
 * real SpawningRunner holding a live subprocess that only exits when stop()
 * signals/kills it. Each instance counts its own stop() calls so the test can
 * distinguish "the real running runner A" from "a fresh empty runner B" that
 * getRunner creates after clearRunners() emptied the cache.
 */
interface TrackingHangingRunner extends Runner {
  stopCalls: number;
}

function createTrackingHangingRunner(): TrackingHangingRunner & AgentRunner {
  let release!: () => void;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  // NOTE: do NOT spread this object later — `stop` closes over `runner` and
  // mutating `runner.stopCalls` must be visible through the same reference the
  // test reads. Spread would copy stopCalls=0 and break the assertion.
  const runner: TrackingHangingRunner & AgentRunner = {
    isRunning: false,
    stopCalls: 0,
    stop: async () => {
      runner.stopCalls++;
      // Resolving the hang simulates the subprocess being killed and the
      // run() generator settling -- which is what unblocks the queue chain.
      release();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      // Never yields until stop() releases the hang (mimics a live subprocess).
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
let config: AppConfig;

beforeEach(() => {
  // 重置 mock
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-clear-active-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'claude',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Bridge clearRunners must not orphan an ACTIVE runner (regression 2026-07-18)', () => {
  /**
   * Anchor: interruptCurrentRun after clearRunners must stop the REAL runner.
   *
   * Target: when bridge.clearRunners() empties the runner cache while a run is
   * in progress (the production trigger is `/config` save with an agent-config
   * change), interruptCurrentRun must still stop the runner instance that
   * actually owns the live subprocess -- not a fresh empty runner that
   * getRunner(cwd) newly creates from the cleared cache.
   *
   * Importance: if the fresh runner's stop() is a no-op (no currentProcess), the
   * real subprocess is never killed, its run() promise never settles, and the
   * serial queue chain blocks forever. This was the 2026-07-18 production
   * deadlock: /ps showed "无进程在跑" (activeRuns cleared) yet every message
   * queued indefinitely and "立即执行" returned stopped=false.
   *
   * Fix basis: activeRun must carry a direct reference to the runner instance
   * that is running; interruptCurrentRun stops THAT instance, independent of
   * the runners cache state.
   */
  it('test_anchor_interrupt_after_clearRunners_stops_the_real_running_runner', async () => {
    const created: TrackingHangingRunner[] = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createTrackingHangingRunner();
      created.push(r);
      return r;
    });

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', tmpDir);
    const bridge = new Bridge({
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    // 1. Start a run; do NOT await (it hangs). getRunner caches runner A.
    const runPromise = bridge.forwardToClaude('do work', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    // Wait for runner A to be created and its run() to start hanging.
    // 使用 bun 兼容的轮询替代 vi.waitFor
    for (let i = 0; i < 50 && created.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
    const runnerA = created[0];
    expect(runnerA.stopCalls).toBe(0);

    // 2. config.save with an agent-config change triggers clearRunners() --
    //    this orphans runner A from the runners cache while it is still running.
    bridge.clearRunners();

    // 3. User clicks stop -> interruptCurrentRun re-resolves the runner.
    const stopped = await bridge.interruptCurrentRun({
      userId: 'user1',
      chatId: 'chat1',
    });
    expect(stopped).toBe(true);

    // 4. THE BUG: the REAL running runner A must have been stopped. Before the
    //    fix, getRunner created a fresh empty runner B and stop() was a no-op on
    //    B, leaving runner A (and its subprocess) alive forever.
    expect(runnerA.stopCalls).toBe(1);

    // 5. run() must settle (subprocess killed) so the queue chain unblocks.
    await runPromise;
  });

  /**
   * Anchor: clearRunners() must not evict a runner whose workspace has an
   * active run in progress.
   *
   * Target: when config.save triggers clearRunners() while a run is active,
   * the running runner must remain the cached instance for that workspace, so
   * any getRunner(cwd) call during the run (e.g. /status, or a second stop)
   * resolves to the SAME runner that owns the live subprocess.
   *
   * Importance: evicting it creates an orphan and makes getCurrentRunner return
   * a fresh empty runner (wrong agent/config) mid-run. Paired with the
   * interrupt anchor above, this is defense-in-depth: the cache stays coherent
   * so the orphan never forms in the first place.
   *
   * Fix basis: clearRunners() skips workspaces present in activeRuns.
   */
  it('test_anchor_clearRunners_preserves_active_runner_in_cache', async () => {
    const created: TrackingHangingRunner[] = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const r = createTrackingHangingRunner();
      created.push(r);
      return r;
    });
    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    sessionStore.setCwd('user1', tmpDir);
    const bridge = new Bridge({
      connector,
      sessionStore,
      config,
      agentRegistry: reg,
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    // Start a hanging run -> runner A created, cached, and active.
    const runPromise = bridge.forwardToClaude('hang', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });
    // 使用 bun 兼容的轮询替代 vi.waitFor
    for (let i = 0; i < 50 && created.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
    const runnerA = created[0];
    expect(bridge.isBusyFor(tmpDir)).toBe(true);

    // Before clearRunners, the cached runner is A.
    expect(bridge.getCurrentRunner(tmpDir)).toBe(runnerA);

    // config.save -> clearRunners while A's run is still active.
    bridge.clearRunners();

    // After clearRunners, the SAME runner A must still be served (not a fresh B).
    // Before the fix, clearRunners emptied the whole map and getRunner created a
    // fresh runner B (created.length would grow to 2, identity mismatch).
    expect(bridge.getCurrentRunner(tmpDir)).toBe(runnerA);
    expect(created.length).toBe(1); // no fresh runner created

    // Cleanup: stop the active run so its promise settles.
    await bridge.interruptCurrentRun({ userId: 'user1', chatId: 'chat1' });
    await runPromise;
  });
});
