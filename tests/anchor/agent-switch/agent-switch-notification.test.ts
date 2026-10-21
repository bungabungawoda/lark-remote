import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { lastNotice, allNotices } from '../../lib/agent-switch-helpers.js';
import { createRouterFixture } from '../../lib/router-fixture.js';
import { buildAgentSwitchConfig as buildConfig } from '../../lib/agent-switch-helpers.js';

/**
 * Anchor: config.save 切换 defaultAgent 的持久化切换通知（含失败/等价类边界）。
 *
 * 验证：当用户通过 /config 卡片将 defaultAgent 从 'claude' 切换到 'pi' 并保存后，
 * 必须通过 bridge.sendResult 发送一条持久化消息通知用户 agent 已切换、session
 * 将会清空；成功路径不得再返回 toast。
 *
 * 缺失影响：用户不知道 agent 已切换，不清楚之前的 session 上下文已失效；且 toast
 * 是飞书回调即时反馈，几秒后消失、聊天记录里不可回溯，无法满足"需要持久化看到"。
 *
 * 依据：用户需求"config 卡片上的切换 coding agent 点击保存，发送 toast 提醒，
 *       改为发送消息提醒，因为需要持久化看到"。
 */

// Mock bridge that can capture sendResult calls

const buildDefaultConfig = (): AppConfig =>
  buildConfig({
    agents: { pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' } },
  });

describe('config.save sends persistent message notification on agent switch', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-toast-test-'));
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });

    router = createRouterFixture({
      tmpDir,
      config: buildDefaultConfig(),
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    }).router;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_config_save_sends_message_on_agent_switch', async () => {
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd
    sessionStore.setCwd(userId, cwd);

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // First set the defaultAgent to pi (pendingConfig)
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);

    // Then save - this should send a persistent message via bridge.sendResult
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // Persistent message must be sent exactly once, mentioning the new agent and 切换
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    const text = lastNotice(sendResultMock);
    expect(text).toContain('Pi');
    expect(text).toContain('切换');
    // sendResult 第二参数必须原样传 ctx（userId/chatId/messageId），保证
    // 持久化消息作为当前对话的回复发出，而不是发到别的会话
    expect(sendResultMock).toHaveBeenCalledWith(expect.anything(), ctx);
    // Success path must NOT return a toast (toast is transient, not persistent)
    expect(response?.toast).toBeFalsy();
  });

  it('test_anchor_same_agent_no_switch_notification', async () => {
    /**
     * 验证：defaultAgent 未切换（仅普通配置项变更）时，config.save 不得发送切换
     * 通知、不得返回 toast。
     *
     * 注意：同 agent 无变更路径可能合法发送「没有待保存的修改/没有变更需要保存」
     * 文本（走 sendResult），因此本测试只锁定「没有切换文案」+「没有 toast」，
     * 不能断言 sendResult 从未被调用——否则会把合法文本误判为切换通知。
     *
     * 缺失影响：若切换通知被错误地发到未切换路径，或同 agent 保存也弹 toast，
     * 用户会收到误导性反馈。
     *
     * 依据："defaultAgent 未切换（diff 为空或仅普通配置项变更）→
     * 不发切换消息、不返回 toast（保持现状；同 agent 无变更路径仍可发
     * 「没有待保存的修改/没有变更需要保存」文本，测试不得误判为切换通知）"。
     */
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd
    sessionStore.setCwd(userId, cwd);

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // Change a non-defaultAgent config field (claude.model); defaultAgent stays claude
    await router.handleCardAction({ cmd: 'config.set', key: 'claude.model', option: 'haiku' }, ctx);

    // Then save - agent didn't change, so no switch message and no toast
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(response?.toast).toBeFalsy();
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    const texts = allNotices(sendResultMock);
    for (const t of texts) {
      expect(t).not.toContain('已切换到');
    }
  });

  it('test_anchor_config_save_fallback_toast_when_send_fails', async () => {
    /**
     * 验证：sendResult 发送失败（真实 Bridge.sendResult 内部 catch，失败 resolve
     * false，绝不 throw）时，config.save 必须兜底返回 toast，用户至少得到即时反馈。
     *
     * 缺失影响：持久化消息发送失败后用户得不到任何反馈，会以为切换没生效，
     * 重复点击保存；配置其实已落盘，只有通知失败。
     *
     * 依据："sendResult 发送失败（Promise resolve false/undefined）时，
     * 必须兜底返回 toast（用户至少得到即时反馈）。配置已先落盘，通知失败不影响正确性"。
     */
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd
    sessionStore.setCwd(userId, cwd);

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // First set the defaultAgent to pi (pendingConfig)
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);

    // 本次保存时持久化消息发送失败（真实契约：resolve false，不 throw）
    bridge.sendResult.mockResolvedValueOnce(false);

    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 消息被尝试发送一次（内容仍为切换文案），第二参数原样携带 ctx
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(1);
    const text = lastNotice(sendResultMock);
    expect(text).toContain('切换');
    expect(sendResultMock).toHaveBeenCalledWith(expect.anything(), ctx);
    // 发送失败 → 兜底回退 toast（即时反馈），内容来自 propagateConfigSave 的切换文案
    expect(response?.toast).toBeTruthy();
    expect((response?.toast as { content: string }).content).toContain('已切换到 Pi');
    // 兜底 toast 类型必须锁定 'info'（信息提示，不是错误/警告，
    // 否则用户会被误导以为保存失败）
    expect((response?.toast as { type: string }).type).toBe('info');
  });

  it('test_anchor_config_save_switch_notice_survives_card_refresh_failure', async () => {
    /**
     * 验证（补充判据 6）：defaultAgent 切换已成功——配置写盘 +
     * session 清理/恢复已执行——但随后的 updateCardInPlace 抛错时，
     * bridge.sendResult 仍必须收到切换文案（第二参数原样 ctx）；不得被
     * catch 吞掉、不得被「保存失败」替代。
     *
     * 缺失影响：updateCardInPlace 只是保存后的原地卡片刷新（UI 展示层）。
     * 若刷新失败导致切换通知丢失，用户既收不到持久化切换消息，还会被
     * 「保存失败」误导——实际配置已落盘、session 已处理，重复点击保存
     * 只会制造更多困惑。
     *
     * 依据：补充判据 6——"切换通知不得被卡片刷新失败吞掉……
     * catch 分支不得把切换通知误报成「保存失败」"。
     */
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd
    sessionStore.setCwd(userId, cwd);

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // 先暂存 defaultAgent 切换（claude → pi）
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);

    // 模拟保存时卡片原地刷新失败（飞书 patch 请求网络错误等）
    bridge.updateCardInPlace.mockRejectedValueOnce(new Error('card refresh failed'));

    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;

    // 核心契约：切换通知必须仍然发出（内容为切换文案、第二参数原样 ctx）
    expect(sendResultMock).toHaveBeenCalledWith(expect.anything(), ctx);

    // 不得把切换通知误报成「保存失败」（配置其实已成功落盘）
    const texts = allNotices(sendResultMock);
    for (const t of texts) {
      expect(t).not.toContain('保存失败');
    }

    // 判据 6 前提：切换本身必须已生效（配置写盘 + session 清理/恢复已执行），
    // 防止用"刷新失败时跳过切换处理"的方式绕过核心契约
    const written = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');
    expect(written).toContain('defaultAgent: pi');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_config_save_no_pending_no_op_message', async () => {
    /**
     * 验证（守卫）：无 pendingConfig 时直接 config.save，必须通过
     * sendResult 发送「没有待保存的修改」文本，且不返回 toast。
     *
     * 缺失影响：若该路径静默吞掉或误弹 toast，用户无法区分"没有可保存内容"
     * 与"保存已成功"，会重复点击或误解状态。
     *
     * 依据："同 agent 无变更路径仍可发「没有待保存的
     * 修改/没有变更需要保存」文本，测试不得误判为切换通知"。
     */
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd
    sessionStore.setCwd(userId, cwd);

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // 从未点击任何 config.* 按钮 → pendingConfig 为 null
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledWith({ text: '没有待保存的修改' }, ctx);
    expect(response?.toast).toBeFalsy();
  });

  it('test_anchor_config_save_empty_diff_message', async () => {
    /**
     * 验证（守卫）：pendingConfig 已存在但与当前 config 完全一致（diff
     * 为空）时，config.save 必须发送「没有变更需要保存」文本、不返回 toast、
     * 不发切换通知。
     *
     * 缺失影响：空 diff 若被当成真实保存处理（写盘/发切换消息/toast），会
     * 产生无意义落盘与误导性反馈。
     *
     * 依据：同 agent 无变更路径可发「没有变更需要保存」
     * 文本，测试不得误判为切换通知。
     */
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd
    sessionStore.setCwd(userId, cwd);

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // 暂存 defaultAgent=claude（与当前 config 相同）→ 制造空 diff 的
    // pendingConfig，验证 save 走「没有变更需要保存」分支而非切换通知
    await router.handleCardAction(
      { cmd: 'config.set', key: 'defaultAgent', option: 'claude' },
      ctx,
    );

    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledWith({ text: '没有变更需要保存' }, ctx);
    expect(response?.toast).toBeFalsy();
    // 空 diff 不得触发切换通知
    const texts = allNotices(sendResultMock);
    for (const t of texts) {
      expect(t).not.toContain('已切换到');
    }
  });
});

/**
 * config.save 失败路径 / 双失败 / 同 agent 等价类 /
 * 连续 save 的守卫（spec 2026-08-03 +设计）。
 *
 * 攻击点：
 * - diffConfig/setConfigValues 阶段抛错（配置校验失败）→
 *   propagateConfigSave 未执行，oldAgent session 未被清、prev 未被写，
 *   「保存失败」路径下 session 状态原样保留；
 * - updateCardInPlace 失败 + sendResult 失败同时发生（双失败）时，
 *   响应必须仍是当前切换文案的 info toast，session 切换状态与持久化消息
 *   尝试一致；
 * - pendingConfig 中 defaultAgent 与当前相同、其他字段有变更 →
 *   不发切换消息、不弹 toast（的更细等价类：先显式 set 同值 defaultAgent
 *   再改其他字段，diff 里同时出现 defaultAgent 键与普通配置键）；
 * - 同一用户连续两次 config.save（中间无 config.set）→ 第二次空
 *   pending，只能发「没有待保存的修改」文本，不得发第二条切换消息。
 */
describe('config.save failure/equivalence boundaries', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function lastSwitchNotice(): string {
    return lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
  }

  function allSwitchNotices(): string[] {
    return allNotices(bridge.sendResult as ReturnType<typeof vi.fn>);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-round8-'));
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = createRouterFixture({
      tmpDir,
      config: buildConfig(),
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anchor_r8_validation_failure_preserves_session_state', async () => {
    // pendingConfig 含类型非法字段（stopGraceMs 应为 number，输入 'abc'
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
    const text = lastSwitchNotice();
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
    // updateCardInPlace 抛错 + sendResult resolve false 双失败：
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
    const notice = lastSwitchNotice();
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
    // 更细等价类：先显式 set defaultAgent=claude（与当前相同），再改
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
    // 同一用户连续两次 config.save（中间无 config.set）。第一次切换成功
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
    const firstText = allSwitchNotices()[0];
    const secondText = allSwitchNotices()[1];
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
    // 恢复性：校验失败后 pendingConfig 必须保留（用户可修正后重存），
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
    expect(lastSwitchNotice()).toContain('保存失败');

    // 修正非法字段后再试 defaultAgent 切换
    await router.handleCardAction(
      { cmd: 'config.input', key: 'claude.stopGraceMs', inputValue: '5000' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const notices = allSwitchNotices();
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
    for (const text of allSwitchNotices()) {
      expect(text).not.toContain('已切换到');
    }
    // 失败反馈必须存在（设置失败或保存失败）
    const texts = allSwitchNotices();
    expect(texts.some((t) => t.includes('失败'))).toBe(true);
    // session 必须原样保留（任何失败路径都不清 oldAgent session）
    expect(sessionStore.getSessionId(userId, 'claude')).toBe('claude-session-X');
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBeUndefined();
  });

  it('anchor_r8_double_failure_state_survives_store_rebuild', async () => {
    // 持久化组合：updateCardInPlace 失败 + sendResult 失败的双失败切换后，
    // 停车/到达状态必须已落盘，重建（模拟重启）后行为与一次性执行一致：
    // claude 的 X 停车、pi 清空到达，重启后 claude→pi 仍无恢复机会。
    const filePath = path.join(tmpDir, 'last-session.json');
    const store1 = new SessionStore(filePath);
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    sessionStore = store1;
    router = createRouterFixture({
      tmpDir,
      config: buildConfig(),
      bridge,
      sessionStore: store1,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;

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
    const router2 = createRouterFixture({
      tmpDir,
      config: buildConfig(),
      bridge: bridge2,
      sessionStore: store2,
      sessionReaderRegistry: createMockSessionReaderRegistry(),
    }).router;

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

/**
 * Anchor: config.save 切换 agent 再切回来时，应恢复之前的 session
 *
 * 验证场景：
 * 1. 用户当前 agent=A，有 sessionId=X
 * 2. 切换 A → B（无消息）→ 发送切换卡片
 * 3. 切换 B → A（无消息）→ 发送 Resume 卡片（含恢复的 sessionId）
 *
 * 如果在 B 上发送了消息（新 session），切回 A 时应清空 A 的 session。
 *
 * 通知形式：2026-08-13 起切换通知由纯文本改为 Resume 卡片
 * （用户需求：切换 agent 后能看到会话状态和历史，而不仅是文本通知）。
 */
function buildPiConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'pi',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: {
      pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' },
      codex: { model: 'claude-sonnet-4-20250514' },
    },
    cwd: { default: '' },
  });
}

describe('config.save restores previous session when switching back', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-restore-test-'));
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_restore_session_on_switch_back', async () => {
    // Setup: user on pi with sessionId
    const config = buildPiConfig(); // defaultAgent = pi
    router = createRouterFixture({
      tmpDir,
      config,
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    }).router;

    const userId = 'user1';
    const cwd = tmpDir;
    sessionStore.setCwd(userId, cwd);
    sessionStore.setSessionId(userId, 'pi', 'pi-session-123');

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // Step 1: Switch pi -> codex (no messages sent in between)
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'codex' }, ctx);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // After switch: pi session should be saved, codex session cleared
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
    expect(sessionStore.getSessionId(userId, 'codex')).toBeUndefined();

    // Step 2: Switch codex -> pi (still no messages)
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    const response2 = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // CRITICAL: pi session should be RESTORED
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-session-123');

    // 两次切换各发一条持久化消息（恰好 2 条）。先断言调用次数再取 lastCall：
    // 若 sendResult 从未被调用，失败信息直指「行为缺失」而非 TypeError
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const notice = lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
    expect(notice).toContain('Pi');
    expect(notice).toContain('继续之前的 session');
    expect(notice).toContain('pi-session-123');
    // Success path must NOT return a toast (toast is transient, not persistent)
    expect(response2?.toast).toBeFalsy();
  });

  it('test_anchor_no_restore_if_new_session_created', async () => {
    // Setup: user on pi with sessionId
    const config = buildPiConfig(); // defaultAgent = pi
    router = createRouterFixture({
      tmpDir,
      config,
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    }).router;

    const userId = 'user1';
    const cwd = tmpDir;
    sessionStore.setCwd(userId, cwd);
    sessionStore.setSessionId(userId, 'pi', 'pi-session-123');

    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // Step 1: Switch pi -> codex
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'codex' }, ctx);
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // Step 2: Simulate user sending message on codex (new session created)
    sessionStore.setSessionId(userId, 'codex', 'codex-new-session-456');

    // Step 3: Switch codex -> pi
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // CRITICAL: pi session should be CLEARED (not restored) because user created new session on codex
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();

    // 两次切换各发一条持久化消息（恰好 2 条）。先断言调用次数再取 lastCall：
    // 若 sendResult 从未被调用，失败信息直指「行为缺失」而非 TypeError
    const sendResultMock = bridge.sendResult as ReturnType<typeof vi.fn>;
    expect(sendResultMock).toHaveBeenCalledTimes(2);
    const notice = lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
    expect(notice).toContain('Pi');
    expect(notice).toContain('session 已清空');
    expect(notice).not.toContain('继续之前的 session');
    // Success path must NOT return a toast (toast is transient, not persistent)
    expect(response?.toast).toBeFalsy();
  });
});

/**
 * Anchor: config.save 切换 defaultAgent 时必须保留新 agent 的显式选择 session
 *
 * 验证：当用户通过 /config 卡片将 defaultAgent 从 'claude' 切换到 'pi' 并保存后，
 * 若 pi 已处于显式选择状态（sessions[pi] 非空且不等于 arrival[pi] 到达基线），
 * 该选择必须存活：sessions[pi] 保留、arrival[pi] 更新为所选 session（新基线）、
 * 消息含「已使用所选 session」与 sessionId、无 toast；claude 被清空并停车到
 * prev[claude]。
 *
 * 缺失影响：若切换仍按 2026-07-18 旧语义清空新 agent 的 sessionId（等效 /new），
 * 用户经 /resume 显式选择的会话会被丢弃，切换后进入错误上下文并收到误导性文案。
 *
 * 依据：2026-08-03 用户裁决新语义——/resume 对非当前 agent 的显式选择在
 * config.save 切入时存活，优先级「显式选择 > 停车恢复 > 清空」，arrival 更新为
 * 所选 session（新基线）。本测试不经过 resume.use 卡片路径，直接播种与相同
 * 的 router 可见状态（sessions[new] ≠ arrival[new]），属「直接状态等价」变体；
 * resume.use 路径本身由 round9 的
 * test_anchor_r1_resume_selection_survives_config_save_switch 覆盖。
 */
describe('config.save keeps explicitly selected new agent session on agent switch', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-session-test-'));
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });

    router = createRouterFixture({
      tmpDir,
      config: buildDefaultConfig(),
      bridge,
      sessionStore,
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    }).router;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_config_save_keeps_explicitly_selected_new_agent_session', async () => {
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd and sessionIds for BOTH agents
    // - claude (old agent): has an existing session
    // - pi (new agent): has an existing session with arrival unset——与
    //   （/resume 显式选择：sessions[new] 非空且不等于 arrival 基线）等价的状态
    sessionStore.setCwd(userId, cwd);
    sessionStore.setSessionId(userId, 'claude', 'claude-session-123');
    sessionStore.setSessionId(userId, 'pi', 'pi-old-session-456'); // New agent already has session

    // Verify initial state: both have sessionId
    expect(sessionStore.getSessionId(userId, 'claude')).toBe('claude-session-123');
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-old-session-456');

    // Simulate user clicking config.set to switch defaultAgent from claude to pi, then config.save
    const ctx = { userId, chatId: 'chat1', messageId: 'msg1' };

    // First set the defaultAgent to pi (pendingConfig)
    await router.handleCardAction({ cmd: 'config.set', key: 'defaultAgent', option: 'pi' }, ctx);

    // Then save——新语义 显式选择优先，必须保留而非清空
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 持久化消息发送成功（sendResult resolve true）时不得回退 toast
    expect(response?.toast).toBeFalsy();
    expect(lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>)).toContain(
      '已使用所选 session',
    );
    expect(lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>)).toContain(
      'pi-old-session-456',
    );
    expect(lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>)).not.toContain(
      'session 已清空',
    );

    // 显式选择的 pi session 存活，arrival 更新为所选 session（新基线）
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-old-session-456');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-old-session-456');

    // 旧 agent claude 清空并停车到 prev[claude]
    expect(sessionStore.getSessionId(userId, 'claude')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-123');
  });
});
