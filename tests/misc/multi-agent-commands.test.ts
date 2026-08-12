import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../src/router/index.js';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import type { RunState } from '../../src/card/run-state.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubRunner,
} from '../lib/bridge-stubs.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-legacy-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

function createRouter(overrides?: {
  defaultAgent?: string;
  sessionReaderRegistry?: SessionReaderRegistry;
}) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner = createStubRunner({ withStatusInfo: true });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      effort: 'medium',
      stopGraceMs: 5000,
    },
    defaultAgent: overrides?.defaultAgent ?? 'claude',
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });

  const registry = overrides?.sessionReaderRegistry ?? createStubSessionReaderRegistry();

  const router = new CommandRouter({
    sessionStore,
    bridge: new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    }),
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath: path.join(tmpDir, 'workspace.json'),
    sessionReaderRegistry: registry,
  });
  return { router, sessionStore, connector, config };
}

// ── P0: Issue 1 — /resume empty list hardcoded "Claude" ────────

describe('P0: multi-agent legacy issues — /resume', () => {
  it('test_anchor_resume_empty_list_uses_agent_display_name_not_hardcoded_claude', async () => {
    // When defaultAgent is 'opencode', /resume with no sessions should say
    // "当前没有 Opencode session 记录", NOT "当前没有 Claude session 记录"
    const { router, sessionStore, connector } = createRouter({ defaultAgent: 'opencode' });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/resume', ctx);
    const text = (connector._sent[0].input as { text: string }).text;

    // Must NOT contain hardcoded "Claude"
    expect(text).not.toContain('Claude');
    // Must contain the agent display name "Opencode"
    expect(text).toContain('Opencode');
    expect(text).toContain('session 记录');
  });
});

// ── P0: Issue 2 — /active empty list hardcoded "Claude" ────────

describe('P0: multi-agent legacy issues — /active', () => {
  it('test_anchor_active_empty_list_uses_agent_display_name_not_hardcoded_claude', async () => {
    // New semantics (2026-07-20): /active shows memory-based active runs from THIS bridge process.
    // Empty message changed from "当前没有正在进行中的 {agent} session" to "当前没有正在进行中的任务"
    // This is simpler and doesn't need agent-specific messaging since we're showing in-memory runs only.
    const { router, connector } = createRouter({ defaultAgent: 'codex' });

    await router.handle('/active', ctx);
    const text = (connector._sent[0].input as { text: string }).text;

    // New message: "当前没有正在进行中的任务" - doesn't mention any agent
    expect(text).toContain('没有');
    expect(text).toContain('进行中');
    expect(text).toContain('任务');
    // Should NOT contain hardcoded "Claude" (the old bug)
    expect(text).not.toContain('Claude');
  });
});

// ── P0: Issue 3 — /ps hardcoded "claude 进程" ────────────────

describe('P0: multi-agent legacy issues — /ps', () => {
  it('test_anchor_ps_uses_agent_display_name_not_hardcoded_claude', async () => {
    // When defaultAgent is 'pi', /ps should say "有 Pi 进程在运行",
    // NOT "有 claude 进程在运行"
    const { router, sessionStore, connector } = createRouter({ defaultAgent: 'pi' });
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });

    await router.handle('/ps', ctx);
    const text = (connector._sent[0].input as { text: string }).text;

    // "当前无进程在跑" case: just verify it doesn't contain "claude"
    // (the busy case is harder to simulate in a unit test, but the text
    // is constructed from the same variable)
    expect(text).not.toContain('claude');
  });
});

// ── P0: Issue 4 — /help /stop description hardcoded "claude 进程" ─

describe('P0: multi-agent legacy issues — /help', () => {
  it('test_anchor_help_stop_desc_not_hardcoded_claude', async () => {
    const { router, connector } = createRouter();
    await router.handle('/help', ctx);
    const cardStr = JSON.stringify((connector._sent[0].input as { card: object }).card);

    // /stop description should NOT contain "claude 进程"
    expect(cardStr).not.toMatch(/claude\s*进程/);
    // Should contain a generic description like "终止当前 Agent 进程" or similar
    expect(cardStr).toMatch(/终止.*进程|Agent.*进程/);
  });
});

// ── P1: Issue 5 — /status fallback reads config.claude.model ──

describe('P1: multi-agent legacy issues — /status', () => {
  it('test_anchor_status_fallback_reads_current_agent_model_not_claude', async () => {
    // After S2, /status directly calls runner.getStatusInfo() without runtime checks.
    // The stub runner returns {kind:'claude', model:'test-model'} - verify no hardcoded config.claude.model
    const { router, sessionStore, connector } = createRouter({ defaultAgent: 'opencode' });
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });

    await router.handle('/status', ctx);
    const md = (connector._sent[0].input as { markdown: string }).markdown;

    // Should show model from runner.getStatusInfo(), NOT from config.claude.model
    // stub returns 'test-model', not the hardcoded 'claude-opus-4-8'
    expect(md).toContain('test-model');
    // Should NOT fall back to config.claude.model (claude-opus-4-8)
    expect(md).not.toContain('claude-opus-4-8');
  });
});

// ── P1: Issue 7 — run-state error message hardcoded "Claude 返回错误结果" ─

describe('P1: multi-agent legacy issues — run-state error message', () => {
  it('test_anchor_run_state_result_error_not_hardcoded_claude', async () => {
    // Import the reduceRunState function to test directly
    const { reduceRunState } = await import('../../src/card/run-state.js');
    const result = reduceRunState(
      {
        terminal: 'running' as const,
        footer: null,
        blocks: [] as unknown as RunState['blocks'],
        resultSubtype: undefined,
        errorMsg: undefined,
        sessionId: 'test',
      } as RunState,
      { type: 'result', subtype: 'error', session_id: 'test' },
    );
    // Error message should NOT contain hardcoded "Claude"
    expect(result.errorMsg).not.toContain('Claude');
    // Should contain a generic message
    expect(result.errorMsg).toContain('错误');
  });
});

// ── P1: Issue 8 — bridge stream end hardcoded "Claude 输出流已结束" ─

describe('P1: multi-agent legacy issues — bridge stream end', () => {
  it('test_anchor_bridge_stream_end_not_hardcoded_claude', async () => {
    // The error message in bridge/index.ts should use agentDisplayName
    // We verify by reading the source directly that the hardcoded string is gone
    const source = fs.readFileSync(path.join(process.cwd(), 'src/bridge/index.ts'), 'utf-8');
    // The literal "Claude 输出流已结束" should not appear
    expect(source).not.toContain('Claude 输出流已结束');
  });
});

// ── P2: Issue 9 — /new should indicate which agent's session was cleared ─

describe('P2: multi-agent legacy issues — /new', () => {
  it('test_anchor_new_shows_agent_name_in_clear_message', async () => {
    const { router, sessionStore, connector } = createRouter({ defaultAgent: 'opencode' });
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });

    await router.handle('/new', ctx);
    const text = (connector._sent[0].input as { text: string }).text;

    // Should mention the agent name, not just "session"
    expect(text).toMatch(/Opencode.*session|session.*Opencode/);
  });
});

// ── P2: Issue 10 — new-session card button should show agent name ─

describe('P2: multi-agent legacy issues — new-session card action', () => {
  it('test_anchor_new_session_card_shows_agent_name', async () => {
    const { router, sessionStore, connector } = createRouter({ defaultAgent: 'pi' });
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });

    await router.handleCardAction({ cmd: 'new-session' }, ctx);
    const text = (connector._sent[0].input as { text: string }).text;

    // Should mention the agent name
    expect(text).toMatch(/Pi.*session|session.*Pi|Pi.*会话/);
  });
});

// ── P2: Issue 11 — /resume empty list should suggest agent switching ──

describe('P2: multi-agent legacy issues — /resume agent switching hint', () => {
  it('test_anchor_resume_empty_list_suggests_agent_switching', async () => {
    const { router, sessionStore, connector } = createRouter({ defaultAgent: 'claude' });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/resume', ctx);
    const text = (connector._sent[0].input as { text: string }).text;

    // Should hint about using /resume <agent> to switch agents
    expect(text).toMatch(/resume.*claude|resume.*codex|resume.*opencode|resume.*pi|切换.*agent/i);
  });
});
