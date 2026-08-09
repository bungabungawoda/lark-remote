/**
 * Sync agent configuration to agentChoices.
 * Called when user saves config to remember their choices for quick switching.
 */
import type { AppConfig } from '../config/index.js';

export function syncAgentChoices(config: AppConfig, agent: string): AppConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  const agents = configAny.agents || {};
  const agentCfg = agents[agent];

  // claude reads from top-level config.claude, not agents.claude
  if (agent !== 'claude' && !agentCfg) {
    return config;
  }

  const updated = JSON.parse(JSON.stringify(config)) as AppConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updatedAny = updated as any;

  if (!updatedAny.agentChoices) {
    updatedAny.agentChoices = {};
  }

  switch (agent) {
    case 'codex':
      if (agentCfg.model) {
        if (!updatedAny.agentChoices.codex) updatedAny.agentChoices.codex = {};
        updatedAny.agentChoices.codex.model = agentCfg.model;
      }
      if (agentCfg.modelProvider) {
        if (!updatedAny.agentChoices.codex) updatedAny.agentChoices.codex = {};
        updatedAny.agentChoices.codex.modelProvider = agentCfg.modelProvider;
      }
      break;
    case 'pi':
      if (agentCfg.model) {
        if (!updatedAny.agentChoices.pi) updatedAny.agentChoices.pi = {};
        updatedAny.agentChoices.pi.model = agentCfg.model;
      }
      if (agentCfg.provider) {
        if (!updatedAny.agentChoices.pi) updatedAny.agentChoices.pi = {};
        updatedAny.agentChoices.pi.provider = agentCfg.provider;
      }
      if (agentCfg.thinking) {
        if (!updatedAny.agentChoices.pi) updatedAny.agentChoices.pi = {};
        updatedAny.agentChoices.pi.thinking = agentCfg.thinking;
      }
      break;
    case 'opencode':
      if (agentCfg.modelID) {
        if (!updatedAny.agentChoices.opencode) updatedAny.agentChoices.opencode = {};
        updatedAny.agentChoices.opencode.modelID = agentCfg.modelID;
      }
      if (agentCfg.providerID) {
        if (!updatedAny.agentChoices.opencode) updatedAny.agentChoices.opencode = {};
        updatedAny.agentChoices.opencode.providerID = agentCfg.providerID;
      }
      break;
    case 'kimi':
      if (agentCfg.model) {
        if (!updatedAny.agentChoices.kimi) updatedAny.agentChoices.kimi = {};
        updatedAny.agentChoices.kimi.model = agentCfg.model;
      }
      if (agentCfg.thinkingEffort) {
        if (!updatedAny.agentChoices.kimi) updatedAny.agentChoices.kimi = {};
        updatedAny.agentChoices.kimi.thinkingEffort = agentCfg.thinkingEffort;
      }
      break;
  }

  return updated;
}
