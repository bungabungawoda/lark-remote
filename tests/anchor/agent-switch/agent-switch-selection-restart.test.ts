import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Bridge } from '../../../src/bridge/index.js';
import type { AgentKind, AgentSessionReader } from '../../../src/runner/index.js';

/**
 * Round 3 red: /resume 显式选择在「重启发生在首次切入之前」时被 load 缺省洗掉。
 *
 * 攻击点（spec 新语义 T4 变体，非 R1-R2 重复）：
 * - T4 任务的 restart 场景是「显式分支已跑、arrival=选择 已持久化」后的重建，
 *   该场景走既有恢复（另有守卫）。
 * - 本测试是 T4 的「重启前置」变体：/resume 选择后、首次 config.save 切入前
 *   bridge 重启——arrival[new] 从未被任何分支写入（用户从未「到达」new），
 *   但 SessionStore.load() 的迁移缺省「arrival 缺失 → 默认 = session」给从未
 *   到达过的非当前 agent 伪造了一条到达基线，Step 2.5 触发条件被洗成相等，
 *   显式选择在切入时被清空并发「session 已清空」。
 */

function createMockBridge(): Bridge {
  const mock = {
    sendResult: vi.fn().mockResolvedValue(true),
    updateCardInPlace: vi.fn().mockResolvedValue(undefined),
    forwardToClaude: vi.fn().mockResolvedValue(undefined),
    isBusy: false,
    isBusyFor: vi.fn().mockReturnValue(false),
    enqueue: vi.fn(),
    enqueueImmediate: vi.fn(),
    interruptCurrentRun: vi.fn().mockResolvedValue(false),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setConfig: vi.fn(),
    setIdleTimeout: vi.fn(),
    clearRunners: vi.fn(),
    removeFromQueue: vi.fn().mockReturnValue(false),
    getQueuedTasks: vi.fn().mockReturnValue([]),
    getQueuedTask: vi.fn().mockReturnValue(undefined),
    getQueueInfo: vi.fn().mockReturnValue({ position: 0, isRunning: false, tasksAhead: 0 }),
    getAllActiveRuns: vi.fn().mockReturnValue(new Map()),
    sendFile: vi.fn().mockResolvedValue(''),
    getActiveRunFor: vi.fn().mockReturnValue(undefined),
  } as unknown as Bridge;
  return mock;
}

function stubReader(opts: { known?: string[]; newest?: string | null }): AgentSessionReader {
  const known = new Set(opts.known ?? []);
  return {
    listSessions: vi.fn(() => ({ sessions: [], total: 0 })),
    getNewestSession: vi.fn(() => (opts.newest ? { sessionId: opts.newest, summary: '' } : null)),
    readSessionContent: vi.fn((sessionId: string) =>
      known.has(sessionId)
        ? {
            events: [{ type: 'system', subtype: 'init', session_id: sessionId, cwd: '' }],
          }
        : { events: [] },
    ),
    isSessionActive: vi.fn(() => false),
  } as unknown as AgentSessionReader;
}

function createRegistry(readers: Record<string, AgentSessionReader>): SessionReaderRegistry {
  const registry = new SessionReaderRegistry();
  for (const [kind, reader] of Object.entries(readers)) {
    registry.register(kind as AgentKind, reader);
  }
  return registry;
}

function defaultRegistry(): SessionReaderRegistry {
  return createRegistry({
    claude: stubReader({ known: ['claude-session-X'] }),
    codex: stubReader({ known: ['codex-session-C1', 'codex-session-C2'], newest: null }),
    pi: stubReader({ known: ['pi-session-P', 'pi-session-P1'] }),
    opencode: stubReader({ known: [] }),
    kimi: stubReader({ known: [] }),
  });
}

function buildConfig(overrides?: Partial<AppConfig>): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'claude',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: {
      pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' },
      codex: { model: 'claude-sonnet-4-20250514' },
      opencode: { model: 'gpt-5' },
      kimi: { model: 'kimi-k2' },
    },
    workspace: { default: '' },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
    ...overrides,
  });
}

describe('R3 red: explicit selection survives restart before first switch-in', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(
    defaultAgent: string,
    store: SessionStore = new SessionStore(),
    registry: SessionReaderRegistry = defaultRegistry(),
  ): void {
    sessionStore = store;
    bridge = createMockBridge();
    router = new CommandRouter({
      sessionStore,
      bridge,
      config: buildConfig({ defaultAgent: defaultAgent as AppConfig['defaultAgent'] }),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: registry,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-restart-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function doSwitch(
    userId: string,
    ctx: { userId: string; chatId: string; messageId: string },
    to: string,
  ): Promise<unknown> {
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: to }, ctx);
    return router.handleCardAction({ cmd: 'config.save' }, ctx);
  }

  function lastNotice(): string {
    const calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    return (calls[calls.length - 1][0] as { text: string }).text;
  }

  it('test_anchor_r3_selection_survives_restart_before_first_switch', async () => {
    /**
     * ① 验证：/resume 对**从未到达过**的目标 agent（pi）显式选择 P1 后，bridge
     *    重启（系统事件，非用户活动）发生在首次 config.save 切入之前。重启后
     *    sessions[pi]=P1 仍持久化，但 load() 迁移缺省「arrival 缺失 → 默认 =
     *    session」把 arrival[pi] 洗成 P1（用户从未经 config.save 到达 pi），
     *    Step 2.5 触发条件 (newSessionId ?? '') !== (arrival ?? '') 被洗成相等
     *    → 切入走清空分支：sessions[pi] 被清、arrival=''、消息「session 已清空」。
     *    显式选择必须存活：切入应走显式分支（sessions/arrival=P1、消息
     *    「已使用所选 session」、prev[codex]=C1 停车）。
     * ② 缺失/错误影响：用户明确选择的会话在系统重启后被丢弃，收到误导性
     *    「session 已清空」；bridge 重启/崩溃/看门狗拉起都属于系统事件，不是
     *    用户活动，也不构成一次「到达」——Round 5 设计明确系统动作不得被当作
     *    活动基线（见 test_anchor_r9_startup_auto_resume_*）。
     * ③ 依据：spec 验收 1-2（触发条件：sessions[new] 非空且 ≠ arrival——用户
     *    自最近一次「到达」之后经 /resume 显式改选；行为：选择存活、arrival
     *    更新为所选）；「显式选择必须存活」无「重启前置」例外；缺失字段的
     *    记录在 load 时直接跳过，不应给从未到达过的
     *    非当前 agent 伪造到达基线（非当前 agent 的非空 session 只可能来自
     *    /resume 显式选择——任何 config.save 切离都会停车+清空）。
     */
    const filePath = path.join(tmpDir, 'last-session.json');
    makeRouter('codex', new SessionStore(filePath));
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');

    // /resume 对非当前 agent pi 显式选择 P1（arrival 不更新）
    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'pi-session-P1', agent: 'pi' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();

    // bridge 重启：SessionStore 从 last-session.json 重建
    makeRouter('codex', new SessionStore(filePath));
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    // 重启后非当前 agent 不伪造 arrival，显式选择信号保留
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();

    // 首次 config.save 切入：显式选择必须存活
    const response = await doSwitch(userId, ctx, 'pi');
    expect(response?.toast).toBeFalsy();
    expect(lastNotice()).toContain('已使用所选 session');
    expect(lastNotice()).toContain('pi-session-P1');
    expect(lastNotice()).not.toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C1');
  });
});
