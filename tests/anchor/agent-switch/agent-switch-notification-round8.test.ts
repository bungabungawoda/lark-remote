import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { lastNotice, allNotices } from '../../../tests/lib/agent-switch-helpers.js';

/**
 * Round 8 anchors: config.save 失败路径 / 双失败 / 同 agent 等价类 /
 * 连续 save 的守卫（spec 2026-08-03 + Round 5 设计）。
 *
 * 攻击点（任务书 Round 8）：
 * - T2/T4：diffConfig/setConfigValues 阶段抛错（配置校验失败）→
 *   propagateConfigSave 未执行，oldAgent session 未被清、prev 未被写，
 *   「保存失败」路径下 session 状态原样保留；
 * - T2：updateCardInPlace 失败 + sendResult 失败同时发生（双失败）时，
 *   响应必须仍是当前切换文案的 info toast，session 切换状态与持久化消息
 *   尝试一致；
 * - T4：pendingConfig 中 defaultAgent 与当前相同、其他字段有变更 →
 *   不发切换消息、不弹 toast（A4 的更细等价类：先显式 set 同值 defaultAgent
 *   再改其他字段，diff 里同时出现 defaultAgent 键与普通配置键）；
 * - T3：同一用户连续两次 config.save（中间无 config.set）→ 第二次空
 *   pending，只能发「没有待保存的修改」文本，不得发第二条切换消息。
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

describe('Round8 anchors: config.save failure/equivalence boundaries', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function _lastNotice(): string {
    return lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
  }

  function _allNotices(): string[] {
    return allNotices(bridge.sendResult as ReturnType<typeof vi.fn>);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round8-'));
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = new CommandRouter({
      sessionStore,
      bridge,
      config: buildConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchor_r8_validation_failure_preserves_session_state', async () => {
    // T2/T4：pendingConfig 含类型非法字段（stopGraceMs 应为 number，输入 'abc'
    // 在 setConfigValues 的 AppConfigSchema.safeParse 阶段失败）时，config.save
    // 必须报「保存失败」且 propagateConfigSave 不得执行：oldAgent 的 session
    // 原样保留、prev 未写、arrival 未动、配置未落盘、无 toast。
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    sessionStore.setArrivalSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // 非法类型：config.input 阶段卡片仍可渲染（stopGraceMs 不在卡片字段中），
    // 校验失败只发生在 save 的 setConfigValues 阶段
    await router.handleCardAction(
      { cmd: 'config.input', key: 'claude.stopGraceMs', inputValue: 'abc' },
      ctx,
    );
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    const text = _lastNotice();
    expect(text).toContain('保存失败');
    expect(text).not.toContain('已切换到');

    // session 状态必须原样保留（spec：保存失败路径不得清 oldAgent session）
    expect(sessionStore.getSessionId(userId, 'claude')).toBe('claude-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId(userId, 'claude')).toBe('claude-session-X');
    // 配置未写盘
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false);
    expect(response?.toast).toBeFalsy();
  });

  it('anchor_r8_double_failure_card_refresh_and_send_both_fail', async () => {
    // T2：updateCardInPlace 抛错 + sendResult resolve false 双失败：
    // 切换已成功（配置落盘 + session 切换），必须返回当前切换文案的 info
    // toast（而不是「保存失败」文本），pendingConfig 已消费。
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    bridge.updateCardInPlace.mockRejectedValueOnce(new Error('card refresh failed'));
    bridge.sendResult.mockResolvedValueOnce(false);

    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    const notice = _lastNotice();
    expect(notice).toContain('Pi');
    // 双失败兜底：info toast，内容与 propagateConfigSave 的切换文案一致
    expect(response?.toast).toBeTruthy();
    expect((response?.toast as { type: string }).type).toBe('info');
    expect((response?.toast as { content: string }).content).toContain('已切换到 Pi');
    // 切换本身已生效：config 落盘 + session 状态
    const written = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');
    expect(written).toContain('defaultAgent: pi');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
    // 清空到达基线：'' 经 getter 归一化为 undefined（与 round4/round6 既有断言一致）
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();
  });

  it('anchor_r8_same_default_agent_key_plus_other_field_no_switch', async () => {
    // T4 更细等价类：先显式 set defaultAgent=claude（与当前相同），再改
    // claude.model。diff 同时包含 defaultAgent 键与普通配置键，但 defaultAgent
    // 未真正变化 → 不发任何 sendResult（普通配置保存不新增通知）、不弹 toast，
    // 只写盘普通字段。
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await router.handleCardAction(
      { cmd: 'config.set', key: 'defaultAgent', option: 'claude' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.set', key: 'claude.model', option: 'haiku' }, ctx);
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(response?.toast).toBeFalsy();
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).not.toHaveBeenCalled();
    // 普通字段确实写盘
    const written = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');
    expect(written).toContain('model: haiku');
    expect(written).toContain('defaultAgent: claude');
    // 未切换：session 不得被清空或写入 prev
    expect(sessionStore.getSessionId(userId, 'claude')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBeUndefined();
    expect(sessionStore.getArrivalSessionId(userId, 'claude')).toBeUndefined();
  });

  it('anchor_r8_consecutive_save_second_sends_no_changes_no_switch', async () => {
    // T3：同一用户连续两次 config.save（中间无 config.set）。第一次切换成功
    // 并恰好一条切换消息；第二次空 pending 只发「没有待保存的修改」文本，
    // 不得再发第二条切换消息、不弹 toast。
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    const first = await router.handleCardAction({ cmd: 'config.save' }, ctx);
    const second = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const firstText = _allNotices()[0];
    const secondText = _allNotices()[1];
    expect(firstText).toContain('Pi');
    expect(secondText).toContain('没有待保存的修改');
    expect(secondText).not.toContain('已切换到');
    expect(first?.toast).toBeFalsy();
    expect(second?.toast).toBeFalsy();
    // 第一次切换后的状态不得被第二次 save 改变
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBeUndefined();
  });

  it('anchor_r8_failed_save_keeps_pending_and_recovers_on_fixed_save', async () => {
    // T2/T4 恢复性：校验失败后 pendingConfig 必须保留（用户可修正后重存），
    // 修正后再次 save 走正常切换路径（恰好一条切换消息），且第一次失败
    // 不残留任何 session 副作用。
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    sessionStore.setArrivalSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await router.handleCardAction(
      { cmd: 'config.input', key: 'claude.stopGraceMs', inputValue: 'abc' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.save' }, ctx);
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    expect(_lastNotice()).toContain('保存失败');

    // 修正非法字段后再试 defaultAgent 切换
    await router.handleCardAction(
      { cmd: 'config.input', key: 'claude.stopGraceMs', inputValue: '5000' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const notices = _allNotices();
    const notice = notices[1];
    expect(notice).toContain('Pi');
    expect(response?.toast).toBeFalsy();
    // 切换生效：claude 的 X 停车、pi 清空到达
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
  });

  it('anchor_r8_invalid_default_agent_set_does_not_emit_switch_notice', async () => {
    // 攻击点交叉检查：非法 defaultAgent 进入 pendingConfig 后，config.set 与
    // config.save 两阶段都不能把「切换」文案当成功通知发出——只能有失败反馈
    // （设置失败/保存失败），不得出现「已切换到」。
    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'bogus' }, ctx);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const text of _allNotices()) {
      expect(text).not.toContain('已切换到');
    }
    // 失败反馈必须存在（设置失败或保存失败）
    const texts = _allNotices();
    expect(texts.some((t) => t.includes('失败'))).toBe(true);
    // session 必须原样保留（任何失败路径都不清 oldAgent session）
    expect(sessionStore.getSessionId(userId, 'claude')).toBe('claude-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBeUndefined();
  });

  it('anchor_r8_double_failure_state_survives_store_rebuild', async () => {
    // T2 持久化组合：updateCardInPlace 失败 + sendResult 失败的双失败切换后，
    // 停车/到达状态必须已落盘，重建（模拟重启）后行为与一次性执行一致：
    // claude 的 X 停车、pi 清空到达，重启后 claude→pi 仍无恢复机会。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = new CommandRouter({
      sessionStore: store1,
      bridge,
      config: buildConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });
    sessionStore = store1;

    const userId = 'user1';
    sessionStore.setCwd(userId, tmpDir);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-X');
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    bridge.updateCardInPlace.mockRejectedValueOnce(new Error('card refresh failed'));
    bridge.sendResult.mockResolvedValueOnce(false);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 重建
    const store2 = new SessionStore(filePath);
    const bridge2 = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    const router2 = new CommandRouter({
      sessionStore: store2,
      bridge: bridge2,
      config: buildConfig(),
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    });

    expect(store2.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
    // 重启后 claude→pi 再切：pi 无停车 → 仍「已清空」，claude 的 X 再停车
    await router2.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    await router2.handleCardAction({ cmd: 'config.save' }, ctx);
    const text2 = lastNotice(bridge2.sendResult as ReturnType<typeof vi.fn>);
    expect(text2).toContain('session 已清空');
    expect(store2.getPreviousSessionId(userId, 'claude')).toBe('claude-session-X');
    expect(store2.getArrivalSessionId(userId, 'pi')).toBeUndefined();
  });
});
