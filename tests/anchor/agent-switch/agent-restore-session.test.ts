import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { lastNotice } from '../../lib/agent-switch-helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

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

// Stub runner

// Mock bridge
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
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
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
