import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../../src/session/index.js';
import { CommandRouter } from '../../../src/router/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { PiSessionReader } from '../../../src/session/pi/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
/**
 * Anchor: resume.use 恢复非默认 agent session（仅 set sessionId，不切换 defaultAgent）
 *
 * 验证：
 * 1. 当 defaultAgent = 'kimi' 时，用户点击恢复 pi session（agent != defaultAgent）
 * 2. resume.use 设置 pi 的 sessionId，defaultAgent 保持 'kimi'（2026-07-01 设计）
 * 3. clearRunners 不被调用
 * 4. 发送恢复卡片，包含 pi session 内容
 */

// Stub connector
function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  return {
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => '',
    _sent: sent,
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async () => 'file-msg-id',
    updateCard: async () => {},
    start: async () => {},
    stop: async () => {},
  };
}

// Stub runner
function createStubRunner() {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {},
  };
}

describe('resume.use resumes non-default agent session (set sessionId only)', () => {
  let tmpDir: string;
  let piDir: string;
  let piSessionsDir: string;
  let claudeProjectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-switch-agent-'));
    piDir = path.join(tmpDir, 'pi-agent');
    piSessionsDir = path.join(piDir, 'sessions');
    claudeProjectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(piSessionsDir, { recursive: true });
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_use_sets_session_id_without_switching_defaultAgent', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);

    // 创建 pi session
    const piEncodedCwd = canonicalCwd.replace(/^\//, '').replace(/\//g, '-');
    const piProjectDir = path.join(piSessionsDir, `--${piEncodedCwd}--`);
    fs.mkdirSync(piProjectDir, { recursive: true });
    const piSessionId = 'eeeeeeee-1111-2222-3333-444444444444';
    fs.writeFileSync(
      path.join(piProjectDir, `2026-01-15T08-00-00-000Z_${piSessionId}.jsonl`),
      JSON.stringify({
        type: 'session',
        id: piSessionId,
        cwd: canonicalCwd,
        timestamp: '2026-01-15T08:00:00.000Z',
      }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'placeholder' }] },
          timestamp: '2026-01-15T08:00:00.100Z',
        }) +
        '\n',
    );

    // 初始化：defaultAgent = 'kimi'（非 pi）
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'kimi',
    });

    // 注册 pi reader，修复 sessionsDir
    const piReader = new PiSessionReader({ piDir });
    (piReader as any).sessionsDir = piSessionsDir;
    // 注册 kimi reader（空）
    const kimiReader = {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [], reason: 'not_found' }),
      isSessionActive: () => false,
    } as any;

    const registry = new SessionReaderRegistry();
    registry.register('pi', piReader);
    registry.register('kimi', kimiReader);
    // 注册 claude reader（空）
    registry.register('claude', {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [], reason: 'not_found' }),
      isSessionActive: () => false,
    } as any);

    // 创建 bridge 并跟踪 clearRunners 是否被调用
    const clearRunnersCalls: number[] = [];
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const originalClearRunners = bridge.clearRunners.bind(bridge);
    bridge.clearRunners = () => {
      clearRunnersCalls.push(Date.now());
      return originalClearRunners();
    };

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      sessionReaderRegistry: registry,
    });

    // 设置 cwd
    sessionStore.setCwd('user1', canonicalCwd);
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

    // 模拟卡片回调：resume.use（恢复 pi session）
    await router.handleCardAction({ cmd: 'resume.use', sessionId: piSessionId, agent: 'pi' }, ctx);

    // resume.use 只设置 pi 的 sessionId，不切换 defaultAgent（2026-07-01 设计：sessions 按 agent 键存）
    expect((router as unknown as { config: AppConfig }).config.defaultAgent).toBe('kimi');

    // pi 的 sessionId 已设置
    expect(sessionStore.getSessionId('user1', 'pi')).toBe(piSessionId);

    // clearRunners 不应被调用（resume.use 仅 set sessionId）
    expect(clearRunnersCalls.length).toBe(0);

    // 用户收到恢复卡片，包含 pi session 内容
    const sent = connector._sent;
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const resultText = JSON.stringify(sent[0].input);
    expect(resultText).toContain('placeholder');
  });
});
