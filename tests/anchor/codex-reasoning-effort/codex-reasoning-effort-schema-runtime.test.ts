/**
 * CodexConfigSchema reasoningEffort 校验 + Bridge 运行时透传。
 *
 * 合并自 codex-reasoning-effort-schema / codex-reasoning-effort-runtime。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema, CodexConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubSessionReaderRegistry,
} from '../../../tests/lib/bridge-stubs.js';

describe('CodexConfigSchema reasoningEffort', () => {
  it('test_anchor_codex_config_schema_has_reasoning_effort', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      stopGraceMs: 5000,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reasoningEffort).toBe('high');
  });

  it('test_anchor_codex_config_schema_reasoning_effort_optional', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      stopGraceMs: 5000,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reasoningEffort).toBeUndefined();
  });

  it('test_anchor_codex_config_schema_reasoning_effort_accepts_valid_values', () => {
    for (const value of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const result = CodexConfigSchema.safeParse({
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: value,
        stopGraceMs: 5000,
      });
      expect(result.success, `Failed for value: ${value}`).toBe(true);
      if (result.success) expect(result.data.reasoningEffort).toBe(value);
    }
  });

  it('test_anchor_codex_reasoningEffort_accepts_valid_values', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const result = CodexConfigSchema.safeParse({
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: effort,
      });
      expect(result.success, `effort="${effort}" should be valid`).toBe(true);
    }
  });

  it('test_anchor_codex_reasoningEffort_optional', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
    });
    expect(result.success).toBe(true);
  });

  it('test_anchor_codex_reasoningEffort_accepts_custom_value', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'super-extreme',
    });
    expect(result.success).toBe(true);
  });
});

describe('reasoningEffort runtime propagation', () => {
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
      logging: { level: 'info' },
    });
  });

  function makeBridge(config: AppConfig): Bridge {
    const sessionStore = new SessionStore();
    const stubRunner = {
      isRunning: false,
      stop: async () => {},
      killOrphan: () => {},
      registerExitHandlers: () => {},
      run: async function* () {},
    };
    return new Bridge({
      config,
      connector: createStubConnector(),
      sessionStore,
      agentRegistry: createStubAgentRegistry(stubRunner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
  }

  it('test_anchor_getAgentRunOptions_extracts_codex_reasoningEffort', () => {
    const bridge = makeBridge(baseConfig);
    expect(bridge.getAgentRunOptions().reasoningEffort).toBe('high');
  });

  it('test_anchor_getAgentRunOptions_reflects_runtime_reasoningEffort_change', () => {
    const bridge = makeBridge(baseConfig);
    expect(bridge.getAgentRunOptions().reasoningEffort).toBe('high');

    bridge.setConfig({
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        codex: {
          ...baseConfig.agents!.codex!,
          reasoningEffort: 'xhigh',
        },
      },
    });

    expect(bridge.getAgentRunOptions().reasoningEffort).toBe('xhigh');
  });
});
