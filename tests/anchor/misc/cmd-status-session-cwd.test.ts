import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../../../src/session/session-store.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';
import { CommandRouter } from '../../../src/router/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { createMockBridge } from '../../lib/bridge-stubs.js';
import { makeTempDir } from '../../lib/temp-dir.js';
import path from 'node:path';

describe('cmdStatus sessionCwd display', () => {
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    workspace: { default: '' },
  });

  let store: SessionStore;
  let router: CommandRouter;
  // 这三个路径 production 真会读/写盘：固定 '/tmp/...' 在 win32 上是仓库外的
  // D:\tmp（跨进程共享 + 兜底 sweep 扫不到）；万一别的 run 真在那留下 config.yaml，
  // 本用例的 config 还会被外来文件覆盖 —— 同源串味。改用本用例独占的 mkdtemp 目录。
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir('lark-cmd-status-cwd-');
    store = new SessionStore();
    // Minimal bridge mock — only the methods CommandRouter constructor and cmdStatus call
    const bridge = createMockBridge({
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
    });
    router = new CommandRouter({
      sessionStore: store,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      ordersPath: path.join(tmpDir, 'orders.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });
  });

  it('anchor_cmdStatus_shows_sessionCwd_when_different', () => {
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/worktree');
    const result = router.cmdStatus({ userId: 'u1' });
    expect(result.markdown).toContain('/main');
    expect(result.markdown).toContain('/worktree');
    expect(result.markdown).toContain('会话目录');
  });

  it('anchor_cmdStatus_single_line_when_same', () => {
    store.setCwd('u1', '/main');
    store.setSessionIdAndSessionCwd('u1', 'claude', 's1', '/main');
    const result = router.cmdStatus({ userId: 'u1' });
    expect(result.markdown).not.toContain('会话目录');
    expect(result.markdown).toContain('/main');
  });
});
