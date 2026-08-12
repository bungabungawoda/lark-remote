import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { _Bridge } from '../../../src/bridge/index.js';
import type { _SessionReaderRegistry } from '../../../src/session/registry.js';

/**
 * Round 4/5 anchors + Round 6 upgraded anchors（原 probes，断言未动）:
 * config.save agent-switch notification
 * (spec 2026-08-03 + Round 5 设计).
 *
 * 新恢复模型（Round 5 设计，arrival 基线）：
 * - userChangedOld = (sessions[old] ?? '') !== (arrivalSessions[old] ?? '')，
 *   在清空 old 之前计算；canRestore = prev[new] 存在 && !userChangedOld。
 * - 恢复分支：消费 prev[new] + arrival[new] = prev；清空分支：保留 prev[new]
 *   停车 + arrival[new] = ''（被拒绝的恢复不清除停车位）。
 * - arrivalSessions 只在 config.save 切换时更新；用户消息 /resume /new /cd
 *   auto-resume 不更新；加载时对每个有 session 的 agent 缺省 arrival = sessions。
 *
 * T3 invariant: 每次切换后文案必须与 sessionStore 状态一致（「将继续
 * sessionId: X」⇔ new agent session === X；「已清空」⇔ new agent session
 * undefined），且恰好 1 条 sendResult；previous 只在恢复分支消费，清空分支
 * 停车保留。
 *
 * T4 boundaries: 5-agent pairwise matrix (claude/codex/pi/opencode/kimi) 文案 +
 * 调用次数；sendResult 失败兜底必须携带当前切换文案且状态一致。
 */
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

const AGENTS = ['claude', 'codex', 'pi', 'opencode', 'kimi'] as const;
const DISPLAY: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  opencode: 'Opencode',
  kimi: 'Kimi',
};

interface PersistedUserData {
  cwd?: string;
  sessions?: Record<string, string>;
  previousSessions?: Record<string, string>;
  arrivalSessions?: Record<string, string>;
}

function expectNoPersistedKeys(field: Record<string, unknown> | undefined): void {
  if (field === undefined) return;
  expect(Object.keys(field)).toHaveLength(0);
}

describe('Round4/5 anchors & probes (Round 6: 3 probes upgraded): config.save switch notification invariants & boundaries', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(defaultAgent: string, overrides?: Partial<AppConfig>): void {
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = new CommandRouter({
      sessionStore,
      bridge,
      config: buildConfig({
        defaultAgent: defaultAgent as AppConfig['defaultAgent'],
        ...overrides,
      }),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });
  }

  function makeRouterWithStore(
    store: SessionStore,
    defaultAgent: string,
    overrides?: Partial<AppConfig>,
  ): void {
    sessionStore = store;
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = new CommandRouter({
      sessionStore,
      bridge,
      config: buildConfig({
        defaultAgent: defaultAgent as AppConfig['defaultAgent'],
        ...overrides,
      }),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round4-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function doSwitch(
    userId: string,
    ctx: { userId: string; chatId: string; messageId: string },
    to: string,
  ) {
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: to }, ctx);
    return router.handleCardAction({ cmd: 'config.save' }, ctx);
  }

  function lastNotice(): string {
    const calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    return (calls[calls.length - 1][0] as { text: string }).text;
  }

  it('test_anchor_t4_invariant_five_switch_chain_message_matches_state_no_residue', async () => {
    // 固定 5 次切换覆盖全部 5 个 agent，中途穿插新 session；每次切换后校验：
    // 1) 恰好 1 条 sendResult；2) 文案与 sessionStore 状态一致（将继续⇔恢复，
    // 已清空⇔无 session）；3) 本链中每个目标 agent 从未被停车过 previous
    // （新契约下停车只发生在离开的 agent，previous 仅在恢复分支消费）→ 目标
    // previous 无残留。
    makeRouter('claude');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 claude→codex：claude 有 session → 已清空，codex 无 previous → 清空
    await doSwitch(userId, ctx, 'codex');
    let calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(lastNotice()).toContain('Codex');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();

    // codex 上产生新 session
    sessionStore.setSessionId(userId, 'codex', 'codex-session-Y');

    // S2 codex→pi：codex 有 session → 已清空
    await doSwitch(userId, ctx, 'pi');
    calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(lastNotice()).toContain('Pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();

    // pi 上产生新 session
    sessionStore.setSessionId(userId, 'pi', 'pi-session-Z');

    // S3 pi→opencode：pi 有 session → 已清空
    await doSwitch(userId, ctx, 'opencode');
    expect((bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(lastNotice()).toContain('Opencode');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'opencode')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'opencode')).toBeUndefined();

    // opencode 上产生新 session
    sessionStore.setSessionId(userId, 'opencode', 'opencode-session-W');

    // S4 opencode→kimi：opencode 有 session → 已清空
    await doSwitch(userId, ctx, 'kimi');
    expect((bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    expect(lastNotice()).toContain('Kimi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'kimi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'kimi')).toBeUndefined();

    // S5 kimi→claude：kimi 无 session，claude 有 previous X → 必须恢复
    await doSwitch(userId, ctx, 'claude');
    calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(5);
    expect(lastNotice()).toContain('Claude');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('claude-session-X');
    expect(sessionStore.getSessionId(userId, 'claude')).toBe('claude-session-X');
    // 恢复成功不得残留 previous（T3 泄漏检查）
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBeUndefined();
  });

  it('test_anchor_t4_pairwise_matrix_all_five_agents', async () => {
    // 5 个 agent 两两切换矩阵（20 对）：每次只切一步，旧 agent 有 session、
    // 新 agent 无 previous → 必须恰好 1 条 sendResult、文案含目标 agent 显示名、
    // 「session 已清空」、目标 session 为空、目标 previous 无残留（目标从未
    // 停车）、旧 agent previous 保存旧 session。
    for (const from of AGENTS) {
      for (const to of AGENTS) {
        if (from === to) continue;
        makeRouter(from);
        const userId = 'user1';
        sessionStore.setCwd(userId, tmpDir);
        sessionStore.setSessionId(userId, from, `${from}-session-${to}`);
        const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

        await doSwitch(userId, ctx, to);
        const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
        expect(sendResultMock.mock.calls, `${from}->${to} call count`).toHaveLength(1);
        const text = lastNotice();
        expect(text, `${from}->${to} display name`).toContain(DISPLAY[to]);
        expect(text, `${from}->${to} cleared wording`).toContain('session 已清空');
        expect(
          sessionStore.getSessionId(userId, to),
          `${from}->${to} target session`,
        ).toBeUndefined();
        expect(
          sessionStore.getPreviousSessionId(userId, to),
          `${from}->${to} target previous residue`,
        ).toBeUndefined();
        expect(sessionStore.getPreviousSessionId(userId, from)).toBe(`${from}-session-${to}`);
      }
    }
  });

  it('test_anchor_t4_send_failure_on_second_switch_falls_back_to_current_notice', async () => {
    // Round3 序列，第 2 次切换（pi→codex，因 pi 有用户活动 X ≠ arrival '' 被
    // 阻断）sendResult 失败：兜底 toast 必须是「当前这一次」的已清空文案，
    // 不是第 1 次切换的文案；阻断分支保留 codex 的停车 C（新契约：被拒绝的
    // 恢复不清除 previous）；第 3 次切换（codex 无用户活动）仍正常恢复 X 并发
    // 持久化消息。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 codex→pi
    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // S2 pi→codex 时 sendResult 失败
    bridge.sendResult.mockResolvedValueOnce(false);
    await doSwitch(userId, ctx, 'codex');
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const secondText = sendResultMock.mock.calls[1][0] as { text: string };
    expect(secondText.text).toContain('已切换到 Codex');
    expect(secondText.text).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
    // 新契约：阻断分支保留停车，被拒绝的恢复不得消费 previous[codex]
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');

    // S3 codex→pi：codex 无用户活动（sessions '' === arrival ''）→ 恢复
    // pi-session-X，第 3 条消息成功发送；恢复 pi 不得消费 codex 的停车 C
    const response3 = await doSwitch(userId, ctx, 'pi');
    expect(sendResultMock).toHaveBeenCalledTimes(3);
    const thirdText = sendResultMock.mock.calls[2][0] as { text: string };
    expect(thirdText.text).toContain('pi-session-X');
    expect(thirdText.text).toContain('将继续之前的 session');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');
    expect(response3?.toast).toBeFalsy();
  });

  it('probe_t4_send_failure_on_third_switch_still_restores_and_toasts', async () => {
    // Round3 序列，第 3 次（恢复）切换 sendResult 失败：session 必须已恢复，
    // 兜底 toast 内容必须与当前恢复文案全等（含 sessionId），且 toast 为 info。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    await doSwitch(userId, ctx, 'codex');

    // S3 codex→pi：恢复消息发送失败
    bridge.sendResult.mockResolvedValueOnce(false);
    const response3 = await doSwitch(userId, ctx, 'pi');

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(3);
    const thirdText = sendResultMock.mock.calls[2][0] as { text: string };
    expect(thirdText.text).toContain('将继续之前的 session');
    expect(thirdText.text).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    // 兜底 toast：type info + 内容与本次尝试发送的文案全等（不是第 1/2 次文案）
    expect(response3?.toast).toBeTruthy();
    expect((response3?.toast as { type: string }).type).toBe('info');
    expect((response3?.toast as { content: string }).content).toBe(thirdText.text);
    // 恢复成功后 previous 不得残留
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_restored_session_on_left_agent_must_not_block_next_restore', async () => {
    // Round 3 语义的 4 次切换泛化（Round 4 RED，Round 5 新契约下成立）：
    //   codex(C) → pi（pi 上发消息 X）→ opencode（无消息）→ codex（无消息，
    //   自动恢复 C）→ pi。
    // 新契约 trace：S3 恢复 C 时 arrival[codex]=C；S4 离开 codex 时
    // userChangedOld(codex) = (C ?? '') === (arrival C ?? '') → false（用户在
    // codex 上从未发消息，自动恢复不算用户活动）→ pi 的 X 必须恢复（消息
    // 「将继续…sessionId: X」），且 pi 的 previous 被消费。
    // 旧实现（prev 代理启发式）把"自动恢复的 session"（停车 prev[codex]）
    // 误当成"用户在 codex 上新建了 session"，S4 错误走「已清空」——这是
    // Round 3 stale-previous 修复后仍残留的切换链泄漏路径（恢复成功的
    // session 被旧启发式当作阻塞位）。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 codex→pi
    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // S2 pi→opencode（pi 有 session X → opencode 无 previous → 已清空）
    await doSwitch(userId, ctx, 'opencode');
    expect(lastNotice()).toContain('session 已清空');

    // S3 opencode→codex：opencode 无 session，codex 的 previous C 仍有效
    // （用户在 codex 上从未发消息）→ 必须恢复 C
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('codex-session-C');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();

    // S4 codex→pi：codex 上的 C 是 S3 自动恢复的（用户从未在 codex 发消息）→
    // pi 的 X 必须恢复，消息「将继续…pi-session-X」，previous 被消费
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_rejected_restore_keeps_previous_parked_for_future_restore', async () => {
    // A11 停车语义（T1+T4）：
    // 被拒绝的恢复不清除 previousSessions——round-3 序列 save2（pi→codex 被
    // 阻断，因 pi 有用户活动 X ≠ arrival ''）后，codex 的 previous C 必须仍
    // 停车；随后 opencode（无用户活动）→codex 必须恢复 C。
    // 当前实现（7de99c0 的 canRestore=false 消费修复）在阻断分支消费 previous
    // → prev[codex] 丢失、后续恢复被破坏 → RED。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 codex→pi：pi 无 previous → 清空；codex 的 C 停车
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');

    // pi 上用户活动：新 session X（不更新 arrival，arrival[pi] 仍为 ''）
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // S2 pi→codex：pi 有用户活动（X ≠ arrival ''）→ 恢复被阻断（已清空）；
    // 被拒绝的恢复不得清除 codex 的停车 C
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');

    // S3 codex→opencode：codex 无 session、无用户活动（arrival ''）→ opencode
    // 清空
    await doSwitch(userId, ctx, 'opencode');
    expect(lastNotice()).toContain('session 已清空');

    // S4 opencode→codex：opencode 无用户活动 → 恢复停车 C
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('codex-session-C');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C');
    // 恢复分支消费 previous（停车 → 恢复）
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();
  });

  it('test_anchor_previous_and_arrival_sessions_persist_across_store_rebuild', async () => {
    // A12 持久化迁移（T1+T7）：last-session.json 每用户新增 previousSessions 与
    // arrivalSessions 字段；停车（prev[codex]=C）与到达（arrival[pi]=X、
    // arrival[codex]=''）必须跨 SessionStore 重建存活（sessions/cwd 一并校验）。
    // 当前实现只持久化 cwd+sessions：文件缺两个新字段、重建后 prev 丢失
    // （getPreviousSessionId 返回 undefined）→ RED。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    makeRouterWithStore(store1, 'codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 codex→pi：pi 清空到达（arrival[pi]=''）；codex 的 C 停车
    await doSwitch(userId, ctx, 'pi');
    // pi 上用户活动 X（不更新 arrival）
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    // S2 pi→codex：pi 有用户活动 → 阻断（arrival[codex]=''）；pi 的 X 停车，
    // codex 的 C 继续停车
    await doSwitch(userId, ctx, 'codex');
    // S3 codex→pi：codex 无用户活动 → 恢复 X；arrival[pi]=X；prev[pi] 消费
    await doSwitch(userId, ctx, 'pi');

    // 持久化格式契约（spec Round 5 设计）：每用户 previousSessions +
    // arrivalSessions 字段
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      PersistedUserData
    >;
    const userData = parsed[userId];
    expect(userData?.cwd).toBe(tmpDir);
    expect(userData?.sessions).toEqual({ pi: 'pi-session-X' });
    expect(userData?.previousSessions).toEqual({ codex: 'codex-session-C' });
    expect(userData?.arrivalSessions).toMatchObject({ pi: 'pi-session-X' });
    expect(userData?.arrivalSessions?.codex).toBe('');

    // 重建后字段存活（含 sessions/cwd 一并校验）
    const store2 = new SessionStore(filePath);
    expect(store2.getCwd(userId)).toBe(tmpDir);
    expect(store2.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(store2.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');
  });

  it('test_anchor_startup_baseline_arrival_does_not_block_first_restore', async () => {
    // A14 启动基线（RED）：持久化 claude=X + prev[codex]=Y + arrival[claude]=X
    // （加载时对每个有 session 的 agent 缺省 arrival = sessions[agent]）后重建，
    // 首次切换 claude→codex 必须恢复 Y（claude 无用户活动）。
    // 当前实现既不读 previousSessions 也不读 arrivalSessions，且旧启发式在
    // 离开带 session 的 agent 时用"刚停车的 prev[claude]"代理用户活动 → 首切
    // 错误走「已清空」→ RED。
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        user1: {
          cwd: tmpDir,
          sessions: { claude: 'claude-session-X' },
          previousSessions: { codex: 'codex-session-Y' },
          arrivalSessions: { claude: 'claude-session-X' },
          sessionCwds: {},
        },
      }),
    );
    makeRouterWithStore(new SessionStore(filePath), 'claude');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('codex-session-Y');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-Y');
    // 恢复分支消费 prev[codex]；离开 claude 时 claude 的 X 停车
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
  });

  it('test_anchor_set_cwd_clears_previous_and_arrival_sessions', async () => {
    // A15 setCwd 重置（守卫）：setCwd 清空 sessions + previousSessions +
    // arrivalSessions（spec Round 5 设计语义要点）。本守卫锁已有行为（previous
    // 清空）与持久化残留清理；当前实现已满足 previous/sessions 部分 → 守卫可绿。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    makeRouterWithStore(store, 'codex');
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    const dirA = path.join(tmpDir, 'dir-a');
    const dirB = path.join(tmpDir, 'dir-b');

    sessionStore.setCwd(userId, dirA);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    sessionStore.setPreviousSessionId(userId, 'codex', 'codex-session-C');
    // 经 config.save 产生到达状态（S1 codex→pi：arrival[pi]=''）
    await doSwitch(userId, ctx, 'pi');

    // setCwd：清空 sessions + previousSessions（新契约下还需清空 arrivalSessions）
    sessionStore.setCwd(userId, dirB);
    expect(sessionStore.getCwd(userId)).toBe(dirB);
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();

    // 持久化侧不得残留 previousSessions / arrivalSessions
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      PersistedUserData
    >;
    expectNoPersistedKeys(parsed[userId]?.previousSessions);
    expectNoPersistedKeys(parsed[userId]?.arrivalSessions);
  });
});
