/**
 * Resolve agentChoices into agents config.
 * Priority: explicit agents config > agentChoices > defaults
 * This is called at startup to restore the last used configuration for the current agent.
 */
import type { AppConfig } from '../config/index.js';

export function resolveAgentChoices(config: AppConfig): AppConfig {
  const choices = config.agentChoices;
  const agent = config.defaultAgent;

  if (!choices || !agent) {
    return config;
  }

  // Skip claude - it's stored at top-level config.claude, not in agentChoices
  if (agent === 'claude') {
    return config;
  }

  const agentChoices = choices[agent];
  if (!agentChoices) {
    return config;
  }

  // Clone to avoid mutation
  const resolved = JSON.parse(JSON.stringify(config)) as AppConfig;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolvedAny = resolved as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentChoicesAny = agentChoices as any;

  switch (agent) {
    case 'codex':
      if (!resolvedAny.agents) resolvedAny.agents = {};
      if (!resolvedAny.agents.codex) resolvedAny.agents.codex = {};
      if (!resolvedAny.agents.codex.model && agentChoicesAny.model) {
        resolvedAny.agents.codex.model = agentChoicesAny.model;
      }
      if (!resolvedAny.agents.codex.modelProvider && agentChoicesAny.modelProvider) {
        resolvedAny.agents.codex.modelProvider = agentChoicesAny.modelProvider;
      }
      break;
    case 'pi':
      if (!resolvedAny.agents) resolvedAny.agents = {};
      if (!resolvedAny.agents.pi) resolvedAny.agents.pi = {};
      if (!resolvedAny.agents.pi.model && agentChoicesAny.model) {
        resolvedAny.agents.pi.model = agentChoicesAny.model;
      }
      if (!resolvedAny.agents.pi.provider && agentChoicesAny.provider) {
        resolvedAny.agents.pi.provider = agentChoicesAny.provider;
      }
      if (!resolvedAny.agents.pi.thinking && agentChoicesAny.thinking) {
        resolvedAny.agents.pi.thinking = agentChoicesAny.thinking;
      }
      break;
    case 'opencode':
      if (!resolvedAny.agents) resolvedAny.agents = {};
      if (!resolvedAny.agents.opencode) resolvedAny.agents.opencode = {};
      if (!resolvedAny.agents.opencode.modelID && agentChoicesAny.modelID) {
        resolvedAny.agents.opencode.modelID = agentChoicesAny.modelID;
      }
      if (!resolvedAny.agents.opencode.providerID && agentChoicesAny.providerID) {
        resolvedAny.agents.opencode.providerID = agentChoicesAny.providerID;
      }
      break;
    case 'kimi':
      if (!resolvedAny.agents) resolvedAny.agents = {};
      if (!resolvedAny.agents.kimi) resolvedAny.agents.kimi = {};
      if (!resolvedAny.agents.kimi.model && agentChoicesAny.model) {
        resolvedAny.agents.kimi.model = agentChoicesAny.model;
      }
      if (!resolvedAny.agents.kimi.thinkingEffort && agentChoicesAny.thinkingEffort) {
        resolvedAny.agents.kimi.thinkingEffort = agentChoicesAny.thinkingEffort;
      }
      break;
  }

  return resolved;
}
