/**
 * Sync agent configuration to agentChoices.
 * Called when user saves config to remember their choices for quick switching.
 */
import type { AppConfig } from '../config/index.js';
import { choiceFieldsFor } from './agent-choices-common.js';

export function syncAgentChoices(config: AppConfig, agent: string): AppConfig {
  // claude 的配置在顶层 config.claude，不在 agents 下，无需同步
  const fields = choiceFieldsFor(agent);
  if (!fields) return config;

  const agents = config.agents as unknown as Record<string, unknown> | undefined;
  const agentCfg = agents?.[agent];
  if (!agentCfg) return config;

  const updated = structuredClone(config);
  const choices = (updated.agentChoices ??= {});
  const agentChoices = ((choices as Record<string, Record<string, unknown>>)[agent] ??= {});
  const source = agentCfg as Record<string, unknown>;

  for (const { configKey, choicesKey } of fields) {
    const value = source[configKey];
    if (value) agentChoices[choicesKey] = value;
  }
  return updated;
}
