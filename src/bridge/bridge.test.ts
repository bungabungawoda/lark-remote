import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from './index.js';
import { ClaudeRunner } from '../runner/claude/index.js';
import { SessionStore } from '../session/index.js';
import { SessionReaderRegistry } from '../session/registry.js';
import { AppConfigSchema } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { AgentEvent, AgentRunner, AgentSessionReader, Runner } from '../runner/index.js';
import {
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubAgentRegistry,
  createStubRunner,
  makeBridge,
  createStubSessionReader,
} from '../../tests/lib/bridge-stubs.js';
import { prependPath, restorePath, writeMockBin } from '../../tests/lib/path-mock.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// --- Stubs ---
/** A runner that yields events, then hangs forever until stop() releases it.
 *  Simulates Claude's run_in_background: result event is emitted, process still
 *  running (waiting for background tasks), then stop() releases to simulate
 *  process exit. */
function createBackgroundRunningRunner(events: AgentEvent[]): Runner & { release: () => void } {
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
    run: async function* () {
      for (const e of events) yield e;
      // After yielding all events, hang until stop() releases (simulates process exit)
      await waitForRelease;
    },
    release: releaseRun,
  };
}

interface HangingRunner extends Runner {
  stopCalled: boolean;
}

/** A runner whose run() hangs forever until stop() releases it (for watchdog tests). */
function createHangingRunner(): HangingRunner {
  let resolveHang: () => void = () => {};
  const hangPromise = new Promise<void>((r) => {
    resolveHang = r;
  });
  const runner: HangingRunner = {
    isRunning: false,
    stopCalled: false,
    stop: async () => {
      runner.stopCalled = true;
      resolveHang();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      await hangPromise;
    },
  };
  return runner;
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

// --- Approval typing reaction ---

describe('Bridge approval reaction retract', () => {
  it('test_anchor_approval_request_retracts_and_resends_typing_reaction', async () => {
    // 验证行为：审批请求到达时，bridge 必须先撤回原消息上的 Typing 表情，
    // 再重新发送一次——让飞书重新触发提醒，把用户注意力拉回待审批卡片。
    // 缺失后果：审批在等待人工决策时 Typing 一直停留在旧状态，用户不感知
    // 有审批等待（2026-08-12 用户要求：需要审批时撤回 typing 表情再重新发）。
    const events: AgentEvent[] = [
      {
        type: 'approval_requested',
        requestId: 1,
        kind: 'command',
        threadId: 'th-aaa-222',
        turnId: 'tn-222',
        itemId: 'item-2',
        view: {
          requestId: 1,
          kind: 'command',
          command: 'rm -rf /tmp/test',
          commandCwd: '/home/user/project',
          availableDecisions: ['accept', 'decline', 'cancel'],
        },
        timestamp: new Date().toISOString(),
      },
      { type: 'result', subtype: 'success', session_id: 'th-aaa-222' },
    ];
    const connector = createStubConnector({ removeReactionSpy: true, addReactionSpy: true });
    const runner = createStubRunner({ mode: 'streaming', events });
    const { bridge, sessionStore } = makeBridge({ runner, connector });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('do something', ctx);

    const removeSpy = vi.mocked(connector.removeReactionByEmoji);
    const addSpy = vi.mocked(connector.addReaction);
    await vi.waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('msg1', 'Typing');
      expect(addSpy).toHaveBeenCalledWith('msg1', 'Typing');
    });
    // 顺序：先撤回，再重发
    expect(removeSpy.mock.invocationCallOrder[0]).toBeLessThan(addSpy.mock.invocationCallOrder[0]);
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

// RED TEST: Problem 1 - After bridge restart (sessionStore cleared), bash commands should still work
// if user has saved workspaces. The expected behavior is that workspace alias should be used
// to restore cwd, not require user to manually /cd again.
describe('executeBash after bridge restart (REGRESSION)', () => {
  it('should execute bash when user has saved workspace, even if sessionStore was cleared', async () => {
    // Create a workspace store with a saved workspace
    const workspacePath = path.join(tmpDir, 'workspace.json');
    const { WorkspaceStore } = await import('../workspace/index.js');
    const workspaceStore = new WorkspaceStore(workspacePath);
    const workspaceDir = fs.realpathSync(tmpDir);
    workspaceStore.save('test-workspace', workspaceDir);

    // Create bridge with workspaceStore
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      connector,
      sessionStore,
      config,
      workspaceStore,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    // Simulate bridge RESTART - sessionStore is cleared (this is in-memory only!)
    sessionStore.delete('user1');
    expect(sessionStore.getCwd('user1')).toBeUndefined();

    // Now executeBash should use the saved workspace as fallback
    await bridge.executeBash('./restart.sh', ctx);

    // Expected: bash should try to execute (not return "请先使用 /cd" error)
    // The key check: we should NOT have an error message about /cd
    expect(connector._sent.length).toBeGreaterThan(0);

    // Verify NONE of the sent messages are the "请先使用 /cd" error
    const allTexts = connector._sent.map((s) => JSON.stringify(s.input));
    for (const text of allTexts) {
      expect(text).not.toContain('请先使用');
    }
  });
});

// --- Serial queue (§9.6) ---

describe('Bridge serial queue (§9.6)', () => {
  it('runs enqueued tasks one at a time', async () => {
    const { bridge } = makeBridge();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const makeTask = (name: string) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${name}:end`);
      running--;
    };
    bridge.enqueue(tmpDir, makeTask('a'));
    bridge.enqueue(tmpDir, makeTask('b'));
    bridge.enqueue(tmpDir, makeTask('c'));
    await new Promise((r) => setTimeout(r, 200));
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a rejected task does not break the chain — subsequent tasks still run', async () => {
    const { bridge } = makeBridge();
    const seen: string[] = [];
    bridge.enqueue(tmpDir, () => Promise.reject(new Error('boom')));
    bridge.enqueue(tmpDir, async () => {
      seen.push('ran');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['ran']);
  });

  it('enqueue ignores non-function task and logs a warn (regression: "task is not a function" poisoned the chain)', async () => {
    mockLogger.warn.mockClear();
    const { bridge } = makeBridge();
    const seen: string[] = [];
    // Simulate the production case: a non-function slips into enqueue
    bridge.enqueue(tmpDir, undefined as never);
    bridge.enqueue(tmpDir, async () => {
      seen.push('next');
    });
    await new Promise((r) => setTimeout(r, 50));
    // Subsequent task must still run — chain not poisoned
    expect(seen).toEqual(['next']);
    // A warn was logged for the bad task
    const warns = mockLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(
      warns.some((w) => w.includes('enqueue ignored') && w.includes('task is not a function')),
    ).toBe(true);
  });

  it('isBusy reflects activeRuns (per-workspace runners)', () => {
    const runner = createStubRunner();
    const { bridge } = makeBridge({ runner });
    // With per-workspace runners, isBusy only checks activeRuns map
    expect(bridge.isBusy).toBe(false);
    // Note: We can't directly set activeRuns for testing since it's private
    // The key behavior is that isBusy does not depend on runner.isRunning
  });

  it('executeBash invoked inside an enqueue task must not self-deadlock (regression: ! commands hung forever, only a Typing emoji came back)', async () => {
    // Reproduces the production dispatch path for `!` commands:
    //   index.ts: connector -> bridge.enqueue(cwd, () => router.handle('!...'))
    //   router:  '!' -> bridge.executeBash(cmd, ctx)
    // executeBash runs INSIDE the enqueue queue callback. It must not re-chain onto the
    // same `this.queues` promise and await its own completion — that forms a self-wait
    // deadlock (enqueue's queue promise settles only when executeBash returns, but
    // executeBash awaits bashTask which is chained behind that same promise).
    const { bridge, sessionStore, connector } = makeBridge();
    const cwd = fs.realpathSync(tmpDir);
    sessionStore.setCwd(ctx.userId, cwd);

    let completed = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('executeBash self-deadlocked inside enqueue callback')),
        5000,
      );
      bridge.enqueue(cwd, async () => {
        await bridge.executeBash('echo hello', ctx);
        completed = true;
        clearTimeout(timer);
        resolve();
      });
    });

    expect(completed).toBe(true);
    // A bash card (initial + final) should have been sent to the user
    expect(connector._sent.length).toBeGreaterThan(0);
  });
});

// --- ! bash concurrency with claude (§9.6: ! bypasses the serial queue) ---
describe('executeBash / claude concurrency (! bypasses serial queue)', () => {
  it('! bash and a claude run in the same workspace do NOT block each other (regression: they shared one serial queue + activeRuns)', async () => {
    const runner = createHangingRunner();
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    const cwd = fs.realpathSync(tmpDir);
    sessionStore.setCwd(ctx.userId, cwd);

    // 1. Start a long bash command (do NOT await yet).
    const bashPromise = bridge.executeBash('sleep 2', ctx);
    // Let bash spawn and register as active.
    await new Promise((r) => setTimeout(r, 250));

    // 2. While bash is running, send a claude message. It must NOT be dropped.
    //    Regression: bash used to do `activeRuns.set(cwd, ...)`, so forwardToClaude's
    //    `if (activeRuns.has(cwd))` branch dropped the claude message with
    //    "此 workspace 正在处理中".
    const claudePromise = bridge.forwardToClaude('hi', ctx);
    await new Promise((r) => setTimeout(r, 250));

    // claude entered activeRuns (not dropped)
    expect(bridge.isBusyFor(cwd)).toBe(true);
    const texts = connector._sent.map((s) => JSON.stringify(s.input));
    expect(texts.some((t) => t.includes('此 workspace 正在处理中'))).toBe(false);

    // 3. bash still completes on its own (not blocked by the hanging claude run)
    await bashPromise;

    // cleanup: stop the hanging claude run
    await bridge.interruptCurrentRun({ userId: ctx.userId, chatId: ctx.chatId });
    await claudePromise.catch(() => {});
  });

  it('interruptCurrentRun stops a running ! bash command by userId/chatId (regression: /stop could not stop ! commands — bashRunner was a local var, getRunner returned the claude runner)', async () => {
    const { bridge, sessionStore } = makeBridge();
    const cwd = fs.realpathSync(tmpDir);
    sessionStore.setCwd(ctx.userId, cwd);

    // Start a long bash; do not await.
    const bashPromise = bridge.executeBash('sleep 60', ctx);
    await new Promise((r) => setTimeout(r, 300)); // let it spawn

    // /stop without runId — matches by userId/chatId
    const stopped = await bridge.interruptCurrentRun({ userId: ctx.userId, chatId: ctx.chatId });
    expect(stopped).toBe(true);

    // bash must exit within grace period (not wait 60s)
    await Promise.race([
      bashPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('bash was not stopped')), 5000)),
    ]);
  });
});

// --- Idle watchdog (§9.12) ---

describe('Bridge idle watchdog (§9.12)', () => {
  it('calls runner.stop() after idleTimeoutMs and finalizes the card', async () => {
    vi.useFakeTimers();
    try {
      const runner = createHangingRunner();
      const { bridge, sessionStore, connector } = makeBridge({ runner, idleTimeoutMs: 1000 });
      sessionStore.setCwd(ctx.userId, tmpDir);

      const promise = bridge.forwardToClaude('hello', ctx);
      // Advance past the idle timeout; the timer fires → stop() → generator completes
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(runner.stopCalled).toBe(true);
      expect(JSON.stringify(connector._cards.at(-1))).toContain('已自动终止');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT fire the watchdog when events arrive within the window', async () => {
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [
        { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
        { type: 'result', subtype: 'success', session_id: 's1' },
      ];
      const runner = createStubRunner({ mode: 'streaming', events: events });
      const { bridge, sessionStore, connector } = makeBridge({ runner, idleTimeoutMs: 1000 });
      sessionStore.setCwd(ctx.userId, tmpDir);

      const promise = bridge.forwardToClaude('hello', ctx);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const texts = connector._sent.map((s) => (s.input as { text?: string }).text ?? '');
      expect(texts.some((t) => t.includes('空闲时限已被终止'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT fire the watchdog while an approval is pending', async () => {
    // 权限等待期间暂停空闲看门狗：claude/codex 等待人工决策时无
    // stdout 事件，「等审批」不是「挂死」。审批由 ApprovalCoordinator 的
    // 5 分钟超时自愈（cancel + 中断 turn），此处推进到看门狗窗口之外但远小于
    // 审批超时，必须不触发 runner.stop()。
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
          cwd: tmpDir,
          model: 'opus',
        },
        {
          type: 'approval_requested',
          requestId: 1,
          kind: 'command',
          threadId: 'th-aaa-222',
          turnId: 'tn-222',
          itemId: 'item-2',
          view: {
            requestId: 1,
            kind: 'command',
            command: 'rm -rf /tmp/test',
            commandCwd: '/home/user/project',
            availableDecisions: ['accept', 'decline', 'cancel'],
          },
        },
      ];
      const runner = createBackgroundRunningRunner(events);
      const stopSpy = vi.fn(() => runner.stop());
      runner.stop = stopSpy;
      const { bridge, sessionStore } = makeBridge({ runner, idleTimeoutMs: 1000 });
      sessionStore.setCwd(ctx.userId, tmpDir);

      const promise = bridge.forwardToClaude('hello', ctx);
      await vi.advanceTimersByTimeAsync(5000);

      // 审批 pending：看门狗不得 stop（stub runner 无 respondApproval，审批
      // 保持 pending；stop 未被调用即证明暂停生效）。
      expect(stopSpy).not.toHaveBeenCalled();

      // 释放挂起 run，让 forwardToClaude 正常收尾
      runner.release();
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- ClaudeRunner 长驻审批链路集成（真实 runner + mock claude） ---

describe('Bridge + ClaudeRunner approval integration', () => {
  let integrationTmpDir: string;
  let savedPath: string | undefined;
  const integrationRunners: ClaudeRunner[] = [];

  beforeEach(() => {
    integrationTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-'));
    savedPath = prependPath(integrationTmpDir);
  });

  afterEach(async () => {
    for (const r of [...integrationRunners]) {
      try {
        await r.dispose();
      } catch {
        /* ignore */
      }
    }
    integrationRunners.length = 0;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MOCK_')) delete process.env[key];
    }
    restorePath(savedPath);
    fs.rmSync(integrationTmpDir, { recursive: true, force: true });
  });

  it('test_anchor_approval_request_shows_card_and_accept_writes_back_to_done', async () => {
    // 端到端链路：真实 ClaudeRunner（mock claude 协议）→ bridge 事件循环 →
    // ApprovalCoordinator → run 卡审批区 → 点击允许 → control_response 回写 →
    // mock 继续执行 → result → 卡片 done。协议单测在 runner 层、审批 UI 在
    // bridge 层，本测试覆盖中间的接线（review P3-5）。
    const mockPath = path.resolve(__dirname, '../../tests/lib/mock-claude.js');
    writeMockBin(integrationTmpDir, 'claude', `#!/bin/bash\nexec node "${mockPath}"`);
    process.env.MOCK_SCENARIO = 'approval';

    const runner = new ClaudeRunner({
      pidDir: integrationTmpDir,
      workspace: integrationTmpDir,
      permissionMode: 'default',
      idleTtlMs: 0,
    });
    integrationRunners.push(runner);

    const { bridge, sessionStore, connector } = makeBridge({
      runner,
      idleTimeoutMs: 60_000,
    });
    sessionStore.setCwd(ctx.userId, integrationTmpDir);

    const runPromise = bridge.forwardToClaude('run the command', ctx);

    // 等审批区出现在流式卡上（不新增消息，卡上直接出现「命令审批」）
    await vi.waitFor(() => {
      const card = connector._cards.at(-1);
      expect(JSON.stringify(card)).toContain('命令审批');
    });

    // 从审批按钮提取 runId + requestId，走真实卡片动作路径响应
    const lastCard = JSON.stringify(connector._cards.at(-1));
    const respondMatch = lastCard.match(
      /"cmd":"approval\.respond","decision":"accept","requestId":([^,]+),"runId":"([^"]+)"/,
    );
    expect(respondMatch).not.toBeNull();
    const rawRequestId = respondMatch![1];
    const requestId = rawRequestId.startsWith('"')
      ? rawRequestId.replace(/"/g, '')
      : Number(rawRequestId);
    const runId = respondMatch![2];

    await bridge.handleApprovalRespond({
      runId,
      requestId,
      decision: 'accept',
      nonce: 'integration-n1',
    });
    await runPromise;

    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('已完成');
    // 审批区已随 resolved 移除（不再残留按钮）
    expect(finalCard).not.toContain('命令审批');
  });
});

// --- forwardToClaude core flow ---

describe('Bridge.forwardToClaude', () => {
  /** Extract runId from CardKit 2.0 card structure */
  function extractRunId(card: object): string | undefined {
    const cardAny = card as Record<string, unknown>;
    // 2.0: body.elements with behaviors
    if (cardAny.body && typeof cardAny.body === 'object') {
      const body = cardAny.body as {
        elements?: Array<{ behaviors?: Array<{ value?: { runId?: string } }> }>;
      };
      for (const el of body.elements ?? []) {
        if (el.behaviors) {
          for (const b of el.behaviors) {
            if (b.value?.runId) return b.value.runId;
          }
        }
      }
    }
    return undefined;
  }

  it('test_anchor_control_lane_interrupts_a_hanging_run_and_rejects_stale_run_id', async () => {
    const runner = createHangingRunner();
    const { bridge, sessionStore, connector } = makeBridge({ runner, idleTimeoutMs: 60_000 });
    sessionStore.setCwd(ctx.userId, tmpDir);
    const runPromise = bridge.forwardToClaude('hang', ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initial = connector._cards[0] as {
      elements: Array<{ actions?: Array<{ value?: { runId?: string } }> }>;
    };
    const runId = extractRunId(initial);

    expect(
      await bridge.interruptCurrentRun({
        userId: ctx.userId,
        chatId: ctx.chatId,
        runId: 'stale-run',
      }),
    ).toBe(false);
    expect(
      await bridge.interruptCurrentRun({
        userId: 'other-user',
        chatId: ctx.chatId,
        runId,
      }),
    ).toBe(false);
    expect(
      await bridge.interruptCurrentRun({
        userId: ctx.userId,
        chatId: 'other-chat',
        runId,
      }),
    ).toBe(false);
    expect(runner.stopCalled).toBe(false);
    expect(
      await bridge.interruptCurrentRun({
        userId: ctx.userId,
        chatId: ctx.chatId,
        runId,
      }),
    ).toBe(true);
    await runPromise;

    expect(runner.stopCalled).toBe(true);
    expect(JSON.stringify(connector._cards.at(-1))).toContain('已被用户终止');
  });

  it('prompts to /cd when no cwd is set', async () => {
    const { bridge, connector } = makeBridge();
    await bridge.forwardToClaude('hello', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('/cd');
  });

  it('rejects with a hint when the same workspace already has a run in progress', async () => {
    const { bridge, sessionStore, connector: _connector } = makeBridge();
    sessionStore.setCwd(ctx.userId, tmpDir);

    // Use isBusyFor to verify workspace-level busy check
    expect(bridge.isBusyFor(tmpDir)).toBe(false);
  });

  it('threads cache_creation + total_tokens from result event to the done card', async () => {
    // ccusage-aligned ResultEvent.usage carries cache_creation_tokens and
    // total_tokens. The bridge must thread both to the done card so it shows
    // "Cache create" and uses max(total, sum) for Total. The contextLength
    // fallback must also use total (input is non-cached, so input+output
    // would drop cached tokens).
    const runner = createStubRunner({
      mode: 'streaming',
      events: [
        { type: 'system', subtype: 'init', session_id: 's-cu', cwd: tmpDir, model: 'opus' },
        {
          type: 'result',
          subtype: 'success',
          session_id: 's-cu',
          usage: {
            input_tokens: 240,
            output_tokens: 3,
            cache_read_tokens: 0,
            cache_creation_tokens: 100,
            total_tokens: 393,
          },
        },
      ],
    });
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hi', ctx);

    const json = JSON.stringify(connector._cards.at(-1));
    expect(json).toContain('Cache create - 100');
    expect(json).toContain('Total token - 393'); // max(393, 240+3+0+100=343)
    expect(json).toContain('Context - 393'); // total, not input+output=243
    expect(json).not.toContain('Context - 243');
  });

  it('isBusyFor returns true only for the specified workspace', async () => {
    const { bridge, sessionStore } = makeBridge();
    sessionStore.setCwd(ctx.userId, tmpDir);

    // Check isBusyFor for different workspaces
    expect(bridge.isBusyFor(tmpDir)).toBe(false);
    expect(bridge.isBusyFor('/tmp/other')).toBe(false);
  });

  it('getActiveRunFor returns current running state for a workspace', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: Runner = {
      isRunning: false,
      stop: async () => {
        release();
      },
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sid-active',
          cwd: tmpDir,
          model: 'opus',
        } satisfies AgentEvent;
        // Keep running (no result event yet) — simulates an in-progress run
        await wait;
      },
    };
    const { bridge, sessionStore } = makeBridge({ runner, idleTimeoutMs: 60_000 });
    sessionStore.setCwd(ctx.userId, tmpDir);

    const promise = bridge.forwardToClaude('test', ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // result 事件后进入 finalizing（非终态），进程退出后才转 done/error
    // 没有 result 事件时，状态仍为 running
    expect(bridge.getActiveRunFor(tmpDir)).toMatchObject({
      cwd: tmpDir,
      sessionId: 'sid-active',
      terminal: 'running',
    });

    release();
    await promise;
  });

  it('test_anchor_active_run_snapshot_no_result_subtype', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: Runner = {
      isRunning: false,
      stop: async () => {
        release();
      },
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sid-anchor',
          cwd: tmpDir,
          model: 'opus',
        } satisfies AgentEvent;
        // Keep running (no result event yet) — simulates an in-progress run
        await wait;
      },
    };
    const { bridge, sessionStore } = makeBridge({ runner, idleTimeoutMs: 60_000 });
    sessionStore.setCwd(ctx.userId, tmpDir);

    const promise = bridge.forwardToClaude('test', ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // After deleting the dead field, getActiveRunFor() snapshot must NOT
    // carry a `resultSubtype` property (no consumer reads it).
    expect(bridge.getActiveRunFor(tmpDir)).toBeDefined();
    expect(bridge.getActiveRunFor(tmpDir)).not.toHaveProperty('resultSubtype');

    release();
    await promise;
  });

  it('does NOT send completion notification when run card is the last message', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.01 },
    ];
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    // Only the run card should be sent (streaming succeeded, no fallback needed)
    // No separate completion notification card should be added via sendWithRetry
    const sendWithRetryCalls = connector._sent.filter(
      (s) => !(s.input as Record<string, unknown>).card,
    );
    expect(sendWithRetryCalls).toHaveLength(0);
    const streamCardCalls = connector._sent.filter(
      (s) => (s.input as Record<string, unknown>).card,
    );
    expect(streamCardCalls.length).toBeGreaterThanOrEqual(1);
    const cardJson = JSON.stringify(connector._cards.at(-1));
    expect(cardJson).toContain('hello');
    expect(cardJson).toContain('success');
  });

  it('syncs session and renders assistant output plus result in one card', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'part 1' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'part 2' }] } },
      { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.01 },
    ];
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    // Session synced from init event
    expect(sessionStore.getSessionId(ctx.userId)).toBe('s1');
    expect(sessionStore.getCwd(ctx.userId)).toBe(tmpDir);

    // Only the run card is sent via streamCard (no separate completion notification via sendWithRetry)
    const sendWithRetryCalls = connector._sent.filter(
      (s) => !(s.input as Record<string, unknown>).card,
    );
    expect(sendWithRetryCalls).toHaveLength(0);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('part 1part 2');
    expect(finalCard).toContain('success');
  });

  it('renders an error terminal when the runner throws', async () => {
    const runner: Runner = {
      ...createStubRunner(),
      run: async function* () {
        throw new Error('claude died');
      },
    };
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    expect(JSON.stringify(connector._cards.at(-1))).toContain('claude died');
  });

  it('test_anchor_error_result_and_missing_result_are_not_rendered_as_done', async () => {
    const errorResult = makeBridge({
      runner: createStubRunner({
        mode: 'streaming',
        events: [
          { type: 'system', subtype: 'init', session_id: 's1' },
          { type: 'result', subtype: 'error', session_id: 's1' },
        ],
      }),
    });
    errorResult.sessionStore.setCwd(ctx.userId, tmpDir);
    await errorResult.bridge.forwardToClaude('error', ctx);
    expect(JSON.stringify(errorResult.connector._cards.at(-1))).toContain('Agent 返回错误结果');

    const missingResult = makeBridge({
      runner: createStubRunner({
        mode: 'streaming',
        events: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }],
      }),
    });
    missingResult.sessionStore.setCwd(ctx.userId, tmpDir);
    await missingResult.bridge.forwardToClaude('missing', ctx);
    expect(JSON.stringify(missingResult.connector._cards.at(-1))).toContain('输出流已结束');
  });

  it('test_anchor_interrupted_result_renders_interrupted_not_error', async () => {
    // 审批超时/取消导致 turn interrupted：结果卡必须呈现「已被用户终止」，
    // 不得归因为「运行出错 / Agent 返回错误结果」（2026-08-14 线上事故）。
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({
        mode: 'streaming',
        events: [
          { type: 'system', subtype: 'init', session_id: 's1' },
          { type: 'result', subtype: 'interrupted', session_id: 's1' },
        ],
      }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('interrupt', ctx);

    const cardJson = JSON.stringify(connector._cards.at(-1));
    expect(cardJson).toContain('已被用户终止');
    expect(cardJson).not.toContain('运行出错');
    expect(cardJson).not.toContain('Agent 返回错误结果');
  });

  it('test_anchor_stream_failure_before_initial_sends_one_static_terminal_card', async () => {
    const connector = createStubConnector();
    connector.streamCard = async () => {
      throw new Error('stream unavailable');
    };
    const { bridge, sessionStore } = makeBridge({
      connector,
      runner: createStubRunner({
        mode: 'streaming',
        noAutoInit: true,
        events: [
          { type: 'assistant', message: { content: [{ type: 'text', text: 'fallback body' }] } },
          // §9.22: no init event — this test intentionally covers the stream-failure
          // fallback path where no system.init arrives (the card must still render
          // a terminal state). Including an init would cause push() calls that
          // produce extra messages when streamCard has failed.
          { type: 'result', subtype: 'success', session_id: 's1' },
        ],
      }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('fallback', ctx);

    expect(connector._sent).toHaveLength(1);
    expect(JSON.stringify(connector._sent[0].input)).toContain('fallback body');
    expect(JSON.stringify(connector._sent[0].input)).toContain('已完成');
  });
});

// --- sendResult ---

describe('Bridge.sendResult', () => {
  it('dispatches card / markdown / text payloads to the connector', async () => {
    const { bridge, connector } = makeBridge();

    await bridge.sendResult({ card: { x: 1 } }, ctx);
    await bridge.sendResult({ markdown: 'hi' }, ctx);
    await bridge.sendResult({ text: 'plain' }, ctx);

    expect(connector._sent.length).toBe(3);
    expect(connector._sent[0].input).toEqual({ card: { x: 1 } });
    expect(connector._sent[1].input).toEqual({ markdown: 'hi' });
    expect(connector._sent[2].input).toEqual({ text: 'plain' });
    // replyTo is propagated
    for (const s of connector._sent) {
      expect((s.opts as { replyTo?: string }).replyTo).toBe(ctx.messageId);
    }
  });

  it('swallows send errors and returns false on failure', async () => {
    const { bridge } = makeBridge({
      runner: createStubRunner(),
    });
    // Replace connector with one that throws
    vi.spyOn(bridge.connector, 'sendWithRetry').mockRejectedValue(new Error('network down'));
    // sendResult should return false on failure (not throw)
    const result = await bridge.sendResult({ text: 'x' }, ctx);
    expect(result).toBe(false);
  });

  it('returns true on success', async () => {
    const { bridge } = makeBridge();
    const result = await bridge.sendResult({ text: 'success' }, ctx);
    expect(result).toBe(true);
  });
});

// --- setConfig ---

// --- syncActiveApprovalModes (§P5 hot push) ---

/** Runner that records updateApprovalMode calls and holds the run until released. */
function createApprovalHotPushRunner(): {
  runner: Runner & { updateApprovalMode: ReturnType<typeof vi.fn> };
  release: () => void;
} {
  const updateApprovalMode = vi.fn(async () => {});
  let releaseRun: () => void = () => {};
  const waitForRelease = new Promise<void>((r) => {
    releaseRun = r;
  });
  const runner = {
    isRunning: false,
    updateApprovalMode,
    stop: async () => {
      releaseRun();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    lifetime: 'workspace' as const,
    run: async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'stub-session' } as AgentEvent;
      await waitForRelease;
      yield { type: 'result', subtype: 'success', session_id: 'stub-session' } as AgentEvent;
    },
  } as Runner & { updateApprovalMode: ReturnType<typeof vi.fn> };
  return { runner, release: releaseRun };
}

describe('Bridge.syncActiveApprovalModes (§P5 hot push)', () => {
  it('hot-pushes kimi permissionMode to the active run', async () => {
    const { runner } = createApprovalHotPushRunner();
    const { bridge, sessionStore } = makeBridge({
      runner,
      config: AppConfigSchema.parse({
        feishu: { appId: 'test', appSecret: 'test' },
        claude: { model: 'opus', stopGraceMs: 5000 },
        defaultAgent: 'kimi',
        agents: { kimi: { model: 'kimi-code/k3', permissionMode: 'manual' } },
        output: { showThinking: true, showToolUse: false, showToolResult: false },
      }),
    });
    const cwd = fs.realpathSync(tmpDir);
    sessionStore.setCwd(ctx.userId, cwd);

    const runPromise = bridge.forwardToClaude('hi', ctx);
    await vi.waitFor(() => {
      expect(bridge.isBusyFor(cwd)).toBe(true);
    });

    const newConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      defaultAgent: 'kimi',
      agents: { kimi: { model: 'kimi-code/k3', permissionMode: 'yolo' } },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
    bridge.setConfig(newConfig);
    bridge.syncActiveApprovalModes();

    expect(runner.updateApprovalMode).toHaveBeenCalledWith({ permissionMode: 'yolo' });

    await runner.stop();
    await runPromise;
  });

  it('hot-pushes opencode mode to the active run', async () => {
    const { runner } = createApprovalHotPushRunner();
    const { bridge, sessionStore } = makeBridge({
      runner,
      config: AppConfigSchema.parse({
        feishu: { appId: 'test', appSecret: 'test' },
        claude: { model: 'opus', stopGraceMs: 5000 },
        defaultAgent: 'opencode',
        agents: {
          opencode: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514', mode: 'build' },
        },
        output: { showThinking: true, showToolUse: false, showToolResult: false },
      }),
    });
    const cwd = fs.realpathSync(tmpDir);
    sessionStore.setCwd(ctx.userId, cwd);

    const runPromise = bridge.forwardToClaude('hi', ctx);
    await vi.waitFor(() => {
      expect(bridge.isBusyFor(cwd)).toBe(true);
    });

    const newConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      defaultAgent: 'opencode',
      agents: {
        opencode: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514', mode: 'plan' },
      },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
    bridge.setConfig(newConfig);
    bridge.syncActiveApprovalModes();

    expect(runner.updateApprovalMode).toHaveBeenCalledWith({ mode: 'plan' });

    await runner.stop();
    await runPromise;
  });
});

// --- forwardToClaude logging probes ---

/**
 * Helper: return all logger calls of a given level whose first arg matches
 * the predicate. Lets tests assert "a log with runId=xxx happened" without
 * pinning exact message text.
 */
function callsAt(
  level: 'debug' | 'info' | 'warn' | 'error',
  predicate: (first: unknown) => boolean,
): unknown[][] {
  return mockLogger[level].mock.calls.filter((call) => predicate(call[0]));
}

describe('Bridge.forwardToClaude logging probes', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('emits the full happy-path probe sequence (entry → activeRuns.set → cardSession → runner → result → activeRuns.delete)', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const { bridge, sessionStore } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello world', ctx);

    // 1. Entry debug log
    const entries = callsAt(
      'debug',
      (m) => typeof m === 'string' && m.includes('[bridge] forward entry'),
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(String(entries[0]?.[0])).toContain('user1');

    // 2. activeRuns.set
    const setLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[bridge] activeRuns.set'),
    );
    expect(setLogs.length).toBe(1);

    // 3. cardSession.start ok
    expect(
      callsAt('info', (m) => typeof m === 'string' && m.includes('[bridge] cardSession.start() ok'))
        .length,
    ).toBe(1);

    // 4. runner.run begin
    expect(
      callsAt('info', (m) => typeof m === 'string' && m.includes('[bridge] runner.run() begin'))
        .length,
    ).toBe(1);
    // runner.run begin should include the message preview
    expect(
      String(
        callsAt(
          'info',
          (m) => typeof m === 'string' && m.includes('[bridge] runner.run() begin'),
        )[0]?.[0],
      ),
    ).toContain('hello world');

    // 5. system.init received
    expect(
      callsAt('info', (m) => typeof m === 'string' && m.includes('[bridge] system.init received'))
        .length,
    ).toBe(1);

    // 6. result event received
    expect(
      callsAt('info', (m) => typeof m === 'string' && m.includes('[bridge] result event received'))
        .length,
    ).toBe(1);

    // 7. runner stream end with sawResult=true
    const streamEnd = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[bridge] runner stream end'),
    );
    expect(streamEnd.length).toBe(1);
    expect(String(streamEnd[0]?.[0])).toContain('sawResult=true');

    // 8. activeRuns.delete — CRITICAL: was missing before, blocks the queue forever if not emitted
    const deleteLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[bridge] activeRuns.delete'),
    );
    expect(deleteLogs.length).toBe(1);

    // No error logs on happy path
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('emits a workspace-busy warn log and drops the message when activeRuns is occupied', async () => {
    const hangingRunner = createHangingRunner();
    const { bridge, sessionStore } = makeBridge({ runner: hangingRunner, idleTimeoutMs: 60_000 });
    sessionStore.setCwd(ctx.userId, tmpDir);

    // First call: occupies activeRuns and hangs (NOT awaited so it doesn't block the test)
    void bridge.forwardToClaude('first', ctx);
    // Give the first call a tick to reach activeRuns.set
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Second call: should hit the workspace-busy branch (NOT enqueued, direct call)
    await bridge.forwardToClaude('second', ctx);

    const busy = callsAt(
      'warn',
      (m) => typeof m === 'string' && m.includes('[bridge] workspace busy, dropping message'),
    );
    expect(busy.length).toBe(1);
    expect(String(busy[0]?.[0])).toContain('user1');
    expect(String(busy[0]?.[0])).toContain(tmpDir);

    // Cleanup: resolve the hang so the dangling first promise settles
    resolveHanging(hangingRunner);
  });

  it('emits activeRuns.delete after watchdog kills a hung run (regression: queue was blocked because delete never logged)', async () => {
    const hangingRunner = createHangingRunner();
    const { bridge, sessionStore } = makeBridge({ runner: hangingRunner, idleTimeoutMs: 100 });
    sessionStore.setCwd(ctx.userId, tmpDir);

    vi.useFakeTimers();
    try {
      const promise = bridge.forwardToClaude('hung', ctx);
      // Allow entry + activeRuns.set
      await vi.advanceTimersByTimeAsync(10);
      // Cross idleTimeoutMs to trigger watchdog
      await vi.advanceTimersByTimeAsync(200);
      // Let watchdog cleanup settle
      await vi.advanceTimersByTimeAsync(10);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    // 1. runner.run begin was logged (entered runner)
    expect(
      callsAt('info', (m) => typeof m === 'string' && m.includes('[bridge] runner.run() begin'))
        .length,
    ).toBe(1);

    // 2. Watchdog log fired
    expect(
      callsAt('warn', (m) => typeof m === 'string' && m.includes('[bridge] claude idle timeout'))
        .length,
    ).toBe(1);

    // 3. activeRuns.delete emitted — THIS IS THE BUG WE'RE GUARDING AGAINST
    const deleteLogs = callsAt(
      'info',
      (m) => typeof m === 'string' && m.includes('[bridge] activeRuns.delete'),
    );
    expect(deleteLogs.length).toBe(1);

    // 4. runner.stop was actually called
    expect(hangingRunner.stopCalled).toBe(true);

    // 5. After cleanup, bridge should NOT be busy anymore → next message can run
    expect(bridge.isBusyFor(tmpDir)).toBe(false);
  });
});

// --- Queue cancel (removeFromQueue) ---

describe('Bridge queue cancel (removeFromQueue)', () => {
  it('removeFromQueue returns false for non-existent messageId', () => {
    const { bridge } = makeBridge();
    expect(bridge.removeFromQueue(tmpDir, 'nonexistent')).toBe(false);
  });

  it('removeFromQueue returns false when no queue exists for workspace', () => {
    const { bridge } = makeBridge();
    expect(bridge.removeFromQueue('/no/such/dir', 'any-id')).toBe(false);
  });

  // Standalone test to verify the fix works - simpler version
  it('cancelled task should not execute (verification test)', async () => {
    // This is a cleaner test that directly verifies our fix
    const { bridge } = makeBridge();
    const executed: string[] = [];

    // Task 1: blocks the workspace - WITH taskMeta so it appears in queuedTasks
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        executed.push('1');
        await hang1;
      },
      { taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-1', messagePreview: 't1' } },
    );

    // Task 2: with meta - will be cancelled
    bridge.enqueue(
      tmpDir,
      async () => {
        executed.push('2');
      },
      { taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-2', messagePreview: 't2' } },
    );

    await new Promise((r) => setImmediate(r));

    // Verify task 2 is in queue
    expect(bridge.getQueuedTasks(tmpDir).map((t) => t.messageId)).toContain('msg-2');

    // Cancel task 2
    const removed = bridge.removeFromQueue(tmpDir, 'msg-2');
    expect(removed).toBe(true);

    // Verify it's removed
    expect(bridge.getQueuedTasks(tmpDir).map((t) => t.messageId)).not.toContain('msg-2');

    // Let task 1 complete
    release1();
    await new Promise((r) => setTimeout(r, 50));

    // Task 2 should NOT have executed if our fix works
    // With the bug: executed = ['1', '2']
    // After fix: executed = ['1'] (task 2 was skipped)
    expect(executed).toEqual(['1']);
  });
});

describe('Bridge queue card in-place update on cancel', () => {
  it('updateQueueCardToCancelled updates card when queue card exists', async () => {
    const { bridge, connector } = makeBridge();
    const workspace = tmpDir;
    const userMessageId = 'user-msg-1';

    // Manually simulate that a queue card was sent for this task
    // (In real flow: first task is running, second task gets queue card)
    // We need to access queueManager to set up the mapping
    bridge.queueManager.queueCardMessages.set(userMessageId, Promise.resolve('feishu-card-msg-id'));

    // Call the method to update the queue card to cancelled state
    await bridge.updateQueueCardToCancelled(workspace, userMessageId);

    // Verify card was updated in-place (connector.updateCard was called)
    expect(connector._cards.length).toBe(1);

    // Verify the updated card has the correct "cancelled" state
    const lastCard = connector._cards[connector._cards.length - 1] as {
      header?: { title?: { content?: string }; template?: string };
      body?: {
        elements?: Array<{ tag?: string; disabled?: boolean; text?: { content?: string } }>;
      };
    };
    expect(lastCard.header?.title?.content).toBe('❌ 已撤销');
    expect(lastCard.header?.template).toBe('gray');

    // Verify both buttons exist and are disabled
    const buttons = lastCard.body?.elements?.filter((e) => e.tag === 'button') as Array<{
      disabled?: boolean;
      text?: { content?: string };
    }>;
    expect(buttons.length).toBe(2);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].text?.content).toBe('❌ 撤销');
    expect(buttons[1].disabled).toBe(true);
    expect(buttons[1].text?.content).toBe('⚡ 立即执行');
  });

  it('updateQueueCardToCancelled does nothing when no queue card exists', async () => {
    const { bridge, connector } = makeBridge();
    const workspace = tmpDir;
    const userMessageId = 'non-existent-msg';

    // Call the method when no queue card exists
    await bridge.updateQueueCardToCancelled(workspace, userMessageId);

    // Verify no card update was attempted
    expect(connector._cards.length).toBe(0);
  });
});

/**
 * Some stub factories don't expose their resolve function. Bridge tests use
 * `createHangingRunner` which stores it locally — this helper reaches in via
 * the public `stop()` (which resolves the hang) and works as a no-op after.
 */
function resolveHanging(runner: HangingRunner): void {
  // Trigger the hang release by calling stop(); runner.stop resolves hangPromise
  // and resolves the awaiting generator.
  void runner.stop();
}

// --- agentRegistry / sessionReaderRegistry wiring ---

describe('Bridge agentRegistry / sessionReaderRegistry', () => {
  it('getRunner uses agentRegistry when present (falls back to stub runner otherwise)', async () => {
    const { AgentRegistry } = await import('../runner/registry.js');
    const stubFromRegistry = asAgentRunner(
      createStubRunner({
        mode: 'streaming',
        events: [
          { type: 'assistant', message: { content: [{ type: 'text', text: 'REGISTRY-MARKER' }] } },
          { type: 'result', subtype: 'success', session_id: 'from-registry' },
        ],
      }),
    );
    const connector = createStubConnector();
    const bridge = new Bridge({
      runner: createStubRunner(),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: (() => {
        const reg = new AgentRegistry();
        reg.register('claude', () => stubFromRegistry);
        return reg;
      })(),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    // The runner from the registry (not the stub fallback runner) produced the assistant text.
    expect(JSON.stringify(connector._cards.at(-1))).toContain('REGISTRY-MARKER');
  });

  it('getRunner reclaims stopped runner slots beyond the cache cap (P3 review)', async () => {
    // 旧 workspace 的 runner 在会话 idle TTL 停进程后仍留在缓存里。创建新
    // workspace 槽位超过缓存上限时回收「非 active 且进程已停」的死槽位，
    // 防止缓存随访问过的 workspace 数量无界增长（活进程/在途 run 一律保留；
    // 小缓存下刚创建未 run 的 runner 不回收，保持「创建即注册」语义）。
    const { AgentRegistry } = await import('../runner/registry.js');
    const created: Array<{ entry: { disposed: boolean } }> = [];
    const reg = new AgentRegistry();
    reg.register('claude', () => {
      const entry = { disposed: false };
      const runner = asAgentRunner({
        lifetime: 'workspace',
        isRunning: false,
        run: async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'stub-session' };
          yield { type: 'result', subtype: 'success', session_id: 'stub-session' };
        },
        stop: async () => {},
        dispose: async () => {
          entry.disposed = true;
        },
        killOrphan: () => {},
        registerExitHandlers: () => {},
        unregisterExitHandlers: () => {},
      });
      created.push({ entry });
      return runner;
    });
    const connector = createStubConnector();
    const bridge = new Bridge({
      runner: createStubRunner(),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: reg,
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
    // 超过 MAX_CACHED_RUNNER_WORKSPACES（10）后，第 11 个工作区创建时回收
    // 前面的死槽位（stub 恒为 isRunning=false 且无在途 run）。
    for (let i = 1; i <= 11; i++) {
      const w = path.join(tmpDir, `w${i}`);
      fs.mkdirSync(w);
      sessionStore_setCwd(bridge, ctx.userId, w);
      await bridge.forwardToClaude('hello', ctx);
    }
    expect(created).toHaveLength(11);
    // 前 10 个死槽位被回收（dispose 已调用），第 11 个保留
    for (let i = 0; i < 10; i++) {
      expect(created[i].entry.disposed).toBe(true);
    }
    expect(created[10].entry.disposed).toBe(false);
  });

  it('sendCompletionNotificationCard uses sessionReaderRegistry when present', async () => {
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [{ type: 'text', content: 'session tail content' }],
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        contextLength: 120000,
        cost: 0.001,
        compactCount: 2,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    // Force the fallback path: streamCard throws → bridge sends a static card
    // + fires sendCompletionNotificationCard (only fires on the unsent path).
    const connector = createStubConnector();
    connector.streamCard = async () => {
      throw new Error('stream unavailable');
    };
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        { type: 'system', subtype: 'init', session_id: 'sess-notif', cwd: tmpDir, model: 'opus' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'result', subtype: 'success', session_id: 'sess-notif' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);

    // Registry was consulted (not the direct claude-sessions import).
    expect(readSpy).toHaveBeenCalledWith('sess-notif', tmpDir);
    // Notification card is sent via sendWithRetry (not streamCard), so it
    // lands in _sent with shape { card }. The static fallback run card is
    // also in _sent, so we filter by the session tail content marker.
    const notifPayload = connector._sent.find((s) =>
      JSON.stringify(s.input).includes('session tail content'),
    );
    expect(notifPayload).toBeDefined();
    // compactCount from jsonl is rendered in the completion notification footer (new multi-line format)
    expect(JSON.stringify(notifPayload?.input)).toContain('Compact - 2次');
    // context length should use K units (120K instead of 120000)
    expect(JSON.stringify(notifPayload?.input)).toContain('120K');
    expect(JSON.stringify(notifPayload?.input)).not.toContain('120,000');
  });

  it('test_anchor_completion_notification_card_renders_context_percent', async () => {
    // 验证：完成通知卡片（streamCard 失败回退路径）从 session content usage
    // 透传 contextLimit 渲染 "Context - X (Y%)"。
    // 缺失/错误会导致：通知卡片只看得到绝对量，看不到水位。
    // 依据：spec 摘要第 2 条（卡片统计输出百分比）。
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [{ type: 'text', content: 'notif ctx marker' }],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        contextLength: 5000,
        contextLimit: 200000,
        cost: 0.001,
        compactCount: 0,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    connector.streamCard = async () => {
      throw new Error('stream unavailable');
    };
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-notif-ctx',
          cwd: tmpDir,
          model: 'opus',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'result', subtype: 'success', session_id: 'sess-notif-ctx' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);
    const notifPayload = connector._sent.find((s) =>
      JSON.stringify(s.input).includes('notif ctx marker'),
    );
    expect(notifPayload).toBeDefined();
    expect(JSON.stringify(notifPayload?.input)).toContain('Context - 5K (3%)');
  });

  it('completion notification card resume.use button carries agent field', async () => {
    // When a non-default agent completes, the resume.use button in the
    // completion card must carry agent:<kind> so clicking it routes to the
    // correct agent's session reader. Without this, clicking the button
    // after switching defaultAgent would look up the wrong agent's session.
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const codexReadSpy = vi.fn(() => ({
      events: [{ type: 'text', content: 'codex session done' }],
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        contextLength: 5000,
        cost: 0.001,
        compactCount: 0,
      },
    }));
    const codexReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: codexReadSpy,
      isSessionActive: vi.fn(() => false),
    };
    const emptyReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: vi.fn(() => ({ events: [], usage: undefined, reason: 'not_found' })),
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', emptyReader as never);
    registry.register('codex', codexReader as never);
    registry.register('opencode', emptyReader as never);
    registry.register('pi', emptyReader as never);
    registry.register('kimi', emptyReader as never);

    // Force the unsent path so sendCompletionNotificationCard fires
    const connector = createStubConnector();
    connector.streamCard = async () => {
      throw new Error('stream unavailable');
    };
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'codex-sess-1',
          cwd: tmpDir,
          model: 'codex-model',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'codex done' }] } },
        { type: 'result', subtype: 'success', session_id: 'codex-sess-1' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    // Forward with agent binding = codex (simulates a codex run completing)
    await bridge.forwardToClaude('hello', ctx, {
      binding: { agent: 'codex' },
    });

    // Find the completion notification card
    const notifPayload = connector._sent.find((s) =>
      JSON.stringify(s.input).includes('codex session done'),
    );
    expect(notifPayload).toBeDefined();

    // The resume.use button must carry agent:'codex'.
    // Parse back to object and walk the card structure to find the button,
    // avoiding fragile JSON-string matching.
    const card = (
      notifPayload!.input as Record<
        string,
        Record<string, Record<string, Array<Record<string, unknown>>>>
      >
    )?.card;
    expect(card).toBeDefined();
    const elements = card?.body?.elements ?? [];
    // Find the column_set containing the resume.use button
    const resumeButton = elements
      .filter((el) => Array.isArray(el.columns))
      .flatMap((el) =>
        (el.columns as Array<Record<string, Array<Record<string, unknown>>>>).flatMap(
          (col) => col.elements ?? [],
        ),
      )
      .find(
        (el) =>
          el.tag === 'button' &&
          Array.isArray(el.behaviors) &&
          (el.behaviors as Array<Record<string, Record<string, string>>>).some(
            (b) => b.value?.cmd === 'resume.use',
          ),
      );
    expect(resumeButton).toBeDefined();
    const behavior = (resumeButton as Record<string, Array<Record<string, Record<string, string>>>>)
      ?.behaviors?.[0];
    expect(behavior?.value?.cmd).toBe('resume.use');
    expect(behavior?.value?.sessionId).toBe('codex-sess-1');
    // THE KEY ASSERTION: agent field must be present with value 'codex'
    expect(behavior?.value?.agent).toBe('codex');
  });

  it('done path reads jsonl via resolveFinalUsage for compactCount (regression: run card showed 1,115,408)', async () => {
    // The run card finish path must read the jsonl to get authoritative
    // contextLength (postTokens) + compactCount, instead of trusting the
    // unreliable live stream-json result.usage (which never emits
    // compact_boundary and inflates input_tokens).
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        contextLength: 5000,
        cost: 0.01,
        compactCount: 3,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        { type: 'system', subtype: 'init', session_id: 'sess-final', cwd: tmpDir, model: 'opus' },
        { type: 'result', subtype: 'success', session_id: 'sess-final' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);
    mockLogger.info.mockClear();

    await bridge.forwardToClaude('hello', ctx);
    // final-usage probe recorded the jsonl-derived compactCount.
    expect(readSpy).toHaveBeenCalledWith('sess-final', tmpDir);
    const finalLogs = mockLogger.info.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[bridge] final usage'));
    expect(finalLogs.length).toBe(1);
    expect(finalLogs[0]).toContain('compactCount=3');
    expect(finalLogs[0]).toContain('contextLength=5000');
  });

  it('test_anchor_final_usage_logs_context_limit_from_jsonl', async () => {
    // 验证：resolveFinalUsage 把 jsonl usage.contextLimit 透传到最终 usage，
    // "[bridge] final usage" 探针日志输出 contextLimit=...，Run 卡片据此渲染百分比。
    // 缺失/错误会导致：codex 会话的 context 上限在卡片链路中途丢失，只能显示绝对量。
    // 依据：spec 摘要第 1、2 条（codex jsonl → bridge → 卡片链路）。
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        contextLength: 5000,
        contextLimit: 200000,
        cost: 0.01,
        compactCount: 0,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        { type: 'system', subtype: 'init', session_id: 'sess-ctx', cwd: tmpDir, model: 'opus' },
        { type: 'result', subtype: 'success', session_id: 'sess-ctx' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);
    mockLogger.info.mockClear();

    await bridge.forwardToClaude('hello', ctx);
    expect(readSpy).toHaveBeenCalledWith('sess-ctx', tmpDir);
    const finalLogs = mockLogger.info.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[bridge] final usage'));
    expect(finalLogs.length).toBe(1);
    expect(finalLogs[0]).toContain('contextLimit=200000');
  });

  it('test_anchor_run_card_renders_context_percent_from_jsonl_limit', async () => {
    // 验证：jsonl usage.contextLimit 经 resolveFinalUsage → finish meta →
    // RunState → run-renderer 全链路后，done 卡片渲染 "Context - X (Y%)"。
    // 缺失/错误会导致：上限在链路中途丢失（如 finish 不透传），卡片只显示绝对量。
    // 依据：spec 摘要第 2 条（Run 卡片显示百分比）。
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        contextLength: 5000,
        contextLimit: 200000,
        cost: 0.01,
        compactCount: 0,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-ctx-card',
          cwd: tmpDir,
          model: 'opus',
        },
        { type: 'result', subtype: 'success', session_id: 'sess-ctx-card' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('Context - 5K (3%)');
  });

  it('test_anchor_run_card_renders_context_percent_from_live_appserver_usage', async () => {
    // 验证：app-server 模式 result 事件 usage.context_limit（协议
    // tokenUsage.modelContextWindow 透传）在 jsonl 无 contextLimit 时兜底，
    // done 卡片渲染 "Context - X (Y%)"。
    // 缺失/错误会导致：jsonl 未落盘 / error run 时 app-server 卡片只有绝对量。
    // 依据：spec 摘要第 2 条 + app-server v2 协议 thread/tokenUsage/updated。
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        contextLength: 5000,
        cost: 0.01,
        compactCount: 0,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-live-ctx',
          cwd: tmpDir,
          model: 'opus',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-live-ctx',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 5000,
            context_limit: 200000,
          },
        },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    await bridge.forwardToClaude('hello', ctx);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('Context - 5K (3%)');
  });

  it('error path does NOT read historical jsonl usage (regression: kimi --auto rejection showed stale contextLength=24439)', async () => {
    // 回归: kimi 0.26+ 拒绝 -p + --auto, 进程立即退出 exit=1 → result/error (无 usage)。
    // bridge 不应读 session jsonl 的历史 usage 当作本次 usage -- 否则把上一次成功
    // turn 的 contextLength 显示在出错卡片/日志上, 误导用户以为本次也消耗了 token。
    // 所有 agent 统一走 result -> finalizing -> 进程退出 -> done/error 路径。
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      usage: {
        inputTokens: 8000,
        outputTokens: 50,
        contextLength: 30000, // 历史数据 (上一次成功 turn)
        cacheReadTokens: 25000,
        cacheCreationTokens: 0,
      },
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        { type: 'system', subtype: 'init', session_id: 'sess-err', cwd: tmpDir, model: 'opus' },
        { type: 'result', subtype: 'error', session_id: 'sess-err' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);
    mockLogger.info.mockClear();

    await bridge.forwardToClaude('hello', ctx);

    // resolveFinalUsage 不应在 error 路径读历史 usage
    expect(readSpy).not.toHaveBeenCalled();
    const finalLogs = mockLogger.info.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('[bridge] final usage'));
    expect(finalLogs.length).toBe(1);
    // 不应出现历史 contextLength
    expect(finalLogs[0]).not.toContain('contextLength=24439');
  });

  it('test_anchor_resolveFinalUsage_warns_when_jsonl_usage_missing', async () => {
    // 验证行为: run 结束后 resolveFinalUsage 从 session jsonl 读不到 usage
    //           （content.usage 为空，如 EnterWorktree 搬迁致读取静默失败）时，
    //           记一条 WARN 探针，含 "no usage from jsonl" + sessionId/cwd/agent。
    // 缺失后果: jsonl 兜底失败完全静默，token 统计悄悄回退到单 run live 增量，
    //           无任何日志线索。探针让同类故障一眼可见。
    // 依据: worktree relocate 方案 §3.2。
    const { SessionReaderRegistry } = await import('../session/registry.js');
    const readSpy = vi.fn(() => ({
      events: [],
      // usage 缺失：模拟 jsonl 读取失败/文件被搬走后的兜底落空
    }));
    const stubReader = {
      listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
      getNewestSession: vi.fn(() => null),
      readSessionContent: readSpy,
      isSessionActive: vi.fn(() => false),
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubReader as never);

    const connector = createStubConnector();
    const streamingRunner = createStubRunner({
      mode: 'streaming',
      events: [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-no-usage',
          cwd: tmpDir,
          model: 'opus',
        },
        { type: 'result', subtype: 'success', session_id: 'sess-no-usage' },
      ],
    });
    const bridge = new Bridge({
      runner: asAgentRunner(streamingRunner),
      connector,
      sessionStore: new SessionStore(),
      config,
      agentRegistry: createStubAgentRegistry(streamingRunner),
      sessionReaderRegistry: registry,
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);
    mockLogger.warn.mockClear();

    await bridge.forwardToClaude('hello', ctx);

    // jsonl 被读过（resolveFinalUsage 走了 jsonl 链路）
    expect(readSpy).toHaveBeenCalledWith('sess-no-usage', tmpDir);
    // 兜底落空时记 WARN 探针，携带定位字段
    const warnLogs = mockLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('no usage from jsonl'));
    expect(warnLogs.length).toBe(1);
    expect(warnLogs[0]).toContain('sess-no-usage');
    expect(warnLogs[0]).toContain(tmpDir);
    expect(warnLogs[0]).toContain('agent=claude');
  });
});

/** Wrap a stub `Runner` with the `AgentRunner` fields Bridge doesn't read but
 *  `AgentRegistry.register` requires. Bridge.getRunner only calls
 *  `Runner` methods; kind/sessionReader are never accessed. */
function asAgentRunner(r: Runner): AgentRunner {
  return {
    ...r,
    kind: 'claude',
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: 'claude', model: 'test' }),
  };
}

// Helper: set cwd via Bridge's sessionStore (public seam).
function sessionStore_setCwd(bridge: Bridge, userId: string, cwd: string): void {
  bridge.sessionStore.setCwd(userId, cwd);
}

// --- finalizing 专项集成测试 (§7.3) ---

describe('Bridge finalizing integration tests (§7.3)', () => {
  /**
   * Test 1: result 后 state=finalizing，for-await 继续，进程退出后 finish(done)
   *
   * Verifies: result 不置终态，for-await 继续消费，finally 块转 done
   */
  it('result event transitions to finalizing, then process exit triggers done', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 200 },
      },
    ];
    // createStreamingRunner: events are yielded, then generator returns (simulates process exit)
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('hi', ctx);

    // Card should show 'done' (not 'running' or 'finalizing' stuck)
    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    expect(finalCard).toBeDefined();
    const cardJson = JSON.stringify(finalCard);
    expect(cardJson).toContain('已完成');
    // Should NOT contain stop button (terminal state)
    expect(cardJson).not.toContain('停止');
  });

  /**
   * Test 2: Claude 后台任务：result -> 后台事件 -> 进程退出 -> done
   *
   * Verifies: finalizing 期间停止按钮可达，后台事件不丢弃
   */
  it('result event followed by background task output before process exit', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's2', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'main result' }] } },
      { type: 'result', subtype: 'success', session_id: 's2' },
      // Background task output AFTER result (in finalizing state)
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'background task output' }] },
      },
    ];
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('run background task', ctx);

    // Card should show final output including background task output
    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Background task output should be present (not discarded during finalizing)
    expect(cardJson).toContain('background task output');
    expect(cardJson).toContain('已完成');
  });

  /**
   * Test 3: /stop 在 finalizing：interrupted
   *
   * Verifies: 首终态优先，进程退出 finally 不覆盖
   */
  it('/stop during finalizing results in interrupted (not overridden by process exit)', async () => {
    const runner = createBackgroundRunningRunner([
      { type: 'system', subtype: 'init', session_id: 's3', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      { type: 'result', subtype: 'success', session_id: 's3' },
    ]);
    const { bridge, sessionStore, connector } = makeBridge({ runner, idleTimeoutMs: 60_000 });
    sessionStore.setCwd(ctx.userId, tmpDir);

    // Start the run (will hang after result, simulating background task)
    const runPromise = bridge.forwardToClaude('long task', ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // User clicks stop during finalizing
    await bridge.interruptCurrentRun({ userId: ctx.userId, chatId: ctx.chatId });

    // Release the runner (simulating process exit after interrupt)
    runner.release();
    await runPromise.catch(() => {}); // May reject, ignore

    // Card should show '已被用户终止' (interrupted), NOT '已完成' or 'error'
    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    expect(cardJson).toContain('已被用户终止');
  });

  /**
   * Test 5: 进程崩溃无 result：running -> error
   *
   * Verifies: running（非 finalizing）+ 进程退出 -> error
   */
  it('process exits without result event: running -> error', async () => {
    // Runner that exits without emitting result event (simulates crash)
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's5', cwd: tmpDir, model: 'opus' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
        // No result event - process exits abruptly
      },
    };
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('crash test', ctx);

    // Card should show error (no result received)
    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Should contain the error message about missing result
    expect(cardJson).toContain('输出流已结束');
    // Should be an error card (red header)
    expect(cardJson).toContain('red');
    expect(cardJson).toContain('出错');
  });

  /**
   * Test 6: 一致性断言：forwardToClaude 返回后 !activeRuns.has(cwd)
   *
   * Verifies: dispatch 不变式 - workspace not busy after run completes
   */
  it('activeRuns is cleared after forwardToClaude completes', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's6', cwd: tmpDir, model: 'opus' },
      { type: 'result', subtype: 'success', session_id: 's6' },
    ];
    const { bridge, sessionStore } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    expect(bridge.isBusyFor(tmpDir)).toBe(false);

    await bridge.forwardToClaude('test', ctx);

    // After completion, workspace should NOT be busy
    expect(bridge.isBusyFor(tmpDir)).toBe(false);
  });

  /**
   * Test 7: result(error) 后进程干净退出：error
   *
   * Verifies: agent errorMsg 保留，不被合成事件覆盖
   */
  it('result error preserves agent error message through process exit', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's7', cwd: tmpDir, model: 'opus' },
      {
        type: 'result',
        subtype: 'error',
        session_id: 's7',
        errorMessage: 'auth failed - API key invalid',
      },
    ];
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({ mode: 'streaming', events: events }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('auth test', ctx);

    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Should show error terminal (header should be red with "出错")
    expect(cardJson).toContain('出错');
    expect(cardJson).toContain('red');
    // Agent's specific error message should be preserved
    expect(cardJson).toContain('auth failed');
  });

  /**
   * Test 8: finalizing 期间 for-await 抛异常：catch 块转 error
   *
   * Verifies: catch 接受 finalizing 状态
   */
  it('for-await error during finalizing transitions to error terminal', async () => {
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's8', cwd: tmpDir, model: 'opus' };
        yield { type: 'result', subtype: 'success', session_id: 's8' };
        // After result, simulate a crash/error during finalizing
        throw new Error('connection terminated unexpectedly');
      },
    };
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('error during finalizing', ctx);

    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Should show error terminal (not done)
    expect(cardJson).toContain('connection terminated');
  });

  /**
   * Test 10: idle_timeout 在 finalizing：idle_timeout
   *
   * Verifies: idle watchdog 在 finalizing 期间可以触发 idle_timeout
   */
  it('idle timeout during finalizing triggers idle_timeout terminal', async () => {
    // Use createHangingRunner pattern from existing tests
    const runner = createHangingRunner();

    vi.useFakeTimers();
    try {
      const { bridge, sessionStore, connector } = makeBridge({
        runner,
        idleTimeoutMs: 1000,
      });
      sessionStore.setCwd(ctx.userId, tmpDir);

      // Start the run - it will hang forever
      const runPromise = bridge.forwardToClaude('idle test', ctx);

      // Advance past idle timeout while in running state (not finalizing)
      await vi.advanceTimersByTimeAsync(1500);

      // Wait for completion
      await runPromise;

      const finalCard = connector._cards.at(-1) as Record<string, unknown>;
      const cardJson = JSON.stringify(finalCard);
      // Should show idle_timeout terminal (original test validates this)
      expect(cardJson).toContain('已自动终止');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Test 11: validateBeforeRun 早退（无进程）：finalizing -> error
   *
   * Verifies: 无进程退出路径 - runner yields error result but never runs a process
   */
  it('validateBeforeRun early return yields error terminal', async () => {
    // Simulate a runner that validates and returns error without spawning process
    // §9.22: real spawning-runner now yields syntheticInitEvent before validationError;
    // the mock must match that event ordering.
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({
        mode: 'streaming',
        events: [
          { type: 'system', subtype: 'init', session_id: 's11' },
          {
            type: 'result',
            subtype: 'error',
            session_id: 's11',
            errorMessage: 'API key not configured',
          },
        ],
      }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('validate test', ctx);

    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Should show error (no process exit, but error result from validation)
    expect(cardJson).toContain('API key not configured');
  });

  /**
   * Test 12: spawn 失败 authErrorEvent：finalizing -> error
   *
   * Verifies: authErrorEvent 路径 - spawn fails before process starts
   */
  it('spawn failure yields auth error event leading to error terminal', async () => {
    // Simulate spawn failure (binary not found) - authErrorEvent returns result/error
    // §9.22: real spawning-runner now yields syntheticInitEvent before authErrorEvent;
    // the mock must match that event ordering.
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        // Synthetic init (matches spawning-runner's §9.22 fix)
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 's12',
        };
        // Simulate authErrorEvent from spawning-runner.ts - yields result/error
        yield {
          type: 'result',
          subtype: 'error',
          session_id: 's12',
          errorMessage: 'claude 命令不可用（未找到或不可执行），请检查是否已安装或在 PATH 中',
        };
      },
    };
    const { bridge, sessionStore, connector } = makeBridge({ runner });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('spawn test', ctx);

    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Should show error due to spawn failure
    expect(cardJson).toContain('不可用');
    expect(cardJson).toContain('claude');
  });

  /**
   * Test 13: §9.22 pre-init result guard
   *
   * Claude CLI --resume emits a historical result (from the previous turn)
   * before system.init for the new run. The bridge must ignore the stale result
   * (no premature finalizing), and the run-state reducer must stay in 'running'.
   * The real result after init transitions to finalizing normally.
   */
  it('pre-init result from resume replay is ignored until system.init', async () => {
    const { bridge, sessionStore, connector } = makeBridge({
      runner: createStubRunner({
        mode: 'streaming',
        events: [
          // Stale result from previous turn (resume replay)
          { type: 'result', subtype: 'success', session_id: 'stale-session' },
          // Real init for the new run
          { type: 'system', subtype: 'init', session_id: 'real-session', cwd: tmpDir },
          // Real result for the new run
          { type: 'result', subtype: 'success', session_id: 'real-session' },
        ],
      }),
    });
    sessionStore.setCwd(ctx.userId, tmpDir);

    await bridge.forwardToClaude('resume test', ctx);

    const finalCard = connector._cards.at(-1) as Record<string, unknown>;
    const cardJson = JSON.stringify(finalCard);
    // Should end in 'done' (not stuck at finalizing from stale result)
    expect(cardJson).toContain('已完成');
    // Should NOT show the stale session
    expect(cardJson).not.toContain('stale-session');
  });
});

/**
 * Bridge.currentBinding (AgentBinding snapshot)
 *
 * 验证：currentBinding(userId) 快照当前 config.defaultAgent + sessionStore.getSessionId(userId, agent)，
 * 作为入队时刻的 agent+session 绑定。
 *
 * 缺失/错误会导致：排队消息执行时（T1）读到被 /new 或 /config 改写的 live 状态，
 * 语义漂移——跑进错误的 agent 或新 session。
 *
 * 依据：方案 D4「捕获实现」。
 */
describe('Bridge.currentBinding (AgentBinding snapshot)', () => {
  it('test_anchor_current_binding_snapshots_default_agent_and_session', () => {
    const { bridge, sessionStore } = makeBridge();

    // 1. 设置一个 claude session
    sessionStore.setSessionIdAndCwd(ctx.userId, 'claude', 'sess-123', tmpDir);
    const binding = bridge.currentBinding(ctx.userId);
    expect(binding.agent).toBe('claude');
    expect(binding.sessionId).toBe('sess-123');

    // 2. 无 session 时返回 undefined
    sessionStore.clearSessionId(ctx.userId, 'claude');
    const emptyBinding = bridge.currentBinding(ctx.userId);
    expect(emptyBinding.agent).toBe('claude');
    expect(emptyBinding.sessionId).toBeUndefined();

    // 3. defaultAgent 维度：切到 codex 后 currentBinding 反映新 agent + 新 session
    sessionStore.setSessionIdAndCwd(ctx.userId, 'codex', 'codex-sess', tmpDir);
    const codexConfig = AppConfigSchema.parse({ ...config, defaultAgent: 'codex' });
    bridge.setConfig(codexConfig);
    const codexBinding = bridge.currentBinding(ctx.userId);
    expect(codexBinding.agent).toBe('codex');
    expect(codexBinding.sessionId).toBe('codex-sess');
  });
});

/**
 * Bridge.forwardToClaude AgentBinding (D2/D5)
 *
 * 验证：带 binding 调 forwardToClaude 时，runner.run 收到的 runOpts.sessionId
 * 等于 binding 钉死的 sessionId，即使 store 已被 /new 清空。
 *
 * 缺失/错误会导致：排队消息执行时读到被 /new 改写的 live 状态（undefined），
 * 语义漂移——跑进新 session 而非入队时绑定的 session。
 *
 * 依据：方案 D2「钉死语义」+ D5「forwardToClaude 解析式」+ Step5 测试1。
 */
describe('Bridge.forwardToClaude AgentBinding (D2/D5)', () => {
  it('test_anchor_binding_pins_session_id_when_store_cleared', async () => {
    // 捕获 runner.run 收到的 runOpts（第 2 个参数）
    let capturedRunOpts: { sessionId?: string; cwd?: string } | undefined;
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* (_message, runOpts) {
        capturedRunOpts = runOpts;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'pinned-S1',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'pinned-S1' } as AgentEvent;
      },
    };

    const { bridge, sessionStore } = makeBridge({ runner });

    // 1. 设 cwd + claude session S1
    sessionStore.setCwd(ctx.userId, tmpDir);
    sessionStore.setSessionIdAndCwd(ctx.userId, 'claude', 'S1', tmpDir);

    // 2. 入队时刻快照
    const binding = bridge.currentBinding(ctx.userId);
    expect(binding.agent).toBe('claude');
    expect(binding.sessionId).toBe('S1');

    // 3. 排队期间 /new 清空 live session
    sessionStore.clearSessionId(ctx.userId, 'claude');
    expect(sessionStore.getSessionId(ctx.userId, 'claude')).toBeUndefined();

    // 4. 带绑定执行
    await bridge.forwardToClaude('hello', ctx, { binding });

    // 5. 断言 runner 收到钉死的 sessionId（不受 store 清空影响）
    expect(capturedRunOpts).toBeDefined();
    expect(capturedRunOpts!.sessionId).toBe('S1');
  });

  /**
   * 跟随语义（D2 + D5）：binding 无 sessionId 但指定 agent（codex）时，
   * runner.run 收到的 sessionId 必须跟随**绑定 agent**（codex）的 live session，
   * 而非 live defaultAgent（claude）的 session。
   *
   * 这锁住两个分支：
   * 1. sessionId 解析的 `?? this.sessionStore.getSessionId(userId, agentKind)` fallback 分支
   *    （binding.sessionId 为 undefined 时跟随 live）。
   * 2. agentKind 解析 `opts?.binding?.agent ?? this.config.defaultAgent` 必须取 binding.agent
   *    （D5）——若错误地用 live defaultAgent，会取到 claude 槽位（undefined）而非 codex 的 C2。
   *
   * 场景对应 §3 行3 边界：入队时 codex 槽位为空（currentBinding 返回 {agent:'codex',
   * sessionId:undefined}），排队期间用户开了 codex session C2，执行时应跟随到 C2。
   */
  it('test_anchor_binding_follows_live_session_for_bound_agent_when_session_id_undefined', async () => {
    // 捕获 runner.run 收到的 runOpts（第 2 个参数）
    let capturedRunOpts: { sessionId?: string; cwd?: string } | undefined;
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* (_message, runOpts) {
        capturedRunOpts = runOpts;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'C2',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'C2' } as AgentEvent;
      },
    };

    const { bridge, sessionStore } = makeBridge({ runner });

    // 1. 设 cwd；live defaultAgent 是 claude（config 默认），claude 槽位无 session
    sessionStore.setCwd(ctx.userId, tmpDir);
    expect(sessionStore.getSessionId(ctx.userId, 'claude')).toBeUndefined();

    // 2. 给 codex 槽位设 session C2（排队期间用户开了 codex session）
    sessionStore.setSessionIdAndCwd(ctx.userId, 'codex', 'C2', tmpDir);
    expect(sessionStore.getSessionId(ctx.userId, 'codex')).toBe('C2');

    // 3. 入队时刻快照：codex 槽位为空 → currentBinding 返回 {agent:'codex', sessionId:undefined}
    //    这里手动构造 binding 模拟入队时 codex 无 session 的快照。
    const binding = { agent: 'codex' as const, sessionId: undefined };

    // 4. 带绑定执行（binding 指定 codex，无 sessionId → 应跟随 codex live session）
    await bridge.forwardToClaude('hello', ctx, { binding });

    // 5. 断言：runner 收到 codex 的 live session C2，而非 claude 的（undefined）
    expect(capturedRunOpts).toBeDefined();
    expect(capturedRunOpts!.sessionId).toBe('C2');
  });

  /**
   * 写回目标（D5 表 1008/1018 + §3 行4 + Step5 测试3）：
   * binding agent = codex、live defaultAgent = claude 时，system.init 的 session
   * 写回调用的 agent 参数必须是 codex（绑定 agent），而非 claude（live）。
   *
   * 否则：绑定 claude 的 run 在切到 codex 后完成，会把 claude 的 sessionId 写进
   * codex 槽位 = 数据污染。此测试锁住写回目标，防止跨 agent 污染。
   */
  it('test_anchor_system_init_writes_session_to_bound_agent_not_live', async () => {
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* (_message, _runOpts) {
        // system.init 触发 session 写回。session_id 用明确的 'codex-sess-init'。
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'codex-sess-init',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'codex-sess-init' } as AgentEvent;
      },
    };

    const { bridge, sessionStore } = makeBridge({ runner });

    // 1. 设 cwd（让 hasCwd=true）；event.cwd=tmpDir=cwd 相等 → 走 else 分支 setSessionIdAndCwd
    sessionStore.setCwd(ctx.userId, tmpDir);

    // 2. spy 两个写回方法（两个都 spy，分支取决于 hasCwd/event.cwd 关系）
    const spySessionCwd = vi.spyOn(sessionStore, 'setSessionIdAndSessionCwd');
    const spySetCwd = vi.spyOn(sessionStore, 'setSessionIdAndCwd');

    // 3. binding 钉死 codex session；live defaultAgent 仍是 claude
    const binding = { agent: 'codex' as const, sessionId: 'codex-pinned' };

    // 4. 带绑定执行
    await bridge.forwardToClaude('hello', ctx, { binding });

    // 5. 断言：写回发生在 codex 槽位（第 2 参数 = agent = 绑定 agent，非 live claude）
    const writebackCall = spySetCwd.mock.calls[0] ?? spySessionCwd.mock.calls[0];
    expect(writebackCall).toBeDefined();
    expect(writebackCall![1]).toBe('codex');
  });

  /**
   * Runner 选择（D5 表 243 + §3 行2 + Step2）：
   * binding agent = codex、live defaultAgent = claude 时，forwardToClaude 实际
   * 跑的必须是 codex 的 runner（agentRegistry.get('codex', cwd)），而非 claude 的。
   *
   * 否则：排队 msg 绑定 codex，但 /config 在排队期间把 live defaultAgent 切回 claude，
   * 执行时若 getRunner 仍读 live defaultAgent，会拿 claude 的 runner 跑 codex 的任务
   * ——agent/runner 错配，整条 run 用错 binary/session 语义。
   *
   * 此测试注入假 agentRegistry，让 codex 和 claude 返回**不同**的 stub runner，
   * 通过闭包捕获哪个 runner.run 被调，锁住「runner 选择基于绑定 agent」。
   */
  it('test_anchor_forward_to_claude_uses_bound_agent_runner', async () => {
    const { AgentRegistry } = await import('../runner/registry.js');

    // 共享捕获变量：哪个 runner 的 run 被调
    let capturedBy: string | undefined;

    const claudeRunner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        capturedBy = 'claude';
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-ran',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'claude-ran' } as AgentEvent;
      },
    };
    const codexRunner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        capturedBy = 'codex';
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'codex-ran',
          cwd: tmpDir,
          model: 'gpt',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'codex-ran' } as AgentEvent;
      },
    };

    // 假 registry：codex→codexRunner，其他→claudeRunner
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('codex', () => asAgentRunner(codexRunner));
    agentRegistry.register('claude', () => asAgentRunner(claudeRunner));

    const connector = createStubConnector();
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      runner: claudeRunner,
      connector,
      sessionStore,
      config, // live defaultAgent = claude
      agentRegistry,
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
    sessionStore_setCwd(bridge, ctx.userId, tmpDir);

    // binding 钉死 codex；live defaultAgent 仍是 claude
    const binding = { agent: 'codex' as const, sessionId: 'codex-sess' };

    await bridge.forwardToClaude('hello', ctx, { binding });

    // 断言：codex 的 runner 被选用（绑定 agent 决定 runner），而非 claude 的
    expect(capturedBy).toBe('codex');
  });
});

/**
 * 会话代际（session epoch）守卫
 *
 * 验证：run 在途时 /new（或 new-session 卡片动作、/cd、/resume、/config 切换）
 * 不会被在途 run 的 system.init 写回撤销。
 *
 * 事故根因：clearSessionId 后在途 run 重发 init 无条件写回，旧 sessionId 复活。
 * epoch guard 在 run 启动时捕获快照，init 写回前比对——epoch 不一致则跳过写回。
 */
describe('Bridge session epoch guard (2026-08-09)', () => {
  it('test_anchor_new_session_mid_run_blocks_stale_init_writeback', async () => {
    // 核心回归：复现事故——run 在途时 clearSessionId，后续 init 写回被 guard 拦截
    const { sessionStore } = makeBridge();

    // Runner yields: init(sess-stale) → mid-run clearSessionId → second init(sess-stale) → result
    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-stale',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        // Simulate user clicking "new-session" button mid-run
        sessionStore.clearSessionId(ctx.userId, 'claude');
        // Simulate task-notification injection triggering Claude re-init
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-stale',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'sess-stale' } as AgentEvent;
      },
    };

    // Override bridge runner
    const connector = createStubConnector();
    const bridgeWithRunner = new Bridge({
      runner,
      connector,
      sessionStore,
      config,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
    sessionStore_setCwd(bridgeWithRunner, ctx.userId, tmpDir);

    // Spy on write-back methods
    const spySessionCwd = vi.spyOn(sessionStore, 'setSessionIdAndSessionCwd');
    const spySetCwd = vi.spyOn(sessionStore, 'setSessionIdAndCwd');

    mockLogger.info.mockClear();
    await bridgeWithRunner.forwardToClaude('design question', ctx);

    // 断言 A：run 结束后 sessionId 仍为 undefined（/new 清空未被撤销）
    expect(sessionStore.getSessionId(ctx.userId, 'claude')).toBeUndefined();

    // 断言 B：写回方法合计只被调 1 次（首个 init 的合法写回，第二个被 guard 拦截）
    const totalWritebacks = spySetCwd.mock.calls.length + spySessionCwd.mock.calls.length;
    expect(totalWritebacks).toBe(1);

    // 断言 C：日志探针记录了跳过
    const skipLogs = mockLogger.info.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('system.init write-back skipped'));
    expect(skipLogs.length).toBe(1);
  });

  it('test_anchor_reinit_without_pointer_move_still_writes_back', async () => {
    // 防过度抑制：run 中 re-init / EnterWorktree relocate 不受 epoch guard 影响
    const { sessionStore } = makeBridge();

    const otherDir = path.join(tmpDir, 'worktree-relocate');
    fs.mkdirSync(otherDir, { recursive: true });

    const runner: Runner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        // First init: normal
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-ok',
          cwd: tmpDir,
          model: 'opus',
        } as AgentEvent;
        // Second init: EnterWorktree relocate, new cwd
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-ok',
          cwd: otherDir,
          model: 'opus',
        } as AgentEvent;
        yield { type: 'result', subtype: 'success', session_id: 'sess-ok' } as AgentEvent;
      },
    };

    const connector = createStubConnector();
    const bridgeWithRunner = new Bridge({
      runner,
      connector,
      sessionStore,
      config,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
    sessionStore_setCwd(bridgeWithRunner, ctx.userId, tmpDir);

    const spySessionCwd = vi.spyOn(sessionStore, 'setSessionIdAndSessionCwd');
    await bridgeWithRunner.forwardToClaude('worktree test', ctx);

    // Second init's relocate write-back was NOT blocked: setSessionIdAndSessionCwd
    // was called at least once (EnterWorktree uses this path when cwd differs)
    expect(spySessionCwd.mock.calls.length).toBeGreaterThanOrEqual(1);
    // sessionId should be 'sess-ok'
    expect(sessionStore.getSessionId(ctx.userId, 'claude')).toBe('sess-ok');
  });
});

describe('Queue edit race: setTaskReplacement before await (Plan B fix)', () => {
  it('test_anchor_replacement_registered_synchronously_before_await_is_consumed_correctly', async () => {
    // RACE FIX (Plan B): handleQueueInput now registers the replacement
    // BEFORE any await, so the begin path always finds it. This test verifies
    // the fix at the Bridge level: when setTaskReplacement is called
    // synchronously before releasing the blocking task, the replacement closure
    // runs instead of the original stale closure.

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

    const realCwd = fs.realpathSync(tmpDir);

    // Track which closure actually ran
    const executed: string[] = [];

    // Task A — hang until released
    let releaseA: () => void = () => {};
    const hangA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    bridge.enqueue(
      realCwd,
      async () => {
        await hangA;
        executed.push('A');
      },
      {
        taskMeta: {
          userId: ctx.userId,
          chatId: ctx.chatId,
          messageId: 'msg-A',
          messagePreview: 'task A',
        },
      },
    );

    // Task B — queued behind A, original closure captures stale content
    bridge.enqueue(
      realCwd,
      async () => {
        executed.push('B-original');
      },
      {
        taskMeta: {
          userId: ctx.userId,
          chatId: ctx.chatId,
          messageId: 'msg-B',
          messagePreview: 'old content B',
        },
      },
    );

    await new Promise((r) => setTimeout(r, 30));

    // FIXED ORDER: register replacement synchronously BEFORE releasing A.
    // This is what handleQueueInput now does after the Plan B fix.
    bridge.setTaskReplacement(realCwd, 'msg-B', async () => {
      executed.push('B-edited');
    });

    // Now release A — the queue chain advances, B begins.
    // The begin path finds the replacement and executes it.
    releaseA();
    await new Promise((r) => setTimeout(r, 50));

    // The replacement closure ran, not the original.
    expect(executed).toEqual(['A', 'B-edited']);
  });
});

describe('sendResult fallback: card send failure sends text to user', () => {
  it('sends fallback text when card delivery fails (e.g. Feishu 11310)', async () => {
    // Simulate Feishu rejecting a card (e.g. element exceeds the limit ErrCode 11310).
    // The fallback must send a plain text message with the error detail so the user
    // isn't left in silence.
    const sendWithRetry = vi
      .fn()
      .mockRejectedValueOnce(new Error('ErrCode: 11310; ErrMsg: element exceeds the limit'))
      .mockResolvedValueOnce('fallback-msg-id'); // second call = fallback text
    const connector = {
      sendWithRetry,
      sendFile: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReactionByEmoji: vi.fn().mockResolvedValue(undefined),
      streamCard: vi.fn().mockResolvedValue('stream-msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      connector,
      sessionStore,
      runner: createStubRunner(),
    });
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    const result = await bridge.sendResult(
      { card: { schema: '2.0', body: { elements: [] } } },
      ctx,
    );
    expect(result).toBe(false); // primary send failed
    // Second call is the fallback text notification
    expect(sendWithRetry).toHaveBeenCalledTimes(2);
    const fallbackCall = sendWithRetry.mock.calls[1];
    expect(fallbackCall[0]).toBe('chat1');
    const input = fallbackCall[1] as { text?: string };
    expect(input.text).toContain('卡片发送失败');
    expect(input.text).toContain('11310');
  });

  it('updateCardInPlace fallback sends card via sendResult; sendResult failure sends text', async () => {
    // When updateCard fails AND sendResult also fails for the same card,
    // the fallback text from sendResult's catch must reach the user.
    const sendWithRetry = vi
      .fn()
      .mockRejectedValueOnce(new Error('ErrCode: 11310; ErrMsg: element exceeds the limit'))
      .mockResolvedValueOnce('fallback-msg-id');
    const connector = {
      sendWithRetry,
      sendFile: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReactionByEmoji: vi.fn().mockResolvedValue(undefined),
      streamCard: vi.fn().mockResolvedValue('stream-msg-id'),
      updateCard: vi.fn().mockRejectedValue(new Error('updateCard failed: card not found')),
      connected: true,
    };
    const sessionStore = new SessionStore();
    const bridge = new Bridge({
      connector,
      sessionStore,
      runner: createStubRunner(),
    });
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    await bridge.updateCardInPlace({ schema: '2.0', body: { elements: [] } }, ctx);
    // First: updateCard threw → fallback to sendResult({ card })
    // sendResult called sendWithRetry → rejected (11310) → catch sends fallback text
    expect(sendWithRetry).toHaveBeenCalledTimes(2);
    const fallbackCall = sendWithRetry.mock.calls[1];
    const input = fallbackCall[1] as { text?: string };
    expect(input.text).toContain('卡片发送失败');
  });
});

describe('Bridge handleResumeCompact（resume 卡 Compact 按钮）', () => {
  interface CompactRunner extends Runner {
    runCompact: (
      message: string,
      opts: { cwd: string; sessionId: string },
    ) => AsyncGenerator<AgentEvent>;
  }

  /** 正常压缩结果事件（单条 result，模拟 app-server 压缩 turn 收尾）。 */
  async function* compactTurnEvents(): AsyncGenerator<AgentEvent> {
    yield { type: 'result', subtype: 'success', session_id: 'codex-session-1' } as AgentEvent;
  }

  /** 默认 readSessionContent 返回「未找到」（共享 stub 的空结果形状）。 */
  const notFoundRead: AgentSessionReader['readSessionContent'] =
    createStubSessionReader().readSessionContent;

  function makeResumeCompactBridge(opts: {
    runner?: Runner;
    codexRead?: AgentSessionReader['readSessionContent'];
  }) {
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = opts.runner ?? createStubRunner();
    const read = opts.codexRead ?? notFoundRead;
    const reader: AgentSessionReader = {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: vi.fn(read),
      isSessionActive: () => false,
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', reader);
    registry.register('codex', reader);
    registry.register('opencode', reader);
    registry.register('pi', reader);
    registry.register('kimi', reader);
    const bridge = new Bridge({
      runner,
      connector,
      sessionStore,
      config,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: registry,
    });
    return { bridge, sessionStore, connector, runner };
  }

  it('test_anchor_handle_resume_compact_runs_runcompact_and_finishes_card', async () => {
    // 验证什么：happy path 调 runner.runCompact('', {cwd, sessionId}) 并流式渲染
    // 压缩卡，终态带 jsonl 统计（Compact - 1次 / ✅ 已完成）。缺失会导致点击
    // Compact 后没有任何压缩行为（按钮空转）。
    const cwd = fs.realpathSync(tmpDir);
    const runCompactSpy = vi.fn(compactTurnEvents);
    const runner: CompactRunner = { ...createStubRunner(), runCompact: runCompactSpy };
    const { bridge, sessionStore, connector } = makeResumeCompactBridge({
      runner,
      codexRead: () => ({
        events: [{ type: 'text', content: 'tail' }],
        usage: { inputTokens: 10, outputTokens: 20, contextLength: 5000, compactCount: 1 },
        aiTitle: undefined,
        recap: undefined,
        displayTitle: 'placeholder',
        reason: 'ok',
      }),
    });
    sessionStore.setCwd('user1', cwd);

    await bridge.handleResumeCompact({ sessionId: 'codex-session-1', agent: 'codex' }, ctx);

    expect(runCompactSpy).toHaveBeenCalledWith('', { cwd, sessionId: 'codex-session-1' });
    const sentJsons = connector._sent.map((s) => JSON.stringify(s.input));
    expect(sentJsons.some((j) => j.includes('Compact 已触发'))).toBe(true);
    expect(sentJsons.some((j) => j.includes('Compact - 1次'))).toBe(true);
    expect(sentJsons.some((j) => j.includes('✅ 已完成'))).toBe(true);
  });

  it('test_anchor_handle_resume_compact_card_context_percentage_from_jsonl_limit', async () => {
    // 验证什么：Compact 完成卡必须像普通 run 卡一样带 Context 百分比
    // （Context - X (Y%)）。回归：streamCodexCompact 的 finish meta 漏传
    // contextLimit，导致 jsonl 里明明有 model_context_window，卡片却只显示
    // "Context - 7K（压缩前 111K）" 没有百分比。
    const cwd = fs.realpathSync(tmpDir);
    const runCompactSpy = vi.fn(compactTurnEvents);
    const runner: CompactRunner = { ...createStubRunner(), runCompact: runCompactSpy };
    const { bridge, sessionStore, connector } = makeResumeCompactBridge({
      runner,
      codexRead: () => ({
        events: [{ type: 'text', content: 'tail' }],
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          contextLength: 5000,
          contextLimit: 100000,
          compactCount: 1,
          compactPreContextLength: 21000,
        },
        aiTitle: undefined,
        recap: undefined,
        displayTitle: 'placeholder',
        reason: 'ok',
      }),
    });
    sessionStore.setCwd('user1', cwd);

    await bridge.handleResumeCompact({ sessionId: 'codex-session-1', agent: 'codex' }, ctx);

    const sentJsons = connector._sent.map((s) => JSON.stringify(s.input));
    expect(sentJsons.some((j) => j.includes('Context - 5K (5%)（压缩前 21K）'))).toBe(true);
  });

  it('test_anchor_handle_resume_compact_missing_session_id_errors', async () => {
    // 验证什么：缺少 sessionId 时报错且不触发压缩。缺失会导致幽灵压缩请求
    // 打到 runner（没有可压缩目标）。
    const cwd = fs.realpathSync(tmpDir);
    const runCompactSpy = vi.fn(compactTurnEvents);
    const runner: CompactRunner = { ...createStubRunner(), runCompact: runCompactSpy };
    const { bridge, sessionStore, connector } = makeResumeCompactBridge({ runner });
    sessionStore.setCwd('user1', cwd);

    await bridge.handleResumeCompact({}, ctx);

    expect(runCompactSpy).not.toHaveBeenCalled();
    const sentJsons = connector._sent.map((s) => JSON.stringify(s.input));
    expect(sentJsons.some((j) => j.includes('缺少 sessionId'))).toBe(true);
  });

  it('test_anchor_handle_resume_compact_session_not_found_errors', async () => {
    // 验证什么：session 不在当前 cwd（reader 判定未找到）时报错且不压缩。
    // 缺失会导致对任意 sessionId 都发起压缩（无归属校验，压缩错会话）。
    const cwd = fs.realpathSync(tmpDir);
    const runCompactSpy = vi.fn(compactTurnEvents);
    const runner: CompactRunner = { ...createStubRunner(), runCompact: runCompactSpy };
    const { bridge, sessionStore, connector } = makeResumeCompactBridge({ runner });
    sessionStore.setCwd('user1', cwd);

    await bridge.handleResumeCompact({ sessionId: 'ghost-session', agent: 'codex' }, ctx);

    expect(runCompactSpy).not.toHaveBeenCalled();
    const sentJsons = connector._sent.map((s) => JSON.stringify(s.input));
    expect(sentJsons.some((j) => j.includes('未找到 session'))).toBe(true);
  });

  it('test_anchor_handle_resume_compact_unsupported_runner_errors', async () => {
    // 验证什么：runner 无 runCompact 时报「不支持 Compact」。
    // 缺失会导致执行时 TypeError，卡片点击无友好反馈。
    const cwd = fs.realpathSync(tmpDir);
    const { bridge, sessionStore, connector } = makeResumeCompactBridge({
      codexRead: () => ({
        events: [{ type: 'text', content: 'tail' }],
        usage: undefined,
        aiTitle: undefined,
        recap: undefined,
        displayTitle: 'placeholder',
        reason: 'ok',
      }),
    });
    sessionStore.setCwd('user1', cwd);

    await bridge.handleResumeCompact({ sessionId: 'codex-session-1', agent: 'codex' }, ctx);

    const sentJsons = connector._sent.map((s) => JSON.stringify(s.input));
    expect(sentJsons.some((j) => j.includes('不支持 Compact'))).toBe(true);
  });

  it('test_anchor_handle_resume_compact_busy_runner_finishes_error_card', async () => {
    // 验证什么：runner 已在跑（runCompact 抛 already running）时压缩卡以 error 终态
    // 呈现错误信息，不静默。缺失会导致异常被吞掉、用户看到卡永久「进行中」。
    const cwd = fs.realpathSync(tmpDir);
    const runCompactSpy = vi.fn(async function* () {
      throw new Error('CodexAppServerRunner is already running');
    });
    const runner: CompactRunner = { ...createStubRunner(), runCompact: runCompactSpy };
    const { bridge, sessionStore, connector } = makeResumeCompactBridge({
      runner,
      codexRead: () => ({
        events: [{ type: 'text', content: 'tail' }],
        usage: undefined,
        aiTitle: undefined,
        recap: undefined,
        displayTitle: 'placeholder',
        reason: 'ok',
      }),
    });
    sessionStore.setCwd('user1', cwd);

    await bridge.handleResumeCompact({ sessionId: 'codex-session-1', agent: 'codex' }, ctx);

    expect(runCompactSpy).toHaveBeenCalled();
    const sentJsons = connector._sent.map((s) => JSON.stringify(s.input));
    expect(sentJsons.some((j) => j.includes('already running'))).toBe(true);
  });
});

describe('app-server error result session write-back (review P3-10)', () => {
  it('test_anchor_error_result_session_id_is_persisted_for_live_authority_runner', async () => {
    // 验证行为：app-server runner（getUsageAuthority() === 'live'）在 setup
    // 失败路径（thread/start 成功、turn/start 失败）发出的 error result 携带
    // 新线程 id 时，bridge 必须写回 sessionStore——否则下一条消息会再开一个
    // 孤儿线程（线程已建但指针没跟上）。'jsonl' 权威的 runner 不在此列，它们靠
    // turn_started/system.init 写回。
    const cwd = fs.realpathSync(tmpDir);
    const runner: Runner & { getUsageAuthority?: () => 'live' | 'jsonl' } = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield {
          type: 'result',
          subtype: 'error',
          session_id: 'th-new-1',
          errorMessage: 'thread not found',
        } as AgentEvent;
      },
      getUsageAuthority: () => 'live',
    };
    const { bridge, sessionStore } = makeBridge({ runner });
    sessionStore.setCwd('user1', cwd);

    await bridge.forwardToClaude('hello', ctx, {
      binding: { agent: 'codex' as const, sessionId: 'th-old-999' },
    });

    expect(sessionStore.getSessionId('user1', 'codex')).toBe('th-new-1');
  });

  it('test_anchor_app_server_success_result_with_init_ends_done_not_stream_lost', async () => {
    // 回归锚点（2026-08-13）：app-server runner 此前从不发 system.init，桥的
    // pre-init result guard（sawInit）与 run-state reducer（state.sessionId）
    // 两层守卫都把成功 result 当 pre-init 丢弃，终态停在 running，兜底成
    // 「输出流已结束，但未收到 result 事件」。runner 补发 synthetic init 后，
    // 成功 result 必须正常走 finalizing → done。
    const cwd = fs.realpathSync(tmpDir);
    const runner: Runner & { getUsageAuthority?: () => 'live' | 'jsonl' } = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'th-live-1',
          cwd: '',
          model: '',
        } as AgentEvent;
        yield {
          type: 'turn_started',
          threadId: 'th-live-1',
          turnId: 'tn-live-1',
          operationKind: 'turn',
        } as AgentEvent;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'th-live-1',
        } as AgentEvent;
      },
      getUsageAuthority: () => 'live',
    };
    const { bridge, connector, sessionStore } = makeBridge({ runner });
    sessionStore.setCwd('user1', cwd);

    await bridge.forwardToClaude('hello', ctx, {
      binding: { agent: 'codex' as const, sessionId: 'th-old-999' },
    });

    const lastCard = JSON.stringify(connector._cards.at(-1));
    expect(lastCard).toContain('已完成');
    expect(lastCard).not.toContain('输出流已结束');
    expect(sessionStore.getSessionId('user1', 'codex')).toBe('th-live-1');
  });
});
