/**
 * Config card builder registry — provides getConfigBuilder(agent) factory.
 *
 * Each agent implements AgentConfigCardBuilder in its own file.
 * Adding a new agent = add a file + register here (no upstream changes needed).
 */

import type { AgentKind } from '../../runner/types.js';
import type { AgentConfigCardBuilder } from './types.js';
import { ClaudeConfigBuilder } from './claude.js';
import { CodexConfigBuilder } from './codex.js';
import { PiConfigBuilder } from './pi.js';
import { OpencodeConfigBuilder } from './opencode.js';
import { KimiConfigBuilder } from './kimi.js';

/** Registry of config builders, keyed by agent kind. */
const builders: Record<AgentKind, AgentConfigCardBuilder> = {
  claude: new ClaudeConfigBuilder(),
  codex: new CodexConfigBuilder(),
  pi: new PiConfigBuilder(),
  opencode: new OpencodeConfigBuilder(),
  kimi: new KimiConfigBuilder(),
};

/**
 * Get the config builder for a specific agent.
 *
 * @param agent - The agent kind (claude, codex, pi, opencode, kimi)
 * @returns The config builder instance for that agent
 * @throws Error if the agent is not registered
 */
export function getConfigBuilder(agent: AgentKind): AgentConfigCardBuilder {
  const builder = builders[agent];
  if (!builder) {
    throw new Error(`No config builder registered for agent: ${agent}`);
  }
  return builder;
}

/** List all registered agent kinds. */
export function listRegisteredAgents(): AgentKind[] {
  return Object.keys(builders) as AgentKind[];
}
