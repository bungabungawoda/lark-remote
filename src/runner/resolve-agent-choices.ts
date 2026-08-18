/**
 * Resolve agentChoices into agents config.
 * Priority: explicit agents config > agentChoices > defaults
 * This is called at startup to restore the last used configuration for the current agent.
 */
import type { AppConfig } from '../config/index.js';
import { choiceFieldsFor } from './agent-choices-common.js';

export function resolveAgentChoices(config: AppConfig): AppConfig {
  const agent = config.defaultAgent;
  const choices = config.agentChoices;

  if (!choices || !agent) {
    return config;
  }

  // Skip claude - it's stored at top-level config.claude, not in agentChoices
  if (agent === 'claude') {
    return config;
  }

  const agentChoices = choices[agent];
  const fields = choiceFieldsFor(agent);
  if (!agentChoices || !fields) {
    return config;
  }

  // Clone to avoid mutation
  const resolved = structuredClone(config);
  // agents.codex 在 schema 中必填（带默认值），此处按旧语义补空对象；
  // 运行时只往 [agent] 槽位写字段，不依赖 codex 默认值。
  if (!resolved.agents) {
    resolved.agents = {} as AppConfig['agents'];
  }
  const agents = resolved.agents;
  const target = ((agents as Record<string, Record<string, unknown>>)[agent] ??= {});
  const source = agentChoices as unknown as Record<string, unknown>;

  for (const { configKey, choicesKey } of fields) {
    const value = source[choicesKey];
    if (!target[configKey] && value) {
      target[configKey] = value;
    }
  }

  return resolved;
}
