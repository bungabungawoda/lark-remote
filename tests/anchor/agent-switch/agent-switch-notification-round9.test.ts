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
 * Round 9 anchors: config.save 切换通知与「启动/恢复入口」的交互。
 *
 * 攻击点（spec Round 5 设计语义要点 + 任务书指定换角度）：
 * 1. startup auto-resume（index.ts setSessionIdAndCwd）之后首次 config.save 切换
 *    不得因启动恢复本身误触发「用户活动」阻断；但重启前已发生的真实用户活动
 *    （/resume 等，arrival 未更新）必须跨重启保持阻断。
 * 2. /resume 对当前 agent 选择不同 session 后立即 config.save 切换：arrival 不更新
 *    → userChangedOld=true → 恢复被阻断（「用户活动」契约）；/resume 相同 session
 *    （无变化）不构成活动。
 * 3. /cd（setCwd，含 auto-resume 与无 auto-resume 两分支）后立即 config.save 切换
 *    的文案与状态（prev/arrival 已清空）。
 * 4. agentChoices 同步（syncAgentChoices）与 arrival 的交互：agent 配置变更保存时
 *    不误发切换消息，session/arrival 状态原样保留。
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

/** Stub reader with a whitelist of "existing" session ids and an optional newest session. */
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

describe('Round9 anchors: config.save switch vs startup/resume/cd/syncAgentChoices entry points', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round9-'));
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

  function allNotices(): string[] {
    const calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    return calls.map((call) => (call[0] as { text?: string }).text ?? '');
  }

  it('test_anchor_r9_startup_auto_resume_keeps_pre_restart_activity_block', async () => {
    /**
     * ① 验证：新格式持久化显式 arrival[codex]='' + sessions[codex]=X（重启前用户
     *    活动产生的新 session）时，启动 auto-resume 重设 X 后首次 config.save 切换
     *    必须仍被阻断（「session 已清空」，prev[pi] 停车保留）——启动恢复不得把
     *    真实用户活动基线洗成「无活动」。
     * ② 缺失/错误影响：若启动恢复覆盖/默认 arrival，重启前的用户活动（/resume、
     *    发消息）会被误判为无活动，恢复被错误放行。
     * ③ 依据：spec Round 5 设计「用户消息、/resume……都不更新 arrival——改变
     *    sessions 后离开即视为用户活动」+ load 显式 '' 条目优先于缺省。
     */
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        user1: {
          cwd: tmpDir,
          sessions: { codex: 'codex-session-X' },
          previousSessions: { pi: 'pi-session-P' },
          arrivalSessions: { codex: '' },
          sessionCwds: {},
        },
      }),
    );
    makeRouter('codex', new SessionStore(filePath));
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    sessionStore.setSessionIdAndCwd(userId, 'codex', 'codex-session-X', tmpDir);
    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-X');
  });

  it('test_anchor_r9_resume_current_agent_different_session_then_switch_blocks_restore', async () => {
    /**
     * ① 验证：/resume（resume.use 真实卡片路径）对当前 agent 选择不同 session 后，
     *    arrival 不更新；立即 config.save 切换离开时 userChangedOld=true，恢复被
     *    阻断（「session 已清空」），旧停车 prev[pi] 保留、被 resume 的 C2 停车到
     *    prev[codex]。
     * ② 缺失/错误影响：若 /resume 更新 arrival 或未被计为用户活动，用户明确更换
     *    会话后切换会错误恢复旧会话，破坏「用户活动」契约。
     * ③ 依据：spec Round 5 设计「/resume……都不更新 arrival——改变 sessions 后
     *    离开即视为用户活动，恢复被阻断」。spec 未明文覆盖 /resume+config.save 的
     *    组合时序，按 T6 anchor 锁定当前语义。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'codex-session-C2', agent: 'codex' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C2');
    // /resume 不更新 arrival：arrival 仍是到达基线 C1
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C1');

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_r9_resume_same_session_is_not_user_activity', async () => {
    /**
     * ① 验证：/resume 选择与 arrival 基线相同的 session（无实际变化）不构成用户
     *    活动；立即 config.save 切换仍可恢复 prev[pi]（「将继续之前的 session」）。
     * ② 缺失/错误影响：若把无变化的 /resume 也计为活动，用户无操作也被阻断恢复；
     *    若完全忽略 /resume 的会话变更，则 P3 的阻断语义失守。
     * ③ 依据：spec Round 5 设计「它们改变 sessions 后离开即视为用户活动」——未改变
     *    即无活动；userChangedOld 是状态差比较（(sessions ?? '') !== (arrival ?? '')）。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'codex-session-C1', agent: 'codex' },
      ctx,
    );
    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-P');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P');
  });

  it('test_anchor_r1_resume_selection_survives_config_save_switch', async () => {
    /**
     * ① 验证（用户裁决新语义）：resume.use 对非当前 agent（pi）显式选择 P1 后，
     *    config.save codex→pi 必须让选择存活——sessions[pi]=P1、arrival[pi]=P1
     *    （新基线）、消息含「已使用所选 session」与 P1、无 toast；旧 agent 停车
     *    prev[codex]=C1 原样保留。
     * ② 缺失/错误影响：旧实现清空分支 clearSessionId(new)+arrival='' 丢弃用户明确
     *    选择并发「session 已清空」；若绿实现仍清空或覆盖为停车位，用户切换后进入
     *    错误会话并收到误导性文案。
     * ③ 依据：spec 验收 1-3（显式选择必须存活，arrival 更新为新基线，消息
     *    「已使用所选 session」）；本测试由 Round 9 probe
     *    test_probe_r9_resume_target_agent_choice_then_switch_clears_it 反转而来
     *    （probe 锁定裁决前旧行为，裁决后升 anchor 锁定新语义）。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'pi-session-P1', agent: 'pi' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(router.config.defaultAgent).toBe('codex');

    const response = await doSwitch(userId, ctx, 'pi');

    expect(response?.toast).toBeFalsy();
    expect(lastNotice()).toContain('已使用所选 session');
    expect(lastNotice()).toContain('pi-session-P1');
    expect(lastNotice()).not.toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C1');
  });

  it('test_anchor_r1_resume_selection_beats_parking_restore', async () => {
    /**
     * ① 验证：目标 agent（pi）已有停车位 prev[pi]=P（可恢复）时，resume.use 显式
     *    选择 P1 后 config.save 切入必须优先采用 P1（而非恢复 P）、arrival=P1，
     *    且 prev[pi] 停车位原样保留（不被恢复分支消费）。
     * ② 缺失/错误影响：旧实现恢复分支只看 prev[new] 且 userChangedOld=false，会
     *    无视显式选择恢复 P（并消费停车位），用户明确挑选的会话被旧上下文覆盖。
     * ③ 依据：spec 优先级「显式选择 > 停车恢复 > 清空」+ 验收 1「prev[new] 停车位
     *    原样保留（下次离开时才会被 sessions[new] 覆盖停车）」。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'pi-session-P1', agent: 'pi' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('已使用所选 session');
    expect(lastNotice()).toContain('pi-session-P1');
    expect(lastNotice()).not.toContain('将继续之前的 session');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
  });

  it('test_anchor_r1_resume_selection_beats_user_activity_block', async () => {
    /**
     * ① 验证：用户在 old（codex）上有活动（/resume codex C1→C2，arrival 仍 C1，
     *    userChangedOld=true）时，对目标 agent（pi）的显式选择 P1 仍必须优先——
     *    切换后 sessions[pi]=P1、arrival[pi]=P1、消息「已使用所选 session」；
     *    prev[pi] 停车保留、codex 的 C2 照常停车到 prev[codex]。
     * ② 缺失/错误影响：旧实现 userChangedOld=true 走清空分支，把显式选择 P1 清掉
     *    并发「session 已清空」；若绿实现按「恢复/清空」旧序处理，用户活动阻断会
     *    连带吞掉对目标 agent 的明确选择。
     * ③ 依据：spec 优先级「显式选择 > 停车恢复 > 清空」+ 验收 4「即使
     *    userChangedOld=true，显式选择仍优先」。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    // 先在 old（codex）制造用户活动：/resume 换到 C2，arrival 不更新
    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'codex-session-C2', agent: 'codex' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C1');

    // 再对目标 agent（pi）显式选择 P1
    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'pi-session-P1', agent: 'pi' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('已使用所选 session');
    expect(lastNotice()).toContain('pi-session-P1');
    expect(lastNotice()).not.toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C2');
  });

  it('test_anchor_r1_resume_selection_parks_on_switch_away', async () => {
    /**
     * ① 验证（新语义闭环）：resume.use 显式选择 pi=P1 → config.save 切入 pi（选择
     *    存活并成为 arrival 基线）→ 再切回 codex 时，P1 必须停车到 prev[pi]；因
     *    arrival[pi]=P1（无用户活动），codex 的 C1 正常恢复。
     * ② 缺失/错误影响：若显式选择被清空/未成为基线，离开 pi 时无 session 可停车
     *    （prev[pi] 丢失）或 userChangedOld 误判为活动阻断恢复——用户来回切换后
     *    上下文断裂。
     * ③ 依据：spec 验收 2「prev[new] 下次离开时会被 sessions[new] 覆盖停车」+
     *    既有停车语义（切换离开先 setPreviousSessionId 再清空）。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'pi-session-P1', agent: 'pi' },
      ctx,
    );
    await doSwitch(userId, ctx, 'pi');
    // 切入后显式选择存活且成为 arrival 基线（新语义 A1 的后续状态）
    await doSwitch(userId, ctx, 'codex');

    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C1');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C1');
  });

  it('test_anchor_r1_resume_selection_equal_to_arrival_keeps_existing_semantics', async () => {
    /**
     * ① 验证（触发条件守卫）：目标 agent（pi）sessions=P1 且 arrival=P1（自最近
     *    「到达」后无显式改选），此时 /resume pi=P1（与基线相同）后 config.save
     *    切入**不得**触发新分支——走既有恢复：prev[pi]=P 存在且无用户活动 →
     *    恢复 P、消息「将继续之前的 session」。
     * ② 缺失/错误影响：若绿实现只按「sessions[new] 非空」触发新分支，会把无变化的
     *    /resume 误判为显式改选，恢复被错误跳过、既有停车语义被架空。
     * ③ 依据：spec 验收 5 触发条件「(newSessionId ?? '') !== (arrivalSessions[new]
     *    ?? '')」；相等时不触发，未显式选择时既有恢复/清空语义不变。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    // 模拟「上次到达 pi 后无改选」：sessions/arrival 同基线，另留一份更早停车 P
    sessionStore.setSessionId(userId, 'pi', 'pi-session-P1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'pi', 'pi-session-P1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'pi-session-P1', agent: 'pi' },
      ctx,
    );
    // /resume 与基线相同：sessions 无变化，不构成显式改选
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P1');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P1');

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-P');
    expect(lastNotice()).not.toContain('已使用所选 session');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P');
  });

  it('test_anchor_r9_cd_no_autoresume_then_switch_clears_without_restore', async () => {
    /**
     * ① 验证：/cd（无 auto-resume）后 setCwd 已清空 sessions/prev/arrival；立即
     *    config.save 切换走清空分支（「session 已清空」），旧 agent 无 session 不
     *    停车，新 agent arrival=''；再切回仍是清空（prev 无可恢复）。
     * ② 缺失/错误影响：/cd 后若残留 prev/arrival，切换可能错误恢复旧 cwd 的会话
     *    或误报「将继续」。
     * ③ 依据：spec Round 5 设计「/cd（setCwd）清空 sessions + previousSessions
     *    的同时清空 arrivalSessions」；清空分支文案/状态。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    const dirA = path.join(tmpDir, 'dir-a');
    const dirB = path.join(tmpDir, 'dir-b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    sessionStore.setCwd(userId, dirA);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', dirA);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');
    sessionStore.setPreviousSessionId(userId, 'codex', 'codex-session-C0');

    await router.handle(`/cd ${dirB}`, ctx);
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBeUndefined();

    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();

    // 再切回 codex：prev[codex] 无停车 → 仍清空
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
  });

  it('test_anchor_r9_cd_autoresume_then_switch_blocks_restore', async () => {
    /**
     * ① 验证：/cd 命中 auto-resume（getNewestSession 返回 session N）时 setCwd 已
     *    清空 arrival 与全部 previousSessions，随后 setSessionIdAndCwd 写 N 且不更新
     *    arrival → 立即 config.save 切换按「用户活动」阻断恢复（「session 已清空」），
     *    N 停车到 prev[codex]；被 setCwd 清掉的 prev[pi] 不复活。
     * ② 缺失/错误影响：若 /cd auto-resume 更新 arrival 或被当作无活动，切换会错误
     *    恢复旧目录/旧会话。
     * ③ 依据：spec Round 5 设计「/cd auto-resume 不更新 arrival——改变 sessions
     *    后离开即视为用户活动，恢复被阻断」。
     */
    const codexReader = stubReader({
      known: ['codex-session-C1', 'codex-session-N'],
      newest: 'codex-session-N',
    });
    makeRouter('codex', new SessionStore(), createRegistry({ codex: codexReader }));
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    const dirA = path.join(tmpDir, 'dir-a');
    const dirB = path.join(tmpDir, 'dir-b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    sessionStore.setCwd(userId, dirA);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', dirA);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handle(`/cd ${dirB}`, ctx);
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-N');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBeUndefined();

    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-N');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_r9_agent_config_save_no_switch_notice_preserves_arrival_and_syncs_choices', async () => {
    /**
     * ① 验证：当前 agent（codex）配置项变更（agents.codex.model）保存时不发切换
     *    消息、不返回 toast，sessions/prev/arrival 全部原样；syncAgentChoices 把
     *    agentChoices.codex.model 同步到内存 config 与 config.yaml（原子写盘）。
     * ② 缺失/错误影响：若 agent 配置变更误发切换消息，用户收到虚假的 agent 切换
     *    通知；若 sync 副作用破坏 session/arrival，后续切换判定错乱。
     * ③ 依据：spec 验收 4「defaultAgent 未切换 → 不发切换消息、不返回 toast」+
     *    Round 5 设计「userChangedOld 只在 config.save 切换时更新 arrival」。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.codex.model', option: 'codex-new-model' },
      ctx,
    );
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(response?.toast).toBeFalsy();
    for (const text of allNotices()) {
      expect(text).not.toContain('已切换到');
    }
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C1');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C1');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();

    const routerConfig = (router as unknown as { config: AppConfig }).config;
    expect(routerConfig.agentChoices?.codex?.model).toBe('codex-new-model');
    const yaml = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');
    expect(yaml).toContain('codex-new-model');
  });

  it('test_anchor_r9_switch_plus_current_agent_config_save_restores_and_syncs', async () => {
    /**
     * ① 验证：同一次 config.save 同时切换 defaultAgent（codex→pi）并修改当前
     *    （新）agent 配置（agents.pi.model）时：无用户活动 → 恢复 prev[pi]=P 并发
     *    「将继续之前的 session」；syncAgentChoices 同步 agentChoices.pi.model 且不
     *    覆盖恢复分支的 arrival[pi]=P。
     * ② 缺失/错误影响：若 agentChoices 同步写盘与切换的 session/arrival 副作用互相
     *    覆盖，恢复后的到达基线丢失，下一次离开会被误判为用户活动。
     * ③ 依据：spec 验收 1（切换成功 → 发消息）+ Round 5 设计恢复分支
     *    （setArrivalSessionId(new, prev)）+ P1-7 agentChoices 原子写盘。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.pi.model', option: 'glm-new' },
      ctx,
    );
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(response?.toast).toBeFalsy();
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-P');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C1');

    const routerConfig = (router as unknown as { config: AppConfig }).config;
    expect(routerConfig.agentChoices?.pi?.model).toBe('glm-new');
    const yaml = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');
    expect(yaml).toContain('glm-new');
  });

  it('test_anchor_r9_failed_resume_does_not_count_as_user_activity', async () => {
    /**
     * ① 验证：resume.use 校验失败（session 不存在）时不写 session、sessions 不变；
     *    随后 config.save 切换按原 arrival 基线判定（无变化 = 无用户活动），仍恢复
     *    prev[pi]=P。
     * ② 缺失/错误影响：若失败路径也污染 session/arrival，无效点击会让用户莫名失去
     *    恢复机会（P1-5 校验先行的既有守卫）。
     * ③ 依据：spec Round 5 设计「改变 sessions 后离开即视为用户活动」——失败路径
     *    未改变 sessions 不构成活动；P1-5「校验前不得写入 sessionId」。
     */
    makeRouter('codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C1', tmpDir);
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-C1');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'codex-session-UNKNOWN', agent: 'codex' },
      ctx,
    );
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C1');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C1');

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-P');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-session-P');
  });
});
