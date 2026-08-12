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
 * Anchor: config.save 切换 defaultAgent 时必须发送持久化消息通知用户
 *
 * 验证：当用户通过 /config 卡片将 defaultAgent 从 'claude' 切换到 'pi' 并保存后，
 * 必须通过 bridge.sendResult 发送一条持久化文本消息通知用户 agent 已切换、session
 * 将会清空；成功路径不得再返回 toast。
 *
 * 缺失影响：用户不知道 agent 已切换，不清楚之前的 session 上下文已失效；且 toast
 * 是飞书回调即时反馈，几秒后消失、聊天记录里不可回溯，无法满足"需要持久化看到"。
 *
 * 依据：用户需求"config 卡片上的切换 coding agent 点击保存，发送 toast 提醒，
 *       改为发送消息提醒，因为需要持久化看到"。
 */

// Mock bridge that can capture sendResult calls

function buildConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'claude',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: {
      pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' },
    },
    workspace: { default: '' },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
  });
}

describe('config.save sends persistent message notification on agent switch', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-toast-test-'));
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });

    const config = buildConfig();
    const registry = createMockSessionReaderRegistry({
      agentKinds: ['claude', 'codex', 'pi', 'opencode'],
    });

    router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: registry,
    });
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
    const sent = sendResultMock.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('Pi');
    expect(sent.text).toContain('切换');
    // A5: sendResult 第二参数必须原样传 ctx（userId/chatId/messageId），保证
    // 持久化消息作为当前对话的回复发出，而不是发到别的会话
    expect(sendResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('已切换到') }),
      ctx,
    );
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
     * 依据：spec 验收 4——"defaultAgent 未切换（diff 为空或仅普通配置项变更）→
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
    for (const call of sendResultMock.mock.calls) {
      const text = (call[0] as { text?: string }).text ?? '';
      expect(text).not.toContain('已切换到');
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
     * 依据：spec——"sendResult 发送失败（Promise resolve false/undefined）时，
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
    const sent = sendResultMock.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('切换');
    expect(sendResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('已切换到') }),
      ctx,
    );
    // 发送失败 → 兜底回退 toast（即时反馈），内容必须与尝试发送的切换文案一致
    expect(response?.toast).toBeTruthy();
    expect((response?.toast as { content: string }).content).toBe(sent.text);
    // A9：兜底 toast 类型必须锁定 'info'（信息提示，不是错误/警告，
    // 否则用户会被误导以为保存失败）
    expect((response?.toast as { type: string }).type).toBe('info');
  });

  it('test_anchor_config_save_switch_notice_survives_card_refresh_failure', async () => {
    /**
     * 验证（spec Round 2 补充判据 6）：defaultAgent 切换已成功——配置写盘 +
     * session 清理/恢复已执行——但随后的 updateCardInPlace 抛错时，
     * bridge.sendResult 仍必须收到切换文案（第二参数原样 ctx）；不得被
     * catch 吞掉、不得被「保存失败」替代。
     *
     * 缺失影响：updateCardInPlace 只是保存后的原地卡片刷新（UI 展示层）。
     * 若刷新失败导致切换通知丢失，用户既收不到持久化切换消息，还会被
     * 「保存失败」误导——实际配置已落盘、session 已处理，重复点击保存
     * 只会制造更多困惑。
     *
     * 依据：spec Round 2 补充判据 6——"切换通知不得被卡片刷新失败吞掉……
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
    expect(sendResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('已切换到') }),
      ctx,
    );

    // 不得把切换通知误报成「保存失败」（配置其实已成功落盘）
    for (const call of sendResultMock.mock.calls) {
      const text = (call[0] as { text: string }).text;
      expect(text).not.toContain('保存失败');
    }

    // 判据 6 前提：切换本身必须已生效（配置写盘 + session 清理/恢复已执行），
    // 防止用"刷新失败时跳过切换处理"的方式绕过核心契约
    const written = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');
    expect(written).toContain('defaultAgent: pi');
    expect(sessionStore.getSessionId(userId, 'pi')).toBeUndefined();
  });

  it('test_anchor_config_save_no_pending_no_op_message', async () => {
    /**
     * 验证（守卫 A7）：无 pendingConfig 时直接 config.save，必须通过
     * sendResult 发送「没有待保存的修改」文本，且不返回 toast。
     *
     * 缺失影响：若该路径静默吞掉或误弹 toast，用户无法区分"没有可保存内容"
     * 与"保存已成功"，会重复点击或误解状态。
     *
     * 依据：spec 验收 4 注——"同 agent 无变更路径仍可发「没有待保存的
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
     * 验证（守卫 A8）：pendingConfig 已存在但与当前 config 完全一致（diff
     * 为空）时，config.save 必须发送「没有变更需要保存」文本、不返回 toast、
     * 不发切换通知。
     *
     * 缺失影响：空 diff 若被当成真实保存处理（写盘/发切换消息/toast），会
     * 产生无意义落盘与误导性反馈。
     *
     * 依据：spec 验收 4 注——同 agent 无变更路径可发「没有变更需要保存」
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
    for (const call of sendResultMock.mock.calls) {
      const text = (call[0] as { text?: string }).text ?? '';
      expect(text).not.toContain('已切换到');
    }
  });
});
