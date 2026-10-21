import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { lastNotice, allNotices } from '../../lib/agent-switch-helpers.js';
import { createRouterFixture } from '../../lib/router-fixture.js';
import {
  buildAgentSwitchConfig as buildConfig,
  AGENTS,
  DISPLAY,
} from '../../lib/agent-switch-helpers.js';

// 测试隔离（「禁真跑 agent」）：本用例走的 config 加载链
// （codex debug models / opencode models --verbose / kimi provider list --json）
// 会经 spawnProcessSync 真起 agent CLI —— Windows 上单次 2-7s，且行为取决于本机
// 装没装这些 CLI，会让「切换 agent」这类用例变成负载相关的偶发红。
// 这里只把同步 CLI 通道短路成「命令失败」，配置层对失败已有 FALLBACK_MODELS 兜底，
// 断言面不变；其余导出保持真实。
vi.mock('../../../src/platform/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn.js')>();
  const { shortCircuitSpawn } = await import('../../lib/spawn-shortcircuit.js');
  return shortCircuitSpawn(actual);
});

/**
 * s:设计（arrival 基线 + 停车语义 + 持久化迁移）的
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

describe('arrival baseline persistence round-trip boundaries', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(defaultAgent: string, store: SessionStore = new SessionStore()): void {
    sessionStore = store;
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = createRouterFixture({
      tmpDir,
      config: buildConfig({ defaultAgent: defaultAgent as AppConfig['defaultAgent'] }),
      bridge,
      sessionStore: store,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;
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

  function _lastNotice(): string {
    return lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
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

    expect(_lastNotice()).toContain('Pi');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    // 被阻断的恢复不清除停车位
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');
    // 离开 codex 时 codex 的 X 停车
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-X');
  });

  it('anchor_r6_restore_overwrites_cleared_arrival_residue', async () => {
    // arrival '' 残留：codex 曾有「清空到达」''（arrival 残留），但 prev[codex]=C
    // 停车。codex→pi（codex 有 session C ≠ '' → 阻断）；pi→codex（pi 无
    // 活动 → 恢复 C）：恢复分支必须把 arrival[codex] 覆盖为 C，残留的 '' 不得
    // 保留。codex→pi：C === arrival C → 无用户活动 → pi 的停车 P 必须恢复。
    // 若恢复分支残留 ''，会误判「用户活动」→ 已清空，破坏停车恢复链。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    sessionStore.setArrivalSessionId(userId, 'codex', '');
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');
    sessionStore.setArrivalSessionId(userId, 'pi', '');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // codex→pi：codex 有 session C，arrival '' → 用户活动 → 阻断
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('session 已清空');

    // pi→codex：pi 无活动 → 恢复 C；arrival[codex] 必须被覆盖为 C
    await doSwitch(userId, ctx, 'codex');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('codex-session-C');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C');

    // codex→pi：codex 无用户活动（C === arrival C）→ pi 的停车 P 必须恢复
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('pi-session-P');
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

    // codex→pi（清空到达 arrival[pi]=''，codex 的 C 停车）
    await doSwitch(userId, ctx, 'pi');
    // pi→codex：pi 无活动 → 恢复 C（arrival[codex]=C）
    await doSwitch(userId, ctx, 'codex');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(sessionStore.getArrivalSessionId(userId, 'codex')).toBe('codex-session-C');

    // /new：清空 codex session（用户活动，arrival 不更新）
    sessionStore.clearSessionId(userId, 'codex');
    // 停车 P（模拟 pi 上更早停车的可恢复机会）
    sessionStore.setPreviousSessionId(userId, 'pi', 'pi-session-P');

    // codex→pi：/new 后 '' ≠ arrival C → 阻断 → 已清空，P 保持停车
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('session 已清空');
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
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBe('pi-session-P');

    // 重建链：'' 键不落盘（autoPersist 丢弃空串），重建后键缺失 → 判定必须相同
    const store2 = new SessionStore(filePath);
    makeRouter('codex', store2);
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('session 已清空');
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

    // codex→pi：pi 无 previous → 清空；codex 的 C 停车
    await doSwitch(userId, ctx, 'pi');
    // pi 上用户活动 X
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    // pi→codex：pi 有活动 → 阻断；pi 的 X 停车、codex 的 C 继续停车
    await doSwitch(userId, ctx, 'codex');
    expect(_lastNotice()).toContain('session 已清空');

    // 模拟重启
    const store2 = new SessionStore(filePath);
    makeRouter('codex', store2);

    // codex→pi：codex 无活动（sessions 缺失 === arrival '' 显式）→ 恢复 X
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('pi-session-X');
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
    const notice = _lastNotice();
    expect(notice).toContain('将继续之前的 session');
    expect(notice).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(response?.toast).toBeTruthy();
    expect((response?.toast as { type: string }).type).toBe('info');
    // toast content must carry the switch notice text (propagateConfigSave output)
    const toastContent = (response?.toast as { content: string }).content;
    expect(toastContent).toContain('将继续之前的 session');
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

    expect(_lastNotice()).toContain('session 已清空');
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
    const store2 = new SessionStore(filePath);
    makeRouter('codex', store2);

    // user2 条目加载正确、状态独立；user2 从未经过 config.save 切换，
    // 所以 arrivalSessions 为空（不再 auto-inject）。
    expect(sessionStore.getSessionId('user2', 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId('user2', 'codex')).toBeUndefined();

    // user2 独立切换 codex→opencode：无 arrival 基线 → userChangedOld=true
    // （session `codex-session-C2` ≠ arrival ''），但结果仍是清空（opencode 无停车），它停车
    await doSwitch('user2', ctx2, 'opencode');
    expect(_lastNotice()).toContain('session 已清空');
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
    expect(_lastNotice()).toContain('pi-session-X1');

    // user2 状态完全不受 user1 影响
    expect(sessionStore.getSessionId('user2', 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getSessionId('user2', 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId('user2', 'pi')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId('user2', 'codex')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId('user2', 'pi')).toBeUndefined();

    // user2 独立切换：defaultAgent 是 bridge 级全局配置（user1 链后全局已是
    // pi），重建 router 回到 codex（同一 sessionStore）模拟 user2 侧的独立
    // 上下文：codex 有 session `codex-session-C2`（无 arrival 基线 → ''）→ 已清空
    makeRouter('codex', sessionStore);
    await doSwitch('user2', ctx2, 'opencode');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId('user2', 'opencode')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId('user2', 'codex')).toBe('codex-session-C2');
    expect(sessionStore.getArrivalSessionId('user2', 'opencode')).toBeUndefined();

    // user1 的恢复结果不受 user2 影响
    expect(sessionStore.getSessionId('user1', 'pi')).toBe('pi-session-X1');
    expect(sessionStore.getPreviousSessionId('user1', 'codex')).toBe('codex-session-C1');
    expect(sessionStore.getArrivalSessionId('user1', 'pi')).toBe('pi-session-X1');
  });
});

/**
 * （2026-08-03由 probe 升 anchor，断言未动；spec Round
 * 5 设计下语义不变）：config.save
 * 连续 3 次切换（codex→pi→codex→pi）时，第三次切回 pi 的持久化消息必须是
 * 「将继续之前的 session」而非「session 已清空」。
 *
 * 场景：codex 有 session C → 切到 pi（codex 的 C 存入 previousSessions）→
 * pi 上发消息产生新 session X（用户活动）→ 切到 codex（pi 的 X 存入
 * previousSessions；因 pi 有用户活动，恢复被阻断，arrival[codex]=''）→ 切回 pi。
 * codex 上从未发消息：sessions[codex]='' === arrival[codex]=''（无用户活动），
 * 按设计的 arrival 基线，pi 的 X 必须恢复，第三条消息必须携带
 * sessionId: X。历史背景：修复前旧实现用 previous 残留代理"用户活动"
 * 并消费停车位，消息文案与 session 恢复双双错误；新契约下断言行为不变。
 */

describe('config.save switch notification edge paths', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(config: AppConfig): void {
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = createRouterFixture({
      tmpDir,
      config,
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    }).router;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round3-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_stale_previous_does_not_break_restore_message', async () => {
    // 3 次切换：codex(C) → pi → (pi 上发消息 X) → codex → pi。
    // 第 3 次切回 pi 时，codex 无用户活动（sessions '' === arrival ''，从未发
    // 消息），pi 的 X 必须恢复，第三条消息必须是「将继续之前的 session，
    // sessionId: X」。
    makeRouter(
      buildConfig({
        defaultAgent: 'codex',
      }),
    );
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // Save 1: codex → pi（codex 的 C 存入 previous）
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // pi 上发消息，产生新 session X
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // Save 2: pi → codex（pi 的 X 存入 previous；codex 无新 session）
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'codex' }, ctx);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // Save 3: codex → pi（codex 仍无新 session，pi 的 X 必须恢复）
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(3);
    const text = lastNotice(sendResultMock);
    expect(text).toContain('Pi');
    expect(text).toContain('将继续之前的 session');
    expect(text).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(response?.toast).toBeFalsy();
  });
});

/**
 * anchors + upgraded anchors（原 probes，断言未动）:
 * config.save agent-switch notification
 * (spec 2026-08-03 +设计).
 *
 * 新恢复模型（设计，arrival 基线）：
 * - userChangedOld = (sessions[old] ?? '') !== (arrivalSessions[old] ?? '')，
 *   在清空 old 之前计算；canRestore = prev[new] 存在 && !userChangedOld。
 * - 恢复分支：消费 prev[new] + arrival[new] = prev；清空分支：保留 prev[new]
 *   停车 + arrival[new] = ''（被拒绝的恢复不清除停车位）。
 * - arrivalSessions 只在 config.save 切换时更新；用户消息 /resume /new /cd
 *   auto-resume 不更新；加载时对每个有 session 的 agent 缺省 arrival = sessions。
 *
 * invariant: 每次切换后文案必须与 sessionStore 状态一致（「将继续
 * sessionId: X」⇔ new agent session === X；「已清空」⇔ new agent session
 * undefined），且恰好 1 条 sendResult；previous 只在恢复分支消费，清空分支
 * 停车保留。
 *
 * boundaries: 5-agent pairwise matrix (claude/codex/pi/opencode/kimi) 文案 +
 * 调用次数；sendResult 失败兜底必须携带当前切换文案且状态一致。
 */

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

describe('anchors & probes (3 probes upgraded): config.save switch notification invariants & boundaries', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(defaultAgent: string, overrides?: Partial<AppConfig>): void {
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = createRouterFixture({
      tmpDir,
      config: buildConfig({
        defaultAgent: defaultAgent as AppConfig['defaultAgent'],
        ...overrides,
      }),
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;
  }

  function makeRouterWithStore(
    store: SessionStore,
    defaultAgent: string,
    overrides?: Partial<AppConfig>,
  ): void {
    sessionStore = store;
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = createRouterFixture({
      tmpDir,
      config: buildConfig({
        defaultAgent: defaultAgent as AppConfig['defaultAgent'],
        ...overrides,
      }),
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;
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

  function _lastNotice(): string {
    return lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
  }

  function _allNotices(): string[] {
    return allNotices(bridge.sendResult as ReturnType<typeof vi.fn>);
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

    // claude→codex：claude 有 session → 已清空，codex 无 previous → 清空
    await doSwitch(userId, ctx, 'codex');
    let calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(_lastNotice()).toContain('Codex');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();

    // codex 上产生新 session
    sessionStore.setSessionId(userId, 'codex', 'codex-session-Y');

    // codex→pi：codex 有 session → 已清空
    await doSwitch(userId, ctx, 'pi');
    calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(_lastNotice()).toContain('Pi');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();

    // pi 上产生新 session
    sessionStore.setSessionId(userId, 'pi', 'pi-session-Z');

    // pi→opencode：pi 有 session → 已清空
    await doSwitch(userId, ctx, 'opencode');
    expect((bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(_lastNotice()).toContain('Opencode');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'opencode')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'opencode')).toBeUndefined();

    // opencode 上产生新 session
    sessionStore.setSessionId(userId, 'opencode', 'opencode-session-W');

    // opencode→kimi：opencode 有 session → 已清空
    await doSwitch(userId, ctx, 'kimi');
    expect((bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    expect(_lastNotice()).toContain('Kimi');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'kimi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'kimi')).toBeUndefined();

    // kimi→claude：kimi 无 session，claude 有 previous X → 必须恢复
    await doSwitch(userId, ctx, 'claude');
    calls = (bridge.sendResult as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(5);
    expect(_lastNotice()).toContain('Claude');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('claude-session-X');
    expect(sessionStore.getSessionId(userId, 'claude')).toBe('claude-session-X');
    // 恢复成功不得残留 previous（泄漏检查）
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
        const text = _lastNotice();
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
    // 序列，第 2 次切换（pi→codex，因 pi 有用户活动 X ≠ arrival '' 被
    // 阻断）sendResult 失败：兜底 toast 必须是「当前这一次」的已清空文案，
    // 不是第 1 次切换的文案；阻断分支保留 codex 的停车 C（新契约：被拒绝的
    // 恢复不清除 previous）；第 3 次切换（codex 无用户活动）仍正常恢复 X 并发
    // 持久化消息。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // codex→pi
    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // pi→codex 时 sendResult 失败
    bridge.sendResult.mockResolvedValueOnce(false);
    await doSwitch(userId, ctx, 'codex');
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const secondNotice = allNotices(sendResultMock)[1];
    expect(secondNotice).toContain('Codex');
    expect(secondNotice).toContain('session 已清空');
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();
    // 新契约：阻断分支保留停车，被拒绝的恢复不得消费 previous[codex]
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');

    // codex→pi：codex 无用户活动（sessions '' === arrival ''）→ 恢复
    // pi-session-X，第 3 条消息成功发送；恢复 pi 不得消费 codex 的停车 C
    const response3 = await doSwitch(userId, ctx, 'pi');
    expect(sendResultMock).toHaveBeenCalledTimes(3);
    const thirdNotice = allNotices(sendResultMock)[2];
    expect(thirdNotice).toContain('pi-session-X');
    expect(thirdNotice).toContain('将继续之前的 session');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');
    expect(response3?.toast).toBeFalsy();
  });

  it('probe_t4_send_failure_on_third_switch_still_restores_and_toasts', async () => {
    // 序列，第 3 次（恢复）切换 sendResult 失败：session 必须已恢复，
    // 兜底 toast 内容必须与当前恢复文案全等（含 sessionId），且 toast 为 info。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    await doSwitch(userId, ctx, 'codex');

    // codex→pi：恢复消息发送失败
    bridge.sendResult.mockResolvedValueOnce(false);
    const response3 = await doSwitch(userId, ctx, 'pi');

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(3);
    const thirdNotice = allNotices(sendResultMock)[2];
    expect(thirdNotice).toContain('将继续之前的 session');
    expect(thirdNotice).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    // 兜底 toast：type info + 内容来自 propagateConfigSave 的切换文案
    expect(response3?.toast).toBeTruthy();
    expect((response3?.toast as { type: string }).type).toBe('info');
    expect((response3?.toast as { content: string }).content).toContain('将继续之前的 session');
    expect((response3?.toast as { content: string }).content).toContain('pi-session-X');
    // 恢复成功后 previous 不得残留
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_restored_session_on_left_agent_must_not_block_next_restore', async () => {
    // 语义的 4 次切换泛化（RED，新契约下成立）：
    //   codex(C) → pi（pi 上发消息 X）→ opencode（无消息）→ codex（无消息，
    //   自动恢复 C）→ pi。
    // 新契约 trace：恢复 C 时 arrival[codex]=C；离开 codex 时
    // userChangedOld(codex) = (C ?? '') === (arrival C ?? '') → false（用户在
    // codex 上从未发消息，自动恢复不算用户活动）→ pi 的 X 必须恢复（消息
    // 「将继续…sessionId: X」），且 pi 的 previous 被消费。
    // 旧实现（prev 代理启发式）把"自动恢复的 session"（停车 prev[codex]）
    // 误当成"用户在 codex 上新建了 session"，会错误走「已清空」——这是
    // stale-previous 修复后仍残留的切换链泄漏路径（恢复成功的
    // session 被旧启发式当作阻塞位）。
    makeRouter('codex');
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'codex', 'codex-session-C');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // codex→pi
    await doSwitch(userId, ctx, 'pi');
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // pi→opencode（pi 有 session X → opencode 无 previous → 已清空）
    await doSwitch(userId, ctx, 'opencode');
    expect(_lastNotice()).toContain('session 已清空');

    // opencode→codex：opencode 无 session，codex 的 previous C 仍有效
    // （用户在 codex 上从未发消息）→ 必须恢复 C
    await doSwitch(userId, ctx, 'codex');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('codex-session-C');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();

    // codex→pi：codex 上的 C 是自动恢复的（用户从未在 codex 发消息）→
    // pi 的 X 必须恢复，消息「将继续…pi-session-X」，previous 被消费
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('pi-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_rejected_restore_keeps_previous_parked_for_future_restore', async () => {
    // 停车语义：
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

    // codex→pi：pi 无 previous → 清空；codex 的 C 停车
    await doSwitch(userId, ctx, 'pi');
    expect(_lastNotice()).toContain('session 已清空');

    // pi 上用户活动：新 session X（不更新 arrival，arrival[pi] 仍为 ''）
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');

    // pi→codex：pi 有用户活动（X ≠ arrival ''）→ 恢复被阻断（已清空）；
    // 被拒绝的恢复不得清除 codex 的停车 C
    await doSwitch(userId, ctx, 'codex');
    expect(_lastNotice()).toContain('session 已清空');
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBe('codex-session-C');

    // codex→opencode：codex 无 session、无用户活动（arrival ''）→ opencode
    // 清空
    await doSwitch(userId, ctx, 'opencode');
    expect(_lastNotice()).toContain('session 已清空');

    // opencode→codex：opencode 无用户活动 → 恢复停车 C
    await doSwitch(userId, ctx, 'codex');
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('codex-session-C');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-C');
    // 恢复分支消费 previous（停车 → 恢复）
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();
  });

  it('test_anchor_previous_and_arrival_sessions_persist_across_store_rebuild', async () => {
    // 持久化迁移：last-session.json 每用户新增 previousSessions 与
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

    // codex→pi：pi 清空到达（arrival[pi]=''）；codex 的 C 停车
    await doSwitch(userId, ctx, 'pi');
    // pi 上用户活动 X（不更新 arrival）
    sessionStore.setSessionId(userId, 'pi', 'pi-session-X');
    // pi→codex：pi 有用户活动 → 阻断（arrival[codex]=''）；pi 的 X 停车，
    // codex 的 C 继续停车
    await doSwitch(userId, ctx, 'codex');
    // codex→pi：codex 无用户活动 → 恢复 X；arrival[pi]=X；prev[pi] 消费
    await doSwitch(userId, ctx, 'pi');

    // 持久化格式契约（设计）：每用户 previousSessions +
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
    // 启动基线（RED）：持久化 claude=X + prev[codex]=Y + arrival[claude]=X
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
    expect(_lastNotice()).toContain('将继续之前的 session');
    expect(_lastNotice()).toContain('codex-session-Y');
    expect(sessionStore.getSessionId(userId, 'codex')).toBe('codex-session-Y');
    // 恢复分支消费 prev[codex]；离开 claude 时 claude 的 X 停车
    expect(sessionStore.getPreviousSessionId(userId, 'codex')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
  });

  it('test_anchor_set_cwd_clears_previous_and_arrival_sessions', async () => {
    // setCwd 重置（守卫）：setCwd 清空 sessions + previousSessions +
    // arrivalSessions（设计语义要点）。本守卫锁已有行为（previous
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
    // 经 config.save 产生到达状态（codex→pi：arrival[pi]=''）
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

/**
 * s:设计（arrival 基线 + 停车语义 + 持久化迁移）的
 * 新建用户分支持久化边界。
 *
 * 攻击点：
 * - setPreviousSessionId 新建用户分支：cwd 未设时 entry.cwd === ''，
 *   autoPersist 与 load 都按 `if (entry.cwd)` 跳过该用户 → 停车位写进
 *   last-session.json 的条目整个丢失，违背「previousSessions 由进程内存升级
 *   为持久化（停车跨重启存活）」。
 * - setArrivalSessionId 新建用户分支：同样 cwd === ''，arrival 基线落盘后
 *   重建丢失，违背「arrivalSessions 持久化迁移」。
 *
 * 注：既有 anchor（round6、session.test.ts）全部先 setCwd 再写
 * previous/arrival，未覆盖这两个新建分支。
 */

describe('new-user-branch persistence of parked previous/arrival', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round7-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchor_r7_parked_previous_survives_rebuild_without_cwd', () => {
    // setPreviousSessionId 对全新用户（未 /cd，cwd 未设）也必须满足
    // 「停车跨重启存活」。new-user 分支 cwd 为 ''，但持久化迁移承诺的是
    // previousSessions 本身落盘，不依赖 cwd 先被设置。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    store1.setPreviousSessionId('user1', 'codex', 'codex-session-P');

    expect(store1.getPreviousSessionId('user1', 'codex')).toBe('codex-session-P');

    // 重建（模拟重启）：停车位必须还在
    const store2 = new SessionStore(filePath);
    expect(store2.getPreviousSessionId('user1', 'codex')).toBe('codex-session-P');
  });

  it('anchor_r7_arrival_baseline_survives_rebuild_without_cwd', () => {
    // setArrivalSessionId 对全新用户（cwd 未设）也必须满足 arrival 持久化
    // 迁移——arrival 基线（恢复判定依据）不能因 cwd 为空被整条丢弃。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    store1.setArrivalSessionId('user1', 'codex', 'codex-session-A');

    expect(store1.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');

    // 重建（模拟重启）：arrival 基线必须还在
    const store2 = new SessionStore(filePath);
    expect(store2.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
  });

  it('anchor_r7_explicit_empty_cwd_still_persists_arrival', () => {
    // 显式空串变体：setCwd(user, '') 后写入 arrival，重建后同样不得丢。
    // autoPersist/load 的 `entry.cwd` 守卫把空串用户整个跳过，属于同一根因。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    store1.setCwd('user1', '');
    store1.setArrivalSessionId('user1', 'codex', 'codex-session-A');

    const store2 = new SessionStore(filePath);
    expect(store2.getArrivalSessionId('user1', 'codex')).toBe('codex-session-A');
  });
});
