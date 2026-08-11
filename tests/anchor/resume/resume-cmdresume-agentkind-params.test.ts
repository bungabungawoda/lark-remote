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
 * Anchor AC2: cmdResume 支持通过 args 首位指定 agentKind 覆盖默认推断
 *
 * 验证：
 * 1. 当 defaultAgent = 'kimi' 时，cmdResume 默认用 KimiSessionReader
 * 2. 当调用 cmdResume(['pi', sessionId], ctx) 时，应使用 PiSessionReader
 *
 * 根因：resume.use handler 用正确的 reader 验证通过后调用 cmdResume，
 * 但 cmdResume 内部用 defaultAgent 推断 reader，导致用错 reader 查询。
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

describe('AC2: cmdResume supports agentKind via args', () => {
  let tmpDir: string;
  let piDir: string;
  let piSessionsDir: string;
  let kimiDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdresume-agent-kind-'));
    piDir = path.join(tmpDir, 'pi-agent');
    piSessionsDir = path.join(piDir, 'sessions');
    kimiDir = path.join(tmpDir, 'kimi-code');
    fs.mkdirSync(piSessionsDir, { recursive: true });
    fs.mkdirSync(kimiDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_cmdresume_accepts_agentkind_parameter_override', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);

    // 创建 pi session（存在）
    // 注意：pi 的目录编码会去掉前导 /
    const piEncodedCwd = canonicalCwd.replace(/^\//, '').replace(/\//g, '-');
    const piProjectDir = path.join(piSessionsDir, `--${piEncodedCwd}--`);
    fs.mkdirSync(piProjectDir, { recursive: true });
    const piSessionId = 'eeeeeeee-1111-2222-3333-444444444444';
    const piJsonlContent =
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
      '\n';
    fs.writeFileSync(
      path.join(piProjectDir, `2026-01-15T08-00-00-000Z_${piSessionId}.jsonl`),
      piJsonlContent,
    );

    // 初始化：defaultAgent = 'kimi'（不是 pi）
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'kimi', // 注意：不是 pi
    });

    // 构造 registry，注册 pi 和 kimi reader
    const piReader = new PiSessionReader({ piDir });
    // 手动修复 piReader 的 sessionsDir，指向我们创建的测试目录
    (piReader as any).sessionsDir = piSessionsDir;
    const registry = new SessionReaderRegistry();
    registry.register('pi', piReader);
    // kimi reader 返回空（模拟没有 kimi session）
    const kimiReader = {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [], reason: 'not_found' }),
      isSessionActive: () => false,
    } as unknown as import('../../../src/runner/index.js').AgentSessionReader;
    registry.register('kimi', kimiReader);

    const bridge = new Bridge({
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      sessionReaderRegistry: registry,
    });

    // 先 /cd 设置 cwd
    sessionStore.setCwd('user1', canonicalCwd);
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

    // 核心验证：当用 cmdResume 恢复 pi session 时，args 首位传 'pi' 指定 agentKind
    // 期望：返回包含 pi session 内容（displayTitle: "placeholder"）
    // 如果不传 agentKind 或用默认，会走 kimi reader，返回 "未找到 session"

    // 使用私有方法（通过 any 绕过类型检查）
    // @ts-expect-error - accessing private method for testing
    const result = router.cmdResume(['pi', piSessionId], ctx);

    // 验证：结果应该成功恢复 pi session（不是 "未找到 session"）
    const resultText = JSON.stringify(result);

    // 有 bug 时：返回 "未找到 session eeeeeeee-..."（因为用 kimi reader 查）
    // 修复后：应该返回包含 displayTitle 的卡片或文本
    expect(resultText).toContain('placeholder');
    expect(resultText).not.toContain('未找到 session');
  });
});
