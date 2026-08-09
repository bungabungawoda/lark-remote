import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';

// 创建一个 mock runner，包含 getStatusInfo
function createMockRunner(kind: string) {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {},
    kind,
    sessionReader: {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: () => ({ events: [] }),
      isSessionActive: () => false,
    },
    getStatusInfo: () => ({ kind: kind as string, model: `${kind}-model` }),
  };
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-clear-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'codex',
    agents: { codex: { binary: 'codex' } },
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
});

describe('Bridge clearRunners on config change', () => {
  it('should clear runners when defaultAgent changes', () => {
    const connector = {
      sendWithRetry: async () => 'msg-id',
      sendFile: async () => 'file-msg-id',
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: async () => 'msg-id',
      updateCard: async () => {},
      connected: true,
    };

    const sessionStore = new SessionStore();
    const codexRunner = createMockRunner('codex');
    const piRunner = createMockRunner('pi');

    const getRunnerCalls: string[] = [];

    // Mock agent registry
    const mockRegistry = {
      get: (kind: string) => {
        getRunnerCalls.push(kind);
        return kind === 'codex' ? codexRunner : piRunner;
      },
      isRegistered: () => true,
      listRegistered: () => ['claude', 'codex', 'pi'],
      setConfigContainer: () => {},
      getConfigContainer: () => undefined,
    };

    // 创建 bridge
    const bridge = new Bridge({
      runner: createMockRunner('claude') as any,
      connector,
      sessionStore,
      config,
      agentRegistry: mockRegistry as any,
    });

    // 首次获取 runner
    sessionStore.setCwd('user1', tmpDir);
    const runner1 = bridge.getCurrentRunner(tmpDir);
    expect(runner1.getStatusInfo().kind).toBe('codex');

    // 修改 config，将 defaultAgent 改为 pi
    const newConfig = { ...config, defaultAgent: 'pi' as const };
    bridge.setConfig(newConfig);

    // 手动清除缓存（模拟 config.save 中的行为）
    bridge.clearRunners();

    // 再次获取 runner，应该得到新的 pi runner
    const runner2 = bridge.getCurrentRunner(tmpDir);
    expect(runner2.getStatusInfo().kind).toBe('pi');
  });
});
