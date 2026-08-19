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
import { DshConfigBuilder } from './dsh.js';

/**
 * 首次启动默认展示的 Coding Agent 顺序：Codex → Claude → OpenCode → Pi → Kimi → DSH。
 * 未安装（availability === false）的 agent 在展示时排到后面
 * （见 sortAgentsForDisplay），同组内保持本顺序。
 */
export const DEFAULT_AGENT_ORDER: readonly AgentKind[] = [
  'codex',
  'claude',
  'opencode',
  'pi',
  'kimi',
  'dsh',
];

/** Registry of config builders, keyed by agent kind. */
const builders: Record<AgentKind, AgentConfigCardBuilder> = {
  claude: new ClaudeConfigBuilder(),
  codex: new CodexConfigBuilder(),
  pi: new PiConfigBuilder(),
  opencode: new OpencodeConfigBuilder(),
  kimi: new KimiConfigBuilder(),
  dsh: new DshConfigBuilder(),
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
  return DEFAULT_AGENT_ORDER.filter((kind) => kind in builders);
}

/**
 * 按展示规则排序 agent 列表：明确未安装（availability === false）的排后，
 * 已安装/未知的在前；同组内保持传入顺序（canonical order）。
 * Array.prototype.sort 是稳定排序，因此按可用性分组不会打乱组内顺序。
 */
export function sortAgentsForDisplay(
  agents: readonly AgentKind[],
  availability: (kind: AgentKind) => boolean | undefined,
): AgentKind[] {
  return [...agents].sort((a, b) => {
    const aMissing = availability(a) === false ? 1 : 0;
    const bMissing = availability(b) === false ? 1 : 0;
    return aMissing - bMissing;
  });
}
