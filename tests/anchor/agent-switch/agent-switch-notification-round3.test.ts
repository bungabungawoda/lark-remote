import { createMockBridge, createMockSessionReaderRegistry } from '../../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { lastNotice } from '../../lib/agent-switch-helpers.js';
import { buildAgentSwitchConfig as buildConfig } from '../../lib/agent-switch-helpers.js';

// 测试隔离（设计文档 §9.5「禁真跑 agent」）：本用例走的 config 加载链
// （codex debug models / opencode models --verbose / kimi provider list --json）
// 会经 spawnProcessSync 真起 agent CLI —— Windows 上单次 2-7s，且行为取决于本机
// 装没装这些 CLI，会让「切换 agent」这类用例变成负载相关的偶发红。
// 这里只把同步 CLI 通道短路成「命令失败」，配置层对失败已有 FALLBACK_MODELS 兜底，
// 断言面不变；其余导出保持真实。
vi.mock('../../../src/platform/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn.js')>();
  return {
    ...actual,
    spawnProcessSync: (() => ({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: 1,
      signal: null,
    })) as unknown as typeof actual.spawnProcessSync,
  };
});

/**
 * Round 3 anchor（2026-08-03 Round 6 由 probe 升 anchor，断言未动；spec Round
 * 5 设计下语义不变）：config.save
 * 连续 3 次切换（codex→pi→codex→pi）时，第三次切回 pi 的持久化消息必须是
 * 「将继续之前的 session」而非「session 已清空」。
 *
 * 场景：codex 有 session C → 切到 pi（codex 的 C 存入 previousSessions）→
 * pi 上发消息产生新 session X（用户活动）→ 切到 codex（pi 的 X 存入
 * previousSessions；因 pi 有用户活动，恢复被阻断，arrival[codex]=''）→ 切回 pi。
 * codex 上从未发消息：sessions[codex]='' === arrival[codex]=''（无用户活动），
 * 按 spec Round 5 设计的 arrival 基线，pi 的 X 必须恢复，第三条消息必须携带
 * sessionId: X。历史背景：Round 3 修复前旧实现用 previous 残留代理"用户活动"
 * 并消费停车位，消息文案与 session 恢复双双错误；新契约下断言行为不变。
 */

describe('Round3 anchors: config.save switch notification edge paths', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bridge: ReturnType<typeof createMockBridge>;
  let router: CommandRouter;

  function makeRouter(config: AppConfig): void {
    sessionStore = new SessionStore();
    bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
    router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: createMockSessionReaderRegistry({
        agentKinds: ['claude', 'codex', 'pi', 'opencode'],
      }),
    });
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
