import { describe, it, expect } from 'vitest';
import { resolveAgentChoices } from '../runner/index.js';
import { choiceFieldsFor, AGENT_CHOICE_FIELDS } from './agent-choices-common.js';
import type { AppConfig } from '../config/index.js';

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
};

function configFor(
  agent: string,
  opts: { choices?: Record<string, unknown>; agents?: Record<string, unknown> } = {},
): AppConfig {
  return {
    ...baseConfig,
    defaultAgent: agent,
    ...(opts.choices ? { agentChoices: { [agent]: opts.choices } } : {}),
    ...(opts.agents ? { agents: { [agent]: opts.agents } } : {}),
  } as unknown as AppConfig;
}

function agentSlot(resolved: AppConfig, agent: string): Record<string, unknown> | undefined {
  return (resolved.agents as unknown as Record<string, Record<string, unknown>>)?.[agent];
}

describe('resolveAgentChoices', () => {
  // 字面量快照：本文件的表驱动用例以 choiceFieldsFor 为 oracle（与生产同源），
  // 这条断言用逐字段字面量钉住整张映射表，防止表被误改时测试自我适配。
  it('pins the AGENT_CHOICE_FIELDS mapping table (literal snapshot)', () => {
    expect(AGENT_CHOICE_FIELDS).toEqual({
      codex: [
        { configKey: 'model', choicesKey: 'model' },
        { configKey: 'modelProvider', choicesKey: 'modelProvider' },
      ],
      pi: [
        { configKey: 'model', choicesKey: 'model' },
        { configKey: 'provider', choicesKey: 'provider' },
        { configKey: 'thinking', choicesKey: 'thinking' },
      ],
      opencode: [
        { configKey: 'modelID', choicesKey: 'modelID' },
        { configKey: 'providerID', choicesKey: 'providerID' },
      ],
      kimi: [
        { configKey: 'model', choicesKey: 'model' },
        { configKey: 'thinkingEffort', choicesKey: 'thinkingEffort' },
      ],
      dsh: [],
    });
  });

  it.each(AGENTS)(
    'merges every choices field into agents.%s when the agents slot is empty',
    (agent) => {
      const fields = choiceFieldsFor(agent)!;
      const choices = Object.fromEntries(
        fields.map((f) => [f.choicesKey, `choices-${f.choicesKey}`]),
      );
      const resolved = resolveAgentChoices(configFor(agent, { choices }));

      expect(agentSlot(resolved, agent)).toBeDefined();
      for (const f of fields) {
        expect(agentSlot(resolved, agent)?.[f.configKey]).toBe(`choices-${f.choicesKey}`);
      }
    },
  );

  it.each(AGENTS)('does not overwrite explicit agents.%s config with choices', (agent) => {
    const fields = choiceFieldsFor(agent)!;
    const choices = Object.fromEntries(
      fields.map((f) => [f.choicesKey, `choices-${f.choicesKey}`]),
    );
    const agents = Object.fromEntries(fields.map((f) => [f.configKey, `existing-${f.configKey}`]));
    const resolved = resolveAgentChoices(configFor(agent, { choices, agents }));

    for (const f of fields) {
      expect(agentSlot(resolved, agent)?.[f.configKey]).toBe(`existing-${f.configKey}`);
    }
  });

  // 部分 choices：单字段存在时只应用该字段，其余字段不得虚构
  for (const agent of AGENTS) {
    for (const field of choiceFieldsFor(agent)!) {
      it(`handles ${agent} with partial agentChoices (${field.choicesKey} only)`, () => {
        const resolved = resolveAgentChoices(
          configFor(agent, { choices: { [field.choicesKey]: `choices-${field.choicesKey}` } }),
        );

        expect(agentSlot(resolved, agent)?.[field.configKey]).toBe(`choices-${field.choicesKey}`);
        for (const f of choiceFieldsFor(agent)!) {
          if (f.configKey !== field.configKey) {
            expect(agentSlot(resolved, agent)?.[f.configKey]).toBeUndefined();
          }
        }
      });
    }
  }

  it('returns config unchanged when agentChoices is absent', () => {
    const config = { ...baseConfig } as AppConfig;
    expect(resolveAgentChoices(config)).toEqual(config);
  });

  it('returns config unchanged when agent is claude (top-level config, early return)', () => {
    const config = configFor('claude', {
      choices: Object.fromEntries(
        choiceFieldsFor('codex')!.map((f) => [f.choicesKey, `choices-${f.choicesKey}`]),
      ),
    });
    // choices 挂在 claude 槽位（configFor 按传入 agent 落键）也不该被消费
    const withClaudeChoices = {
      ...config,
      defaultAgent: 'claude',
    } as AppConfig;
    expect(resolveAgentChoices(withClaudeChoices)).toEqual(withClaudeChoices);
  });

  it('returns config unchanged when agentChoices has no entry for the current agent', () => {
    const config = {
      ...configFor('opencode', {
        choices: { modelID: 'sonnet' },
      }),
      agentChoices: { codex: { model: 'glm-5.2' } },
    } as unknown as AppConfig;
    expect(resolveAgentChoices(config)).toEqual(config);
  });

  it('returns config unchanged when defaultAgent is undefined', () => {
    const config = { ...baseConfig, defaultAgent: undefined } as unknown as AppConfig;
    expect(resolveAgentChoices(config)).toEqual(config);
  });

  it('returns config unchanged for dsh (choices 恒为空：host 是连接配置而非 per-run choice)', () => {
    const config = { ...baseConfig, defaultAgent: 'dsh' } as unknown as AppConfig;
    expect(resolveAgentChoices(config)).toEqual(config);
  });

  // 混合场景：部分字段显式配置、部分来自 choices —— 逐字段回退语义
  it.each(AGENTS)(
    'fills only the missing agents.%s fields from choices (mixed explicit/partial)',
    (agent) => {
      const fields = choiceFieldsFor(agent)!;
      const explicit = fields.slice(0, 1).map((f) => f.configKey);
      const agents = Object.fromEntries(explicit.map((k) => [k, `existing-${k}`]));
      const choices = Object.fromEntries(
        fields.map((f) => [f.choicesKey, `choices-${f.choicesKey}`]),
      );
      const resolved = resolveAgentChoices(configFor(agent, { choices, agents }));

      for (const f of fields) {
        const expected = explicit.includes(f.configKey)
          ? `existing-${f.configKey}`
          : `choices-${f.choicesKey}`;
        expect(agentSlot(resolved, agent)?.[f.configKey]).toBe(expected);
      }
    },
  );

  it('does not mutate the original config', () => {
    const config = configFor('codex', { choices: { model: 'glm-5.2' } });
    const originalAgents = config.agents;
    resolveAgentChoices(config);

    expect(config.agents).toBe(originalAgents);
  });

  it('creates the agents object when agents is undefined', () => {
    const config = configFor('pi', { choices: { model: 'glm-5.1' } });
    delete (config as Partial<AppConfig>).agents;
    const resolved = resolveAgentChoices(config);

    expect(resolved.agents).toBeDefined();
    expect(agentSlot(resolved, 'pi')?.model).toBe('glm-5.1');
  });

  it('creates the agent sub-key when agents exists without it (partial choices)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'kimi',
      agents: { codex: {} },
      agentChoices: { kimi: { model: 'moonshot' } },
    } as unknown as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(agentSlot(resolved, 'kimi')).toBeDefined();
    expect(agentSlot(resolved, 'kimi')?.model).toBe('moonshot');
  });

  it('creates an empty agent slot when agents exists without the sub-key and choices is {}', () => {
    // 空 choices 对象 `{}` 是 truthy，不会被 `if (!agentChoices) return` 拦下，
    // 仍走 resolve-agent-choices.ts 的 `[agent] ??= {}` 补槽位路径：
    // 槽位被创建但不虚构任何字段。
    const config = {
      ...baseConfig,
      defaultAgent: 'codex',
      agents: { pi: { model: 'glm-5.2' } },
      agentChoices: { codex: {} },
    } as unknown as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(agentSlot(resolved, 'codex')).toEqual({});
  });

  it('mixes existing agents fields with missing choices fields (per-field fallback)', () => {
    const config = {
      ...baseConfig,
      defaultAgent: 'opencode',
      agents: { opencode: { modelID: 'existing' } },
      agentChoices: { opencode: { providerID: 'anthropic' } },
    } as unknown as AppConfig;
    const resolved = resolveAgentChoices(config);

    expect(agentSlot(resolved, 'opencode')?.modelID).toBe('existing');
    expect(agentSlot(resolved, 'opencode')?.providerID).toBe('anthropic');
  });
});
