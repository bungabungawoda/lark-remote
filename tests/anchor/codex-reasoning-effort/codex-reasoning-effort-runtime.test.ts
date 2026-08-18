import { describe, it, expect, beforeEach } from 'vitest';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubSessionReaderRegistry,
} from '../../../tests/lib/bridge-stubs.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';

/**
 * Red Agent - Round 1 - Anchor (Bug 模式)
 *
 * Target: reasoningEffort 运行时修改必须生效——
 *   1. Bridge.getAgentRunOptions() 必须为 codex 提取 reasoningEffort
 *   2. CodexAppServerRunner 必须使用 per-run opts.reasoningEffort（优先于 constructor 值）
 *
 * Importance: 用户在 /config 卡片修改"推理强度"后，若不生效则功能完全失效。
 *   根因：getAgentRunOptions 不提取 reasoningEffort + runner 只读 constructor 字段。
 *
 * Spec basis: design.md "Codex 推理强度配置" — "存储在 agents.codex.reasoningEffort"
 *   + router config.set 切换模型时自动重置 reasoningEffort 的逻辑依赖运行时生效。
 *
 * Pyramid: L1 (unit) — 验证 getAgentRunOptions 返回值 + runner 参数传递
 */

let baseConfig: AppConfig;

beforeEach(() => {
  baseConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    defaultAgent: 'codex',
    agents: {
      codex: {
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: 'high',
      },
    },
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
  });
});

describe('P1: reasoningEffort runtime propagation', () => {
  /**
   * 验证 Bridge.getAgentRunOptions() 为 codex 提取 reasoningEffort。
   * 缺失/错误：用户改推理强度后 bridge 不传新值，runner 用旧值。
   */
  it('test_anchor_getAgentRunOptions_extracts_codex_reasoningEffort', () => {
    const sessionStore = new SessionStore();
    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: baseConfig,
      connector: createStubConnector(),
      sessionStore,
      agentRegistry: createStubAgentRegistry(mockRunner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    const agentOpts = bridge.getAgentRunOptions();

    // 当前 getAgentRunOptions 的 codex case 不提取 reasoningEffort
    expect(agentOpts.reasoningEffort).toBe('high');
  });

  /**
   * 验证运行时修改 reasoningEffort 后 getAgentRunOptions 返回新值。
   * 缺失/错误：setConfig 后仍返回旧值 → 功能失效。
   */
  it('test_anchor_getAgentRunOptions_reflects_runtime_reasoningEffort_change', () => {
    const sessionStore = new SessionStore();
    const mockRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };

    const bridge = new Bridge({
      runner: {
        isRunning: false,
        run: async function* () {},
        stop: async () => {},
        killOrphan: () => {},
        registerExitHandlers: () => {},
      },
      config: baseConfig,
      connector: createStubConnector(),
      sessionStore,
      agentRegistry: createStubAgentRegistry(mockRunner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    // 初始值
    let agentOpts = bridge.getAgentRunOptions();
    expect(agentOpts.reasoningEffort).toBe('high');

    // 模拟 /config 卡片修改 reasoningEffort → setConfig
    const updatedConfig: AppConfig = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        codex: {
          ...baseConfig.agents!.codex!,
          reasoningEffort: 'xhigh',
        },
      },
    };
    bridge.setConfig(updatedConfig);

    agentOpts = bridge.getAgentRunOptions();
    // setConfig 后应返回新值 'xhigh'
    expect(agentOpts.reasoningEffort).toBe('xhigh');
  });
});
