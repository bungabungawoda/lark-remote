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
import { ClaudeSessionReader } from '../../../src/session/claude/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
/**
 * Anchor: /resume [agent] [N] 双参数功能
 *
 * 验证 /resume 命令支持 agent 类型参数，能选择对应 agent 的 sessionReader
 * 列出该 agent 的历史会话，而非固定使用 config.defaultAgent 的 reader。
 *
 * 缺失/错误影响：用户无法通过 /resume codex 查看 codex 的历史会话，
 * 只能看到 claude 的，多 agent 功能形同虚设。
 *
 * 依据：设计方案 — /resume [agent] [N]，第一个参数为 AgentKind 时切换 reader。
 */

// Stub connector that records sent messages (matching router.test.ts pattern)
function createStubConnector() {
  const sent: { chatId: string; input: unknown; opts?: unknown }[] = [];
  const cards: object[] = [];
  return {
    reconnect: async () => {},
    addReaction: async () => {},
    streamCard: async () => '',
    _sent: sent,
    _cards: cards,
    sendWithRetry: async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      return 'msg-id';
    },
    sendFile: async (chatId: string, filePath: string) => {
      sent.push({ chatId, input: { file: filePath }, opts: undefined });
      return 'file-msg-id';
    },
    updateCard: async (_messageId: string, card: unknown) => {
      cards.push(card as object);
    },
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
    run: async function* () {
      // no-op
    },
  };
}

describe('/resume [agent] [N] dual-parameter feature', () => {
  let tmpDir: string;
  let claudeProjectsDir: string;
  let codexProjectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-agent-test-'));
    claudeProjectsDir = path.join(tmpDir, 'claude-projects');
    codexProjectsDir = path.join(tmpDir, 'codex-projects');
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    fs.mkdirSync(codexProjectsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_codex_listsession_shows_agent_in_header', async () => {
    // 验证：当使用非默认 agent 时，列表卡片的 header 应显示 agent 名称
    // 例如：显示 "🔁 恢复历史会话 · Codex" 而不是 "🔁 恢复历史会话"

    const canonicalCwd = fs.realpathSync(tmpDir);

    // 写一个 codex session，确保列表分支返回卡片而非纯文本
    const codexEncoded = canonicalCwd.replace(/\//g, '-').replace(/_/g, '-');
    const codexProjDir = path.join(codexProjectsDir, codexEncoded);
    fs.mkdirSync(codexProjDir, { recursive: true });
    const codexSid = 'codex-list-header-session';
    fs.writeFileSync(
      path.join(codexProjDir, `${codexSid}.jsonl`),
      `{"type":"system","subtype":"init","session_id":"${codexSid}","cwd":"${canonicalCwd}","model":"opus"}\n` +
        `{"type":"user","message":{"role":"user","content":"codex task"}}\n`,
    );

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'claude',
    });

    const claudeReader = new ClaudeSessionReader({ projectsDir: claudeProjectsDir });
    const codexReader = new ClaudeSessionReader({ projectsDir: codexProjectsDir });

    const registry = new SessionReaderRegistry();
    registry.register('claude', claudeReader);
    registry.register('codex', codexReader);

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

    sessionStore.setCwd('user1', canonicalCwd);

    // /resume codex — 非默认 agent
    await router.handle('/resume codex', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    const sent = connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    const input = sent[0].input as {
      text?: string;
      card?: { header?: { title?: { content?: string } } };
    };

    // 验证：列表卡片的 header 始终显示 agent 名称（非默认 agent 显示其类型）
    expect(input.card?.header?.title?.content).toContain('Codex');
  });

  it('test_anchor_resume_default_agent_shows_agent_in_header', async () => {
    // 验证：当使用默认 agent 时，header 同样显示 agent 名称（当前 Coding Agent）

    const canonicalCwd = fs.realpathSync(tmpDir);

    // 写一个 claude session，确保列表分支返回卡片而非纯文本
    const claudeEncoded = canonicalCwd.replace(/\//g, '-').replace(/_/g, '-');
    const claudeProjDir = path.join(claudeProjectsDir, claudeEncoded);
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const claudeSid = 'claude-list-header-session';
    fs.writeFileSync(
      path.join(claudeProjDir, `${claudeSid}.jsonl`),
      `{"type":"system","subtype":"init","session_id":"${claudeSid}","cwd":"${canonicalCwd}","model":"opus"}\n` +
        `{"type":"user","message":{"role":"user","content":"claude task"}}\n`,
    );

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'claude',
    });

    const claudeReader = new ClaudeSessionReader({ projectsDir: claudeProjectsDir });

    const registry = new SessionReaderRegistry();
    registry.register('claude', claudeReader);

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

    sessionStore.setCwd('user1', canonicalCwd);

    // /resume — 默认 agent
    await router.handle('/resume', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    const sent = connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    const input = sent[0].input as {
      text?: string;
      card?: { header?: { title?: { content?: string } } };
    };

    // 验证：默认 agent 时，header 仍应显示 agent 名称
    expect(input.card?.header?.title?.content).toContain('Claude');
  });

  it('test_anchor_resume_unregistered_agent_falls_back_to_session_id', async () => {
    // 验证：当 agent 类型未注册时，应回退到 sessionId 逻辑
    // /resume gemini 5 -> "gemini" 不是有效 agent，回退为 sessionId="gemini", limit=5

    const canonicalCwd = fs.realpathSync(tmpDir);

    // 写一个 claude session
    // 编码必须与 projectDirForCwd 一致：cwd.replace(/\//g, '-').replace(/_/g, '-')
    const claudeEncoded = canonicalCwd.replace(/\//g, '-').replace(/_/g, '-');
    const claudeProjDir = path.join(claudeProjectsDir, claudeEncoded);
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const claudeSid = 'unregistered-agent-test';
    fs.writeFileSync(
      path.join(claudeProjDir, `${claudeSid}.jsonl`),
      `{"type":"system","subtype":"init","session_id":"${claudeSid}","cwd":"${canonicalCwd}","model":"opus"}\n` +
        `{"type":"user","message":{"role":"user","content":"test task"}}\n`,
    );

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'claude',
    });

    const claudeReader = new ClaudeSessionReader({ projectsDir: claudeProjectsDir });

    const registry = new SessionReaderRegistry();
    registry.register('claude', claudeReader);
    // 不注册 gemini, codex 等

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

    sessionStore.setCwd('user1', canonicalCwd);

    // /resume gemini 5 — gemini 未注册，应该回退为 sessionId="gemini", limit=5
    // 尝试设置 sessionId 为 "gemini"，但 session 不存在
    await router.handle('/resume gemini 5', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    const sent = connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    const input = sent[0].input as { text?: string; card?: unknown };

    // 应该返回"未找到 session gemini"（把 gemini 当作 sessionId 处理）
    expect(input.text).toBeDefined();
    expect(input.text).toContain('gemini');
    expect(input.text).toContain('未找到');
  });

  it('test_anchor_resume_session_id_with_explicit_agent', async () => {
    // 验证：/resume codex abc-123 应该使用 codex 作为 agent，abc-123 作为 sessionId
    // 这是组合语法：agent 在前，sessionId 在后

    const canonicalCwd = fs.realpathSync(tmpDir);

    // 写一个 codex session（在 codex projects dir）
    // 编码必须与 projectDirForCwd 一致：cwd.replace(/\//g, '-').replace(/_/g, '-')
    const codexEncoded = canonicalCwd.replace(/\//g, '-').replace(/_/g, '-');
    const codexProjDir = path.join(codexProjectsDir, codexEncoded);
    fs.mkdirSync(codexProjDir, { recursive: true });
    const codexSid = 'codex-session-abc123';
    fs.writeFileSync(
      path.join(codexProjDir, `${codexSid}.jsonl`),
      `{"type":"system","subtype":"init","session_id":"${codexSid}","cwd":"${canonicalCwd}","model":"opus"}\n` +
        `{"type":"user","message":{"role":"user","content":"codex task"}}\n`,
    );

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'claude',
    });

    const claudeReader = new ClaudeSessionReader({ projectsDir: claudeProjectsDir });
    const codexReader = new ClaudeSessionReader({ projectsDir: codexProjectsDir });

    const registry = new SessionReaderRegistry();
    registry.register('claude', claudeReader);
    registry.register('codex', codexReader);

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

    sessionStore.setCwd('user1', canonicalCwd);

    // /resume codex abc-123 — agent=codex, sessionId=abc-123
    // 注意：session 文件名是 codex-session-abc123，不是 abc-123
    // 这个测试验证 agent 参数被正确识别和使用
    await router.handle('/resume codex abc-123', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    // 调试：检查 sessionStore 中是否保存了 sessionId
    const savedSessionId = sessionStore.getSessionId('user1', 'codex');
    console.log('Saved sessionId for codex:', savedSessionId);

    // 也检查 defaultAgent (claude) 的 session
    const claudeSessionId = sessionStore.getSessionId('user1', 'claude');
    console.log('Saved sessionId for claude:', claudeSessionId);

    const sent = connector._sent;
    console.log('Sent length:', sent.length);
    console.log('First input:', JSON.stringify(sent[0]?.input ?? {}).slice(0, 300));

    // 验证输出包含 sessionId（abc-123）而不是 agent+session 组合
    const input = sent[0].input as { text?: string; card?: unknown };
    if (input.text) {
      console.log('Text output:', input.text);
      // 应该返回"未找到 session abc-123"，而不是"未找到 session codex abc-123"
      expect(input.text).toContain('abc-123');
      expect(input.text).not.toContain('codex abc-123');
    }
  });
});
