import { describe, it, expect, afterEach } from 'vitest';
import { agentDisplayName } from './card-shared.js';
import { AgentRegistry } from '../runner/registry.js';
import { AGENT_DISPLAY_NAMES, AGENT_KINDS } from '../runner/types.js';

/**
 * 用户可见 agent 显示名的单源验证（P0）：
 * - `AGENT_DISPLAY_NAMES` 是启动注册与无 registry 回退路径的共同数据源；
 * - dsh 接入后显示名必须是 `DSH`，不得退化成原始 kind 或 `Dsh`；
 * - 注册了 registry 时以注册值为准，未注册的 kind 回退原始字符串。
 */
describe('agentDisplayName', () => {
  afterEach(() => {
    AgentRegistry.setGlobalInstance(undefined);
  });

  it('uses the single-source display name for dsh (DSH)', () => {
    AgentRegistry.setGlobalInstance(undefined);
    expect(AGENT_DISPLAY_NAMES.dsh).toBe('DSH');
    expect(agentDisplayName('dsh')).toBe('DSH');
  });

  it('every agent kind has a non-empty display name', () => {
    for (const kind of AGENT_KINDS) {
      expect(AGENT_DISPLAY_NAMES[kind], kind).toBeTruthy();
    }
  });

  it('falls back to the raw kind for unknown values', () => {
    AgentRegistry.setGlobalInstance(undefined);
    expect(agentDisplayName('mystery')).toBe('mystery');
  });

  it('prefers the registered display name when a global registry is set', () => {
    const registry = new AgentRegistry();
    for (const kind of AGENT_KINDS) {
      registry.registerDisplayName(kind, AGENT_DISPLAY_NAMES[kind]);
    }
    AgentRegistry.setGlobalInstance(registry);
    expect(agentDisplayName('dsh')).toBe('DSH');
    expect(agentDisplayName('claude')).toBe('Claude');
  });
});
