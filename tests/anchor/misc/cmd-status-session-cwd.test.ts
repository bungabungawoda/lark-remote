import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../../../src/session/session-store.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

describe('cmdStatus sessionCwd display', () => {
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });

  let store: SessionStore;
  let router: CommandRouter;

  beforeEach(() => {
    store = new SessionStore();
    // Minimal bridge mock — only the methods CommandRouter constructor and cmdStatus call
    const bridge = {
      isBusyFor: () => false,
      getCurrentRunner: () => ({
        getStatusInfo: () => ({ kind: 'claude', model: 'opus', reasoning: '' }),
      }),
      setIdleTimeout: () => {},
      getActiveRuns: () => [],
      getActiveBashRuns: () => [],
      enqueue: async () => {},
      forwardToClaude: async () => {},
      sendResult: async () => {},
    } as any;
    router = new CommandRouter({
      sessionStore: store,
      bridge,
      config,
      configPath: '/tmp/test-config.yaml',
      workspacePath: '/tmp/test-workspace.json',
      ordersPath: '/tmp/test-orders.json',
      sessionReaderRegistry: new SessionReaderRegistry(),
    });
  });

  it('anchor_cmdStatus_shows_sessionCwd_when_different', () => {
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');
    const result = (router as any).cmdStatus({ userId: 'u1' });
    expect(result.markdown).toContain('/main');
    expect(result.markdown).toContain('/worktree');
    expect(result.markdown).toContain('会话目录');
  });

  it('anchor_cmdStatus_single_line_when_same', () => {
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/main');
    const result = (router as any).cmdStatus({ userId: 'u1' });
    expect(result.markdown).not.toContain('会话目录');
    expect(result.markdown).toContain('/main');
  });
});
