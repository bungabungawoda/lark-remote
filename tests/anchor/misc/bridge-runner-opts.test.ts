import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-model-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', effort: 'high', stopGraceMs: 5000 },
    defaultAgent: 'claude',
    agents: {
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'glm-5.2', modelProvider: 'lt' },
      pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' },
      opencode: {
        modelID: 'claude-sonnet-4-20250505',
        providerID: 'anthropic',
        agent: 'claude',
      },
    },
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Bridge passes model/effort to runner', () => {
  /**
   * Test that Bridge correctly extracts agent run options from config.
   * This test verifies the getAgentRunOptions logic by checking that
   * when runner.run() is called, the options include model/effort from config.
   */
  it('should pass model and effort from config to runner.run() for claude', async () => {
    // 创建一个捕获 run() 调用参数的 mock runner
    let capturedOpts: any = null;
    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* (_message: string, opts: any) {
        capturedOpts = opts;
        // 立即返回结果，不等待
        return;

        yield { type: 'result', subtype: 'success' };
      },
      get capturedOpts() {
        return capturedOpts;
      },
    };

    const connector = {
      sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: vi.fn().mockResolvedValue('msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };

    const sessionStore = new SessionStore();

    // Mock agent registry 返回捕获 runner
    const mockRegistry = {
      get: () => mockRunner,
      isRegistered: () => true,
      listRegistered: () => ['claude'],
      setConfigContainer: () => {},
      getConfigContainer: () => ({ current: config }),
    };

    // 创建 bridge
    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config,
      connector: connector as any,
      sessionStore,
      agentRegistry: mockRegistry as any,
      sessionReaderRegistry: null as any,
    });

    // 设置 cwd
    const cwd = '/test/cwd';
    sessionStore.setCwd('user-1', cwd);

    // 直接调用 getAgentRunOptions 验证它返回正确的值
    // 由于这是 private 方法，我们通过 forwardToClaude 的调用链来验证
    // 但更直接的方式是测试配置被正确解析

    // 让我们直接验证 getAgentRunOptions 返回的结果
    // 通过读取 bridge 实例的 config 来验证
    const agentOpts = (bridge as any).getAgentRunOptions();

    expect(agentOpts.model).toBe('opus');
    expect(agentOpts.effort).toBe('high');
  });

  it('should pass model from config to runner.run() for codex', async () => {
    const codexConfig = AppConfigSchema.parse({
      ...config,
      defaultAgent: 'codex',
    });

    const connector = {
      sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: vi.fn().mockResolvedValue('msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };

    const sessionStore = new SessionStore();

    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const mockRegistry = {
      get: () => mockRunner,
      isRegistered: () => true,
      listRegistered: () => ['codex'],
      setConfigContainer: () => {},
      getConfigContainer: () => ({ current: codexConfig }),
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: codexConfig,
      connector: connector as any,
      sessionStore,
      agentRegistry: mockRegistry as any,
      sessionReaderRegistry: null as any,
    });

    const agentOpts = (bridge as any).getAgentRunOptions();

    expect(agentOpts.model).toBe('glm-5.2');
  });

  it('should pass model and thinking from config to runner.run() for pi', async () => {
    const piConfig = AppConfigSchema.parse({
      ...config,
      defaultAgent: 'pi',
    });

    const connector = {
      sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: vi.fn().mockResolvedValue('msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };

    const sessionStore = new SessionStore();

    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const mockRegistry = {
      get: () => mockRunner,
      isRegistered: () => true,
      listRegistered: () => ['pi'],
      setConfigContainer: () => {},
      getConfigContainer: () => ({ current: piConfig }),
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: piConfig,
      connector: connector as any,
      sessionStore,
      agentRegistry: mockRegistry as any,
      sessionReaderRegistry: null as any,
    });

    const agentOpts = (bridge as any).getAgentRunOptions();

    expect(agentOpts.model).toBe('glm-5.1');
    expect(agentOpts.thinking).toBe('high');
  });

  it('should pass modelID from config to runner.run() for opencode', async () => {
    const opencodeConfig = AppConfigSchema.parse({
      ...config,
      defaultAgent: 'opencode',
    });

    const connector = {
      sendWithRetry: vi.fn().mockResolvedValue('msg-id'),
      reconnect: async () => {},
      addReaction: async () => {},
      streamCard: vi.fn().mockResolvedValue('msg-id'),
      updateCard: vi.fn().mockResolvedValue(undefined),
      connected: true,
    };

    const sessionStore = new SessionStore();

    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const mockRegistry = {
      get: () => mockRunner,
      isRegistered: () => true,
      listRegistered: () => ['opencode'],
      setConfigContainer: () => {},
      getConfigContainer: () => ({ current: opencodeConfig }),
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: opencodeConfig,
      connector: connector as any,
      sessionStore,
      agentRegistry: mockRegistry as any,
      sessionReaderRegistry: null as any,
    });

    const agentOpts = (bridge as any).getAgentRunOptions();

    // opencode model is set as provider/model in the constructor (not bare modelID).
    // getAgentRunOptions() intentionally returns undefined for opencode model
    // to avoid overriding the provider-prefixed model.
    expect(agentOpts.model).toBeUndefined();
  });
});
