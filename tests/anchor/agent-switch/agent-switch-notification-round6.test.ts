import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Bridge } from '../../../src/bridge/index.js';
import type { SessionReaderRegistry } from '../../../src/session/registry.js';

/**
 * Round 6 anchors: spec Round 5 设计（arrival 基线 + 停车语义 + 持久化迁移）的
 * 持久化往返边界与攻击面检查。
 *
 * 攻击点：
 * - load 缺省与显式 '' 的优先级：显式「清空到达」'' 条目不得被「有 session 的
 *   agent 缺省 arrival = session」覆盖；缺省只应作用于 arrivalSessions 完全缺失
 *   的损坏记录（load 跳过）。
 * - arrival '' 条目在恢复分支后的残留：restore 必须把 arrival[new] 覆盖为恢复的
 *   session id，残留的 '' 若不清除，下一次离开会被误判为「用户活动」阻断恢复。
 * - getSessionId 空串 vs undefined 的比较等价：内存中 clearSessionId 留下的 ''
 *   键与持久化重建后缺失的键，userChangedOld 判定必须一致。
 * - 双用户隔离：config.save 切换的 sessions/previousSessions/arrivalSessions 全部
 *   按 userId 隔离。
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

describe('Round6 anchors: arrival baseline persistence round-trip boundaries', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(defaultAgent: string, store: SessionStore = new SessionStore()): void {
    sessionStore = store;
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = new CommandRouter({
      sessionStore,
      bridge,
      config: buildConfig({ defaultAgent: defaultAgent as AppConfig['defaultAgent'] }),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round6-'));
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

  it('anchor_r6_explicit_cleared_arrival_wins_over_load_default', async () => {
    // 显式 '' 条目 vs load 缺省优先级：持久化 arrivalSessions {codex: ''} +
    // sessions {codex: X} + prev {pi: P}。加载时缺省规则不得把 '' 覆盖成 X
    // （否则 userChangedOld=false，P 会被错误恢复）。正确语义：codex 上 X 是
    // 「清空到达后用户发消息产生的新 session」→ 离开必须阻断 → 已清空，
    // prev[pi] 保持停车。
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

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('已切换到 Pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    // 被阻断的恢复不清除停车位
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    // 离开 codex 时 codex 的 X 停车
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-X');
  });

  it('anchor_r6_restore_overwrites_cleared_arrival_residue', async () => {
    // arrival '' 残留：codex 曾有「清空到达」''（arrival 残留），但 prev[codex]=C
    // 停车。S1 codex→pi（codex 有 session C ≠ '' → 阻断）；S2 pi→codex（pi 无
    // 活动 → 恢复 C）：恢复分支必须把 arrival[codex] 覆盖为 C，残留的 '' 不得
    // 保留。S3 codex→pi：C === arrival C → 无用户活动 → pi 的停车 P 必须恢复。
    // 若恢复分支残留 ''，S3 会误判「用户活动」→ 已清空，破坏停车恢复链。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    sessionStore.setArrivalSessionId(userId, 'codex', '');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');
    sessionStore.setArrivalSessionId(userId, 'pi', '');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 codex→pi：codex 有 session C，arrival '' → 用户活动 → 阻断
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');

    // S2 pi→codex：pi 无活动 → 恢复 C；arrival[codex] 必须被覆盖为 C
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('codex-session-C');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C');

    // S3 codex→pi：codex 无用户活动（C === arrival C）→ pi 的停车 P 必须恢复
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-P');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-P');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
  });

  it('anchor_r6_new_after_restore_is_user_activity_blocks_next_restore', async () => {
    // /new 语义：恢复到达（arrival[codex]=C）后执行 /new（sessions 清空 →
    // '' ≠ C）是用户活动；离开时恢复必须被阻断（已清空），停车 P 保持。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // S1 codex→pi（清空到达 arrival[pi]=''，codex 的 C 停车）
    await doSwitch(userId, ctx, 'pi');
    // S2 pi→codex：pi 无活动 → 恢复 C（arrival[codex]=C）
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C');

    // /new：清空 codex session（用户活动，arrival 不更新）
    sessionStore.clearSessionId(userId, 'codex');
    // 停车 P（模拟 pi 上更早停车的可恢复机会）
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    // S3 codex→pi：/new 后 '' ≠ arrival C → 阻断 → 已清空，P 保持停车
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
  });

  it('anchor_r6_cleared_session_empty_vs_missing_equal_across_restart', async () => {
    // getSessionId 空串 vs undefined 等价：内存中 /new 留下的 '' 键与持久化重建
    // 后缺失的键，userChangedOld 判定必须一致。两条链都应在 arrival=Y 时阻断
    // （已清空），在 arrival='' 时允许恢复。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store = new SessionStore(filePath);
    makeRouter('codex', store);
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-Y');
    sessionStore.setArrivalSessionId(userId, 'codex', 'codex-session-Y');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    // 内存链：clearSessionId 后 sessions[codex] = ''（键存在），arrival=Y → 阻断
    sessionStore.clearSessionId(userId, 'codex');
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');

    // 重建链：'' 键不落盘（autoPersist 丢弃空串），重建后键缺失 → 判定必须相同
    const store2 = new SessionStore(filePath);
    makeRouter('codex', store2);
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
  });

  it('anchor_r6_parked_previous_and_arrival_survive_restart_for_restore', async () => {
    // 停车跨重启：run1 里 codex C → pi（清空）、pi 上 X → codex（阻断）后重启；
    // run2 里 codex 无活动（arrival '' 显式持久化）→ 切回 pi 必须恢复 X。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    makeRouter('codex', store1);
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');

    // S1 codex→pi：pi 无 previous → 清空；codex 的 C 停车
    await doSwitch(userId, ctx, 'pi');
    // pi 上用户活动 X
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    // S2 pi→codex：pi 有活动 → 阻断；pi 的 X 停车、codex 的 C 继续停车
    await doSwitch(userId, ctx, 'codex');
    expect(lastNotice()).toContain('session 已清空');

    // 模拟重启
    const store2 = new SessionStore(filePath);
    makeRouter('codex', store2);

    // S3 codex→pi：codex 无活动（sessions 缺失 === arrival '' 显式）→ 恢复 X
    await doSwitch(userId, ctx, 'pi');
    expect(lastNotice()).toContain('将继续之前的 session');
    expect(lastNotice()).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
    // codex 的停车 C 不被恢复 pi 消费
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');
  });

  it('anchor_r6_send_failure_after_restart_toast_matches_current_restore_notice', async () => {
    // 持久化往返 + sendResult 失败组合：重启后恢复切换发送失败 → session 仍已
    // 恢复，兜底 toast 内容与本次恢复文案全等（info）。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    makeRouter('codex', store1);
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    await doSwitch(userId, ctx, 'codex');

    // 模拟重启
    const store2 = new SessionStore(filePath);
    makeRouter('codex', store2);
    bridge.sendResult.mockResolvedValueOnce(false);

    const response = await doSwitch(userId, ctx, 'pi');
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    const notice = sendResultMock.mock.calls[0][0] as { text: string };
    expect(notice.text).toContain('将继续之前的 session');
    expect(notice.text).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(response?.toast).toBeTruthy();
    expect((response?.toast as { type: string }).type).toBe('info');
    expect((response?.toast as { content: string }).content).toBe(notice.text);
  });

  it('anchor_r6_user_activity_after_restart_still_blocks_with_explicit_cleared_arrival', async () => {
    // 显式 '' 到达基线跨重启存活后，重启后用户消息产生新 session X 仍是用户
    // 活动：离开 codex 必须阻断（已清空），即使 prev[pi]=P 停车存在也不得恢复。
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        user1: {
          cwd: tmpDir,
          sessions: {},
          previousSessions: { pi: 'pi-session-P' },
          arrivalSessions: { codex: '' },
          sessionCwds: {},
        },
      }),
    );
    makeRouter('codex', new SessionStore(filePath));
    const userId = 'user1';
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // 重启后用户消息（bridge system.init 等价）：不更新 arrival，arrival[codex] 仍为 ''
    sessionStore.setSessionId(userId, 'codex', 'codex-session-X');

    await doSwitch(userId, ctx, 'pi');

    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    // 离开 codex 时 X 停车
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-X');
  });

  it('anchor_r6_persisted_two_users_isolated_across_restart', async () => {
    // 同一持久化文件的双用户隔离：user1 的切换链落盘后重启，user2 的条目必须
    // 原样加载且独立切换；user2 的切换不得污染 user1 的持久化状态。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    makeRouter('codex', store1);
    const ctx1 = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    const ctx2 = { userId: 'user2', chatId: 'chat2', messageId: 'msg2' };
    sessionStore.setCwd('user1', tmpDir);
    sessionStore.setCwd('user2', tmpDir);
    sessionStore.setSessionId('user1', 'codex', 'codex-session-C1');
    sessionStore.setSessionId('user2', 'codex', 'codex-session-C2');

    // user1 完整链：codex→pi（清空）→ pi 上 X1 → pi→codex（阻断）→ codex→pi（恢复 X1）
    await doSwitch('user1', ctx1, 'pi');
    sessionStore.setSessionId('user1', 'pi', 'pi-session-X1');
    await doSwitch('user1', ctx1, 'codex');
    await doSwitch('user1', ctx1, 'pi');

    // 模拟重启：同一文件重建 store + router（回到 codex）
    const store2 = new SessionStore(filePath, 'codex');
    makeRouter('codex', store2);

    // user2 条目加载正确、状态独立；user2 从未经过 config.save 切换，
    // 所以 arrivalSessions 为空（不再 auto-inject）。
    expect(sessionStore.getSessionId('user2', 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId('user2', 'codex')).toBeUndefined();

    // user2 独立切换 codex→opencode：无 arrival 基线 → userChangedOld=true
    // （session C2 ≠ arrival ''），但结果仍是清空（opencode 无停车），C2 停车
    await doSwitch('user2', ctx2, 'opencode');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBe('codex-session-C2');

    // user1 的持久化状态不被 user2 污染
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
      string,
      {
        cwd: string;
        sessions: Record<string, string>;
        previousSessions: Record<string, string>;
        arrivalSessions: Record<string, string>;
      }
    >;
    expect(parsed.user1?.sessions).toEqual({ pi: 'pi-session-X1' });
    expect(parsed.user1?.previousSessions).toEqual({ codex: 'codex-session-C1' });
    expect(parsed.user1?.arrivalSessions).toMatchObject({ pi: 'pi-session-X1' });
  });

  it('anchor_r6_two_users_switch_chains_are_isolated', async () => {
    // 双用户隔离：user1 的 3 次切换链（含停车 + 恢复 + arrival 更新）不得影响
    // user2 的任何 session 状态；user2 独立切换行为正确。
    makeRouter('codex');
    const ctx1 = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    const ctx2 = { userId: 'user2', chatId: 'chat2', messageId: 'msg2' };
    sessionStore.setCwd('user1', tmpDir);
    sessionStore.setCwd('user2', tmpDir);
    sessionStore.setSessionId('user1', 'codex', 'codex-session-C1');
    sessionStore.setSessionId('user2', 'codex', 'codex-session-C2');

    // user1 完整链：codex→pi（清空）→ pi 上 X → pi→codex（阻断）→ codex→pi（恢复 X）
    await doSwitch('user1', ctx1, 'pi');
    sessionStore.setSessionId('user1', 'pi', 'pi-session-X1');
    await doSwitch('user1', ctx1, 'codex');
    await doSwitch('user1', ctx1, 'pi');
    expect(lastNotice()).toContain('pi-session-X1');

    // user2 状态完全不受 user1 影响
    expect(sessionStore.getSessionId('user2', 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getSessionId('user2', 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId('user2', 'pi')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId('user2', 'codex')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId('user2', 'pi')).toBeUndefined();

    // user2 独立切换：defaultAgent 是 bridge 级全局配置（user1 链后全局已是
    // pi），重建 router 回到 codex（同一 sessionStore）模拟 user2 侧的独立
    // 上下文：codex 有 session C2（无 arrival 基线 → ''）→ 已清空
    makeRouter('codex', sessionStore);
    await doSwitch('user2', ctx2, 'opencode');
    expect(lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId('user2', 'opencode')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getArrivalSessionId('user2', 'opencode')).toBeUndefined();

    // user1 的恢复结果不受 user2 影响
    expect(sessionStore.getSessionId('user1', 'pi')).toBe('pi-session-X1');
    expect(sessionStore.getPreviousSessionId('user1', 'codex')).toBe('codex-session-C1');
    expect(sessionStore.getArrivalSessionId('user1', 'pi')).toBe('pi-session-X1');
  });
});
