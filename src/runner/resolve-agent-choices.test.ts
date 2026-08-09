import { describe, it, expect } from 'vitest';
import { resolveAgentChoices } from '../runner/index.js';
import type { AppConfig } from '../config/index.js';

describe('resolveAgentChoices', () => {
  const baseConfig: AppConfig = {
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { binary: 'claude', model: 'claude-opus-4-8', effort: 'medium', stopGraceMs: 5000 },
    defaultAgent: 'codex',
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
    agentChoices: {
      codex: { model: 'glm-5.2', modelProvider: 'volcengine-coding-plan' },
      pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' },
    },
  };

  it('should merge codex choices into agents config', () => {
    // 部分 agents 配置是故意的：缺 model 时由 agentChoices 补齐（运行时语义）。
    const config = { ...baseConfig, agents: { codex: { binary: 'codex' } } } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.codex?.model).toBe('glm-5.2');
    expect(resolved.agents?.codex?.modelProvider).toBe('volcengine-coding-plan');
    // Explicit config should be preserved
    expect(resolved.agents?.codex?.binary).toBe('codex');
  });

  it('should use choices when agents config is empty', () => {
    const config = { ...baseConfig, agents: {} };
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.codex?.model).toBe('glm-5.2');
    expect(resolved.agents?.codex?.modelProvider).toBe('volcengine-coding-plan');
  });

  it('should use pi choices when switching to pi', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { binary: 'pi' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.pi?.model).toBe('glm-5.1');
    expect(resolved.agents?.pi?.provider).toBe('lt');
    expect(resolved.agents?.pi?.thinking).toBe('high');
  });

  it('should return original config when no choices exist', () => {
    const config = { ...baseConfig, agentChoices: undefined };
    const resolved = resolveAgentChoices(config);

    expect(resolved).toEqual(config);
  });

  it('should not overwrite explicit agent config with choices', () => {
    const config = {
      ...baseConfig,
      agents: { codex: { model: 'custom-model', modelProvider: 'custom-provider' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    // Explicit config should take priority
    expect(resolved.agents?.codex?.model).toBe('custom-model');
    expect(resolved.agents?.codex?.modelProvider).toBe('custom-provider');
  });

  it('should merge opencode choices with modelID and providerID into agents.opencode', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agentChoices: {
        opencode: { modelID: 'sonnet', providerID: 'anthropic' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.opencode?.modelID).toBe('sonnet');
    expect(resolved.agents?.opencode?.providerID).toBe('anthropic');
  });

  it('should merge kimi choices with model and thinkingEffort into agents.kimi', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agentChoices: {
        kimi: { model: 'moonshot-v1', thinkingEffort: 'high' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.kimi?.model).toBe('moonshot-v1');
    expect(resolved.agents?.kimi?.thinkingEffort).toBe('high');
  });

  it('should return config unchanged when agent is claude (early return)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'claude',
      agentChoices: {
        codex: { model: 'glm-5.2', modelProvider: 'volcengine-coding-plan' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved).toEqual(config);
  });

  it('should return original config when agentChoices has no entry for current agent', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agentChoices: {
        codex: { model: 'glm-5.2', modelProvider: 'volcengine-coding-plan' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved).toEqual(config);
  });

  it('should return original config when defaultAgent is undefined', () => {
    const config = {
      ...baseConfig,
      defaultAgent: undefined as unknown as AppConfig['defaultAgent'],
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved).toEqual(config);
  });

  it('should not overwrite existing codex agents config fields with choices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agents: { codex: { model: 'existing-model' } },
      agentChoices: {
        codex: { model: 'choices-model', modelProvider: 'choices-provider' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    // existing model should be preserved, modelProvider from choices should be applied
    expect(resolved.agents?.codex?.model).toBe('existing-model');
    expect(resolved.agents?.codex?.modelProvider).toBe('choices-provider');
  });

  it('should not overwrite existing pi agents config fields with choices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { model: 'existing-model' } },
      agentChoices: {
        pi: { model: 'choices-model', provider: 'choices-provider', thinking: 'high' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.pi?.model).toBe('existing-model');
    expect(resolved.agents?.pi?.provider).toBe('choices-provider');
    expect(resolved.agents?.pi?.thinking).toBe('high');
  });

  it('should not overwrite existing opencode agents config fields with choices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: { opencode: { modelID: 'existing-model-id' } },
      agentChoices: {
        opencode: { modelID: 'choices-model-id', providerID: 'choices-provider-id' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.opencode?.modelID).toBe('existing-model-id');
    expect(resolved.agents?.opencode?.providerID).toBe('choices-provider-id');
  });

  it('should not overwrite existing kimi agents config fields with choices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { kimi: { model: 'existing-model' } },
      agentChoices: {
        kimi: { model: 'choices-model', thinkingEffort: 'high' },
      },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.kimi?.model).toBe('existing-model');
    expect(resolved.agents?.kimi?.thinkingEffort).toBe('high');
  });

  it('should not mutate the original config', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agents: {},
    } as AppConfig;
    const originalAgents = config.agents;
    resolveAgentChoices(config);

    expect(config.agents).toBe(originalAgents);
    expect(config.agents?.codex).toBeUndefined();
  });

  it('should handle codex with partial agentChoices (model only, no modelProvider)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agents: { codex: { binary: 'codex' } },
      agentChoices: { codex: { model: 'glm-5.2' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.codex?.model).toBe('glm-5.2');
    expect(resolved.agents?.codex?.modelProvider).toBeUndefined();
  });

  it('should handle codex with partial agentChoices (modelProvider only, no model)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agents: { codex: { binary: 'codex' } },
      agentChoices: { codex: { modelProvider: 'volcengine' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.codex?.model).toBeUndefined();
    expect(resolved.agents?.codex?.modelProvider).toBe('volcengine');
  });

  it('should handle pi with partial agentChoices (model only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { binary: 'pi' } },
      agentChoices: { pi: { model: 'glm-5.1' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.pi?.model).toBe('glm-5.1');
    expect(resolved.agents?.pi?.provider).toBeUndefined();
    expect(resolved.agents?.pi?.thinking).toBeUndefined();
  });

  it('should handle pi with partial agentChoices (provider only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { binary: 'pi' } },
      agentChoices: { pi: { provider: 'anthropic' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.pi?.model).toBeUndefined();
    expect(resolved.agents?.pi?.provider).toBe('anthropic');
    expect(resolved.agents?.pi?.thinking).toBeUndefined();
  });

  it('should handle pi with partial agentChoices (thinking only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { binary: 'pi' } },
      agentChoices: { pi: { thinking: 'high' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.pi?.model).toBeUndefined();
    expect(resolved.agents?.pi?.provider).toBeUndefined();
    expect(resolved.agents?.pi?.thinking).toBe('high');
  });

  it('should handle opencode with partial agentChoices (modelID only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: { opencode: { binary: 'opencode' } },
      agentChoices: { opencode: { modelID: 'sonnet' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.opencode?.modelID).toBe('sonnet');
    expect(resolved.agents?.opencode?.providerID).toBeUndefined();
  });

  it('should handle opencode with partial agentChoices (providerID only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: { opencode: { binary: 'opencode' } },
      agentChoices: { opencode: { providerID: 'anthropic' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.opencode?.modelID).toBeUndefined();
    expect(resolved.agents?.opencode?.providerID).toBe('anthropic');
  });

  it('should handle kimi with partial agentChoices (model only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { kimi: { binary: 'kimi' } },
      agentChoices: { kimi: { model: 'moonshot-v1' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.kimi?.model).toBe('moonshot-v1');
    expect(resolved.agents?.kimi?.thinkingEffort).toBeUndefined();
  });

  it('should handle kimi with partial agentChoices (thinkingEffort only)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { kimi: { binary: 'kimi' } },
      agentChoices: { kimi: { thinkingEffort: 'max' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.kimi?.model).toBeUndefined();
    expect(resolved.agents?.kimi?.thinkingEffort).toBe('max');
  });

  it('should handle codex agent with agents set but no codex sub-key and empty choices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agents: { pi: { binary: 'pi' } },
      agentChoices: { codex: {} },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    // codex sub-key should be created, no fields copied from empty choices
    expect(resolved.agents?.codex).toBeDefined();
    expect(resolved.agents?.codex?.model).toBeUndefined();
    expect(resolved.agents?.codex?.modelProvider).toBeUndefined();
  });

  it('should handle pi agent with agents set but no pi sub-key and partial choices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { codex: { binary: 'codex' } },
      agentChoices: { pi: { model: 'glm-5.1' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.pi).toBeDefined();
    expect(resolved.agents?.pi?.model).toBe('glm-5.1');
    expect(resolved.agents?.pi?.provider).toBeUndefined();
    expect(resolved.agents?.pi?.thinking).toBeUndefined();
  });

  it('should handle pi agent with agents.pi existing and choices missing some fields', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { binary: 'pi', model: 'existing' } },
      agentChoices: { pi: { provider: 'lt' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    // model already set in agents, should not be overwritten
    expect(resolved.agents?.pi?.model).toBe('existing');
    // provider from choices should be applied
    expect(resolved.agents?.pi?.provider).toBe('lt');
    // thinking absent in both, should remain undefined
    expect(resolved.agents?.pi?.thinking).toBeUndefined();
  });

  it('should handle opencode agent with agents.opencode existing and choices missing some fields', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: { opencode: { binary: 'opencode', modelID: 'existing' } },
      agentChoices: { opencode: { providerID: 'anthropic' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.opencode?.modelID).toBe('existing');
    expect(resolved.agents?.opencode?.providerID).toBe('anthropic');
  });

  it('should handle kimi agent with agents.kimi existing and choices missing some fields', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { kimi: { binary: 'kimi', model: 'existing' } },
      agentChoices: { kimi: { thinkingEffort: 'max' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents?.kimi?.model).toBe('existing');
    expect(resolved.agents?.kimi?.thinkingEffort).toBe('max');
  });

  it('should handle agents without the specific agent sub-key', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { codex: { binary: 'codex' } },
      agentChoices: { kimi: { model: 'moonshot' } },
    } as AppConfig;
    const resolved = resolveAgentChoices(config);

    // agents.kimi should be created
    expect(resolved.agents?.kimi).toBeDefined();
    expect(resolved.agents?.kimi?.model).toBe('moonshot');
    // codex should be preserved
    expect(resolved.agents?.codex?.binary).toBe('codex');
  });

  it('should create agents object for codex when agents is undefined', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agentChoices: { codex: { model: 'glm-5.2' } },
    } as AppConfig;
    // Remove agents entirely
    delete (config as any).agents;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents).toBeDefined();
    expect(resolved.agents?.codex?.model).toBe('glm-5.2');
  });

  it('should create agents object for pi when agents is undefined', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agentChoices: { pi: { model: 'glm-5.1' } },
    } as AppConfig;
    delete (config as any).agents;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents).toBeDefined();
    expect(resolved.agents?.pi?.model).toBe('glm-5.1');
  });
});
