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

  const fields = choiceFieldsFor(agent);
  // dsh 的 choices 恒为空（host 是连接配置而非 per-run choice），无需恢复
  if (!fields || fields.length === 0) {
    return config;
  }
  const agentChoices = (choices as Record<string, Record<string, unknown>>)[agent];
  if (!agentChoices) {
    return config;
  }

  // Clone to avoid mutation
  const resolved = structuredClone(config);
  const agents = resolved.agents;
  const target = ((agents as Record<string, Record<string, unknown>>)[agent] ??= {});
  const source = agentChoices;

  for (const { configKey, choicesKey } of fields) {
    const value = source[choicesKey];
    if (!target[configKey] && value) {
      target[configKey] = value;
    }
  }

  return resolved;
}
