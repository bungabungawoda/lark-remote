import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { lastNotice } from '../../../tests/lib/agent-switch-helpers.js';

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
 * 依据：2026-08-03 用户裁决新语义 A1——/resume 对非当前 agent 的显式选择在
 * config.save 切入时存活，优先级「显式选择 > 停车恢复 > 清空」，arrival 更新为
 * 所选 session（新基线）。本测试不经过 resume.use 卡片路径，直接播种与 A1 相同
 * 的 router 可见状态（sessions[new] ≠ arrival[new]），属「直接状态等价」变体；
 * resume.use 路径本身由 round9 的
 * test_anchor_r1_resume_selection_survives_config_save_switch 覆盖。
 */

// Stub runner

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

describe('config.save keeps explicitly selected new agent session on agent switch', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function _lastNotice(): string {
    return lastNotice(bridge.sendResult as ReturnType<typeof vi.fn>);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-switch-session-test-'));
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

  it('test_anchor_config_save_keeps_explicitly_selected_new_agent_session', async () => {
    const userId = 'user1';
    const cwd = tmpDir;

    // Set cwd and sessionIds for BOTH agents
    // - claude (old agent): has an existing session
    // - pi (new agent): has an existing session with arrival unset——与 A1
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

    // Then save——新语义 A1：显式选择优先，必须保留而非清空
    const response = await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 持久化消息发送成功（sendResult resolve true）时不得回退 toast
    expect(response?.toast).toBeFalsy();
    expect(_lastNotice()).toContain('已使用所选 session');
    expect(_lastNotice()).toContain('pi-old-session-456');
    expect(_lastNotice()).not.toContain('session 已清空');

    // 显式选择的 pi session 存活，arrival 更新为所选 session（新基线）
    expect(sessionStore.getSessionId(userId, 'pi')).toBe('pi-old-session-456');
    expect(sessionStore.getArrivalSessionId(userId, 'pi')).toBe('pi-old-session-456');

    // 旧 agent claude 清空并停车到 prev[claude]
    expect(sessionStore.getSessionId(userId, 'claude')).toBeUndefined();
    expect(sessionStore.getPreviousSessionId(userId, 'claude')).toBe('claude-session-123');
  });
});
