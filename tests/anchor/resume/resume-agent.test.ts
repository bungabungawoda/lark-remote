/**
 * `/resume` 的 agent 维度：列表参数指定 agent、cmdResume 覆盖 agentKind、
 * defaultAgent 切换后使用新 reader、resume.use 恢复非默认 agent。
 *
 * 合并自 resume-agent-param / resume-cmdresume-agentkind-params /
 * resume-default-agent-switch / resume-switch-default-agent，复用 buildResumeRouter。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { ClaudeSessionReader } from '../../../src/session/claude/index.js';
import { PiSessionReader } from '../../../src/session/pi/index.js';
import { encodedProjectDir, piEncodeCwd } from '../../lib/session-fixtures.js';
import { buildResumeRouter } from '../../lib/resume-fixture.js';

function cfg(defaultAgent = 'claude'): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent,
  });
}

function emptyReader() {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [], reason: 'not_found' }),
    isSessionActive: () => false,
  };
}

function writeClaudeSession(projectsDir: string, cwd: string, sid: string, content: string): void {
  const dir = path.join(projectsDir, encodedProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sid}.jsonl`),
    `{"type":"system","subtype":"init","session_id":"${sid}","cwd":${JSON.stringify(cwd)},"model":"opus"}\n` +
      `{"type":"user","message":{"role":"user","content":"${content}"}}\n`,
  );
}

describe('/resume agent selection', () => {
  let tmpDir: string;
  let claudeProjectsDir: string;
  let codexProjectsDir: string;
  let piDir: string;
  let piSessionsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-agent-test-'));
    claudeProjectsDir = path.join(tmpDir, 'claude-projects');
    codexProjectsDir = path.join(tmpDir, 'codex-projects');
    piDir = path.join(tmpDir, 'pi-agent');
    piSessionsDir = path.join(piDir, 'sessions');
    fs.mkdirSync(claudeProjectsDir, { recursive: true });
    fs.mkdirSync(codexProjectsDir, { recursive: true });
    fs.mkdirSync(piSessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHarness(registry: SessionReaderRegistry, config: AppConfig = cfg()) {
    const h = buildResumeRouter({ tmpDir, registry, config });
    h.sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    return h;
  }

  it('test_anchor_resume_codex_listsession_shows_agent_in_header', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);
    writeClaudeSession(codexProjectsDir, canonicalCwd, 'codex-list-header-session', 'codex task');

    const registry = new SessionReaderRegistry();
    registry.register('claude', new ClaudeSessionReader({ projectsDir: claudeProjectsDir }));
    registry.register('codex', new ClaudeSessionReader({ projectsDir: codexProjectsDir }));

    const h = makeHarness(registry);
    await h.router.handle('/resume codex', h.ctx);

    const sent = h.connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    const input = sent[0].input as {
      text?: string;
      card?: { header?: { title?: { content?: string } } };
    };
    expect(input.card?.header?.title?.content).toContain('Codex');
  });

  it('test_anchor_resume_default_agent_shows_agent_in_header', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);
    writeClaudeSession(
      claudeProjectsDir,
      canonicalCwd,
      'claude-list-header-session',
      'claude task',
    );

    const registry = new SessionReaderRegistry();
    registry.register('claude', new ClaudeSessionReader({ projectsDir: claudeProjectsDir }));

    const h = makeHarness(registry);
    await h.router.handle('/resume', h.ctx);

    const sent = h.connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    const input = sent[0].input as {
      text?: string;
      card?: { header?: { title?: { content?: string } } };
    };
    expect(input.card?.header?.title?.content).toContain('Claude');
  });

  it('test_anchor_resume_unregistered_agent_falls_back_to_session_id', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);
    writeClaudeSession(claudeProjectsDir, canonicalCwd, 'unregistered-agent-test', 'test task');

    const registry = new SessionReaderRegistry();
    registry.register('claude', new ClaudeSessionReader({ projectsDir: claudeProjectsDir }));
    // 不注册 gemini, codex 等

    const h = makeHarness(registry);
    await h.router.handle('/resume gemini 5', h.ctx);

    const sent = h.connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    const input = sent[0].input as { text?: string; card?: unknown };
    // 应该返回"未找到 session gemini"（把 gemini 当作 sessionId 处理）
    expect(input.text).toBeDefined();
    expect(input.text).toContain('gemini');
    expect(input.text).toContain('未找到');
  });

  it('test_anchor_resume_session_id_with_explicit_agent', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);
    writeClaudeSession(codexProjectsDir, canonicalCwd, 'codex-session-abc123', 'codex task');

    const registry = new SessionReaderRegistry();
    registry.register('claude', new ClaudeSessionReader({ projectsDir: claudeProjectsDir }));
    registry.register('codex', new ClaudeSessionReader({ projectsDir: codexProjectsDir }));

    const h = makeHarness(registry);
    await h.router.handle('/resume codex abc-123', h.ctx);

    const sent = h.connector._sent;
    expect(sent.length).toBeGreaterThan(0);

    // 形状必须先硬断言：写成 `if (input.text)` 守卫时，输出改成卡片就一条断言都不跑。
    const input = sent[0].input as { text?: string; card?: unknown };
    expect(input.card).toBeUndefined();
    // 应该返回"未找到 session abc-123"，而不是"未找到 session codex abc-123"
    expect(input.text).toContain('未找到');
    expect(input.text).toContain('abc-123');
    expect(input.text).not.toContain('codex abc-123');
  });

  it('test_anchor_cmdresume_accepts_agentkind_parameter_override', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);

    // 创建 pi session（存在）；pi 的目录编码会去掉前导 /
    const piProjectDir = path.join(piSessionsDir, `--${piEncodeCwd(canonicalCwd)}--`);
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

    // 初始化：defaultAgent = 'kimi'（不是 pi）
    const piReader = new PiSessionReader({ piDir });
    piReader.sessionsDir = piSessionsDir;
    const registry = new SessionReaderRegistry();
    registry.register('pi', piReader);
    registry.register('kimi', emptyReader());

    const h = makeHarness(registry, cfg('kimi'));

    const result = h.router.cmdResume(['pi', piSessionId], h.ctx);
    const resultText = JSON.stringify(result);

    // 修复前用 kimi reader 查 → "未找到 session"；修复后应返回 pi 内容。
    expect(resultText).toContain('placeholder');
    expect(resultText).not.toContain('未找到 session');
  });

  it('test_anchor_resume_uses_new_default_agent_reader_after_config_save', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);
    writeClaudeSession(
      claudeProjectsDir,
      canonicalCwd,
      'claude-session-after-switch',
      'test task after agent switch',
    );

    // 初始 defaultAgent = 'pi'；Claude reader 有数据，Pi reader 指向空目录。
    const registry = new SessionReaderRegistry();
    registry.register('claude', new ClaudeSessionReader({ projectsDir: claudeProjectsDir }));
    registry.register('pi', new PiSessionReader({ piDir }));

    const h = makeHarness(registry, cfg('pi'));

    // 通过真实的 /config 卡片 action 流程切换 defaultAgent: pi → claude
    await h.router.handleCardAction(
      { cmd: 'config.set', key: 'defaultAgent', option: 'claude' },
      h.ctx,
    );
    await h.router.handleCardAction({ cmd: 'config.save' }, h.ctx);

    await h.router.handle('/resume', h.ctx);

    const sent = h.connector._sent;
    expect(sent.length).toBeGreaterThan(0);
    // /resume 的输出是最后一条 sendWithRetry（config.save 的 updateCard 不进 _sent）
    const output = sent[sent.length - 1].input as {
      text?: string;
      card?: { body?: { elements?: unknown[] } };
    };
    expect(JSON.stringify(output)).toContain('claude-session-after-switch');
  });

  it('test_anchor_resume_use_sets_session_id_without_switching_defaultAgent', async () => {
    const canonicalCwd = fs.realpathSync(tmpDir);
    const piProjectDir = path.join(piSessionsDir, `--${piEncodeCwd(canonicalCwd)}--`);
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

    const piReader = new PiSessionReader({ piDir });
    piReader.sessionsDir = piSessionsDir;
    const registry = new SessionReaderRegistry();
    registry.register('pi', piReader);
    registry.register('kimi', emptyReader());
    registry.register('claude', emptyReader());

    const h = makeHarness(registry, cfg('kimi'));

    // 跟踪 clearRunners 是否被调用
    const clearRunnersCalls: number[] = [];
    const originalClearRunners = h.bridge.clearRunners.bind(h.bridge);
    h.bridge.clearRunners = () => {
      clearRunnersCalls.push(Date.now());
      return originalClearRunners();
    };

    await h.router.handleCardAction(
      { cmd: 'resume.use', sessionId: piSessionId, agent: 'pi' },
      h.ctx,
    );

    // resume.use 只设置 pi 的 sessionId，不切换 defaultAgent
    expect(h.router.config.defaultAgent).toBe('kimi');
    expect(h.sessionStore.getSessionId('user1', 'pi')).toBe(piSessionId);
    expect(clearRunnersCalls.length).toBe(0);

    const sent = h.connector._sent;
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(sent[0].input)).toContain('placeholder');
  });
});
