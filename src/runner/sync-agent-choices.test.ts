import { describe, it, expect } from 'vitest';
import type { AppConfig } from '../config/index.js';
import { syncAgentChoices } from './index.js';

describe('syncAgentChoices', () => {
  const baseConfig: AppConfig = {
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'claude-opus-4-8', effort: 'medium', stopGraceMs: 5000 },
    defaultAgent: 'codex',
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
    agents: { codex: { stopGraceMs: 5000 } },
  };

  it('should sync codex model and provider to agentChoices', () => {
    const config = {
      ...baseConfig,
      agents: { codex: { model: 'glm-5.2', modelProvider: 'volcengine-coding-plan' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'codex');

    expect(updated.agentChoices?.codex?.model).toBe('glm-5.2');
    expect(updated.agentChoices?.codex?.modelProvider).toBe('volcengine-coding-plan');
  });

  it('should sync pi config to agentChoices', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'pi',
      agents: { pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'pi');

    expect(updated.agentChoices?.pi?.model).toBe('glm-5.1');
    expect(updated.agentChoices?.pi?.provider).toBe('lt');
    expect(updated.agentChoices?.pi?.thinking).toBe('high');
  });

  it('should preserve existing choices for other agents', () => {
    const config = {
      ...baseConfig,
      agentChoices: {
        pi: { model: 'existing-pi-model', provider: 'existing-provider' },
      },
      agents: { codex: { model: 'new-codex-model' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'codex');

    // Pi choices should be preserved
    expect(updated.agentChoices?.pi?.model).toBe('existing-pi-model');
    // Codex should be added
    expect(updated.agentChoices?.codex?.model).toBe('new-codex-model');
  });

  it('should sync opencode modelID and providerID to agentChoices.opencode', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: { opencode: { modelID: 'sonnet', providerID: 'anthropic' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'opencode');

    expect(updated.agentChoices?.opencode?.modelID).toBe('sonnet');
    expect(updated.agentChoices?.opencode?.providerID).toBe('anthropic');
  });

  it('should sync kimi model and thinkingEffort to agentChoices.kimi', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { kimi: { model: 'moonshot-v1', thinkingEffort: 'high' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'kimi');

    expect(updated.agentChoices?.kimi?.model).toBe('moonshot-v1');
    expect(updated.agentChoices?.kimi?.thinkingEffort).toBe('high');
  });

  it('should return config unchanged when non-claude agent has no agentCfg', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: {},
    } as AppConfig;
    const updated = syncAgentChoices(config, 'opencode');

    expect(updated).toEqual(config);
  });

  it('should sync codex modelProvider only when model is absent', () => {
    const config = {
      ...baseConfig,
      agents: { codex: { modelProvider: 'volcengine-coding-plan' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'codex');

    expect(updated.agentChoices?.codex?.modelProvider).toBe('volcengine-coding-plan');
    expect(updated.agentChoices?.codex?.model).toBeUndefined();
  });

  it('should sync pi provider and thinking only when model is absent', () => {
    const config = {
      ...baseConfig,
      agents: { pi: { provider: 'lt', thinking: 'high' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'pi');

    expect(updated.agentChoices?.pi?.provider).toBe('lt');
    expect(updated.agentChoices?.pi?.thinking).toBe('high');
    expect(updated.agentChoices?.pi?.model).toBeUndefined();
  });

  it('should sync pi thinking only when model and provider are absent', () => {
    const config = {
      ...baseConfig,
      agents: { pi: { thinking: 'xhigh' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'pi');

    expect(updated.agentChoices?.pi?.thinking).toBe('xhigh');
    expect(updated.agentChoices?.pi?.model).toBeUndefined();
    expect(updated.agentChoices?.pi?.provider).toBeUndefined();
  });

  it('should sync opencode providerID only when modelID is absent', () => {
    const config = {
      ...baseConfig,
      agents: { opencode: { providerID: 'openrouter' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'opencode');

    expect(updated.agentChoices?.opencode?.providerID).toBe('openrouter');
    expect(updated.agentChoices?.opencode?.modelID).toBeUndefined();
  });

  it('should sync kimi thinkingEffort only when model is absent', () => {
    const config = {
      ...baseConfig,
      agents: { kimi: { thinkingEffort: 'max' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'kimi');

    expect(updated.agentChoices?.kimi?.thinkingEffort).toBe('max');
    expect(updated.agentChoices?.kimi?.model).toBeUndefined();
  });

  it('should handle claude agent (top-level config, no agents.claude)', () => {
    const config = { ...baseConfig } as AppConfig;
    const updated = syncAgentChoices(config, 'claude');

    // claude reads from top-level config.claude, not agents.claude
    // Should not error and should still return valid config
    expect(updated.claude).toBeDefined();
  });

  it('should create agentChoices object when it does not exist', () => {
    const config = {
      ...baseConfig,
      agents: { codex: { model: 'glm-5.2' } },
    } as AppConfig;
    // Ensure agentChoices is undefined
    delete (config as any).agentChoices;
    const updated = syncAgentChoices(config, 'codex');

    expect(updated.agentChoices).toBeDefined();
    expect(updated.agentChoices?.codex?.model).toBe('glm-5.2');
  });

  it('should not mutate the original config', () => {
    const config = {
      ...baseConfig,
      agents: { codex: { model: 'glm-5.2' } },
    } as AppConfig;
    const originalAgentChoices = config.agentChoices;
    syncAgentChoices(config, 'codex');

    expect(config.agentChoices).toBe(originalAgentChoices);
  });

  it('should handle codex when agentChoices.codex already exists', () => {
    const config = {
      ...baseConfig,
      agentChoices: { codex: { model: 'old-model' } },
      agents: { codex: { model: 'glm-5.2', modelProvider: 'volcengine' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'codex');

    expect(updated.agentChoices?.codex?.model).toBe('glm-5.2');
    expect(updated.agentChoices?.codex?.modelProvider).toBe('volcengine');
  });

  it('should handle pi when agentChoices.pi already exists', () => {
    const config = {
      ...baseConfig,
      agentChoices: { pi: { model: 'old-model' } },
      agents: { pi: { model: 'glm-5.1', provider: 'lt', thinking: 'high' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'pi');

    expect(updated.agentChoices?.pi?.model).toBe('glm-5.1');
    expect(updated.agentChoices?.pi?.provider).toBe('lt');
    expect(updated.agentChoices?.pi?.thinking).toBe('high');
  });

  it('should handle opencode when agentChoices.opencode already exists', () => {
    const config = {
      ...baseConfig,
      agentChoices: { opencode: { modelID: 'old-model' } },
      agents: { opencode: { modelID: 'sonnet', providerID: 'anthropic' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'opencode');

    expect(updated.agentChoices?.opencode?.modelID).toBe('sonnet');
    expect(updated.agentChoices?.opencode?.providerID).toBe('anthropic');
  });

  it('should handle kimi when agentChoices.kimi already exists', () => {
    const config = {
      ...baseConfig,
      agentChoices: { kimi: { model: 'old-model' } },
      agents: { kimi: { model: 'moonshot-v1', thinkingEffort: 'max' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'kimi');

    expect(updated.agentChoices?.kimi?.model).toBe('moonshot-v1');
    expect(updated.agentChoices?.kimi?.thinkingEffort).toBe('max');
  });

  it('should handle config without agents field (agents is undefined)', () => {
    const config = {
      ...baseConfig,
    } as AppConfig;
    // Remove agents entirely to test the agents || {} fallback
    delete (config as any).agents;
    // claude is the only agent that can work without agents config
    const updated = syncAgentChoices(config, 'claude');

    expect(updated.claude).toBeDefined();
  });

  it('should sync pi model and provider without thinking', () => {
    const config = {
      ...baseConfig,
      agents: { pi: { model: 'glm-5.1', provider: 'lt' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'pi');

    expect(updated.agentChoices?.pi?.model).toBe('glm-5.1');
    expect(updated.agentChoices?.pi?.provider).toBe('lt');
    expect(updated.agentChoices?.pi?.thinking).toBeUndefined();
  });

  it('should sync opencode modelID without providerID', () => {
    const config = {
      ...baseConfig,
      agents: { opencode: { modelID: 'sonnet' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'opencode');

    expect(updated.agentChoices?.opencode?.modelID).toBe('sonnet');
    expect(updated.agentChoices?.opencode?.providerID).toBeUndefined();
  });

  it('should sync kimi model without thinkingEffort', () => {
    const config = {
      ...baseConfig,
      agents: { kimi: { model: 'moonshot-v1' } },
    } as AppConfig;
    const updated = syncAgentChoices(config, 'kimi');

    expect(updated.agentChoices?.kimi?.model).toBe('moonshot-v1');
    expect(updated.agentChoices?.kimi?.thinkingEffort).toBeUndefined();
  });
});
