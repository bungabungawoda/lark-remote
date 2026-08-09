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
import { PiSessionReader } from '../../../src/session/pi/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
} from '../../lib/bridge-stubs.js';
/**
 * Anchor: /resume 必须使用 defaultAgent 切换后的 sessionReader
 *
 * 验证：用户通过 /config 卡片将 defaultAgent 从 'pi' 切换到 'claude' 并保存后，
 * /resume（无参）应使用 ClaudeSessionReader 列出 claude 的历史会话，
 * 而非继续使用构造时一次性捕获的（现已陈旧的）PiSessionReader。
 *
 * 缺失/错误影响：CommandRouter 构造函数在 line 215-216 基于 opts.config.defaultAgent
 * 一次性捕获 this.sessionReader。config.save 更新 this.config.defaultAgent 后，
 * this.sessionReader 未被刷新——仍指向旧 agent 的 reader。导致 /resume 返回
 * "当前目录没有 Claude session 记录" 误报（实际是用 PiSessionReader 查空目录）。
 * 同一根因影响 /active、自动恢复、resume.use、completionNotificationCard 等
 * 14+ 处直接使用 this.sessionReader 的调用点。
 *
 * 依据：CLAUDE.md "多 agent 注册表抽象" — Bridge/Router 应通过 sessionReaderRegistry
 * 按 config.defaultAgent 动态获取 reader，而非构造时固化引用。
 */

// Stub connector that records sent messages (matching resume-agent-param.test.ts pattern)
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

describe('/resume uses new defaultAgent reader after config.save', () => {
  let tmpDir: string;
  let claudeProjectsDir: string;
  let piDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-default-agent-switch-'));
    claudeProjectsDir = path.join(tmpDir, 'claude-projects');
    piDir = path.join(tmpDir, 'pi-agent');
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    fs.mkdirSync(piDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_resume_uses_new_default_agent_reader_after_config_save', async () => {
    // macOS /tmp → /private/tmp symlink: must realpath to match JSONL cwd field
    const canonicalCwd = fs.realpathSync(tmpDir);

    // 写一个真实的 claude session JSONL 文件，让 ClaudeSessionReader 能列出 1 条
    // 编码必须与 projectDirForCwd 一致：cwd.replace(/\//g, '-').replace(/_/g, '-')
    // （Claude CLI 把 / 和 _ 都换成 -，参见 CLAUDE.md "cwd 编码" 条目）
    const claudeEncoded = canonicalCwd.replace(/\//g, '-').replace(/_/g, '-');
    const claudeProjDir = path.join(claudeProjectsDir, claudeEncoded);
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const claudeSid = 'claude-session-after-switch';
    fs.writeFileSync(
      path.join(claudeProjDir, `${claudeSid}.jsonl`),
      `{"type":"system","subtype":"init","session_id":"${claudeSid}","cwd":"${canonicalCwd}","model":"opus"}\n` +
        `{"type":"user","message":{"role":"user","content":"test task after agent switch"}}\n`,
    );

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    // 初始 defaultAgent = 'pi'，让构造函数捕获 PiSessionReader 作为 this.sessionReader
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        binary: 'claude',
        model: 'opus',
        stopGraceMs: 5000,
      },
      defaultAgent: 'pi',
    });

    // ClaudeSessionReader 指向有 session 的目录；PiSessionReader 指向空目录
    const claudeReader = new ClaudeSessionReader({ projectsDir: claudeProjectsDir });
    const piReader = new PiSessionReader({ piDir });

    const registry = new SessionReaderRegistry();
    registry.register('claude', claudeReader);
    registry.register('pi', piReader);

    const bridge = new Bridge({
      runner,
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
    const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

    // 通过真实的 /config 卡片 action 流程切换 defaultAgent: pi → claude
    await router.handleCardAction(
      { cmd: 'config.set', key: 'defaultAgent', option: 'claude' },
      ctx,
    );
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 调用 /resume — 应使用 ClaudeSessionReader 列出刚写入的 claude session
    await router.handle('/resume', ctx);

    const sent = connector._sent;
    expect(sent.length).toBeGreaterThan(0);

    // /resume 的输出是最后一条 sendWithRetry 调用（config.save 的 updateCard 走 connector.updateCard 不进 _sent）
    const output = sent[sent.length - 1].input as {
      text?: string;
      card?: { body?: { elements?: unknown[] } };
    };

    // 验证：输出必须包含 claude session_id（证明使用了 ClaudeSessionReader）
    // 有 bug 时：this.sessionReader 仍是 PiSessionReader（空目录），返回
    //   { text: "当前目录没有 Claude session 记录\n<cwd>" }
    //   —— 文案含 "Claude" 但不含 session_id，断言失败
    const allOutput = JSON.stringify(output);
    expect(allOutput).toContain(claudeSid);
  });
});
