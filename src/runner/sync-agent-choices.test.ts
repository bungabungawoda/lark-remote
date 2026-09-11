import { describe, it, expect } from 'vitest';
import type { AppConfig } from '../config/index.js';
import { choiceFieldsFor } from './agent-choices-common.js';
import { syncAgentChoices } from './index.js';

/**
 * 表驱动测试：用例由 choiceFieldsFor 映射表（agent-choices-common.ts）生成，
 * 新增 agent/字段只需改映射表，这里自动覆盖。
 */
const AGENTS = ['codex', 'pi', 'opencode', 'kimi'] as const;

const baseConfig: AppConfig = {
  feishu: { appId: 'test', appSecret: 'test' },
  claude: { model: 'claude-opus-4-8', effort: 'medium', stopGraceMs: 5000 },
  defaultAgent: 'codex',
  idle: { watchdogMinutes: 15 },
  logging: { level: 'info' },
  agents: { codex: {} },
};

function agentCfg(agent: string, fields: Record<string, unknown>): AppConfig {
  return { ...baseConfig, agents: { [agent]: fields } } as unknown as AppConfig;
}

function choicesOf(updated: AppConfig, agent: string): Record<string, unknown> | undefined {
  return (updated.agentChoices as unknown as Record<string, Record<string, unknown>>)?.[agent];
}

describe('syncAgentChoices', () => {
  it.each(AGENTS)('syncs every agents.%s field into agentChoices.%s', (agent) => {
    const fields = choiceFieldsFor(agent)!;
    const cfgValues = Object.fromEntries(fields.map((f) => [f.configKey, `cfg-${f.configKey}`]));
    const updated = syncAgentChoices(agentCfg(agent, cfgValues), agent);

    for (const f of fields) {
      expect(choicesOf(updated, agent)?.[f.choicesKey]).toBe(`cfg-${f.configKey}`);
    }
  });

  it.each(AGENTS)('overwrites stale agentChoices.%s with the current agents config', (agent) => {
    const fields = choiceFieldsFor(agent)!;
    const cfgValues = Object.fromEntries(fields.map((f) => [f.configKey, `cfg-${f.configKey}`]));
    const config = {
      ...agentCfg(agent, cfgValues),
      agentChoices: { [agent]: Object.fromEntries(fields.map((f) => [f.choicesKey, 'old'])) },
    } as unknown as AppConfig;
    const updated = syncAgentChoices(config, agent);

    for (const f of fields) {
      expect(choicesOf(updated, agent)?.[f.choicesKey]).toBe(`cfg-${f.configKey}`);
    }
  });

  // 部分配置：单字段存在时只同步该字段，缺失字段不得虚构
  for (const agent of AGENTS) {
    for (const field of choiceFieldsFor(agent)!) {
      it(`syncs ${agent} ${field.configKey} alone (missing siblings stay undefined)`, () => {
        const updated = syncAgentChoices(
          agentCfg(agent, { [field.configKey]: `cfg-${field.configKey}` }),
          agent,
        );

        expect(choicesOf(updated, agent)?.[field.choicesKey]).toBe(`cfg-${field.configKey}`);
        for (const f of choiceFieldsFor(agent)!) {
          if (f.configKey !== field.configKey) {
            expect(choicesOf(updated, agent)?.[f.choicesKey]).toBeUndefined();
          }
        }
      });
    }
  }

  it('preserves existing choices for other agents', () => {
    const config = {
      ...agentCfg('codex', { model: 'new-codex-model' }),
      agentChoices: { pi: { model: 'existing-pi-model', provider: 'existing-provider' } },
    } as unknown as AppConfig;
    const updated = syncAgentChoices(config, 'codex');

    expect(choicesOf(updated, 'pi')?.model).toBe('existing-pi-model');
    expect(choicesOf(updated, 'codex')?.model).toBe('new-codex-model');
  });

  it('returns config unchanged when a non-claude agent has no agents sub-key', () => {
    const config = { ...baseConfig, agents: {} } as AppConfig;
    const updated = syncAgentChoices(config, 'opencode');
    expect(updated).toEqual(config);
  });

  it('handles claude agent (top-level config, not synced through agents)', () => {
    const config = { ...baseConfig } as AppConfig;
    const updated = syncAgentChoices(config, 'claude');
    expect(updated.claude).toBeDefined();
  });

  it('handles config without agents field (agents is undefined)', () => {
    const config = { ...baseConfig } as AppConfig;
    delete (config as Partial<AppConfig>).agents;
    const updated = syncAgentChoices(config, 'claude');
    expect(updated.claude).toBeDefined();
  });

  it('creates the agentChoices object when it does not exist', () => {
    const config = agentCfg('kimi', { model: 'moonshot-v1' });
    delete (config as Partial<AppConfig>).agentChoices;
    const updated = syncAgentChoices(config, 'kimi');

    expect(updated.agentChoices).toBeDefined();
    expect(choicesOf(updated, 'kimi')?.model).toBe('moonshot-v1');
  });

  it('does not mutate the original config', () => {
    const config = agentCfg('codex', { model: 'glm-5.2' });
    const originalAgentChoices = config.agentChoices;
    syncAgentChoices(config, 'codex');

    expect(config.agentChoices).toBe(originalAgentChoices);
  });
});
