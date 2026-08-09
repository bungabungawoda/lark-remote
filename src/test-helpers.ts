/**
 * Shared stub factories for Bridge dependency registries (src/ test variant).
 *
 * Every test file under src/ that constructs `new Bridge({ ... })` must pass
 * `agentRegistry` and `sessionReaderRegistry` (both are required since
 * the registry-mandatory refactor). Import from here to avoid duplicating
 * boilerplate.
 */

import type { Runner, AgentRunner } from './runner/index.js';
import { AgentRegistry } from './runner/registry.js';
import { SessionReaderRegistry } from './session/registry.js';

/** Create a minimal AgentRegistry that maps all agent kinds to the given runner. */
export function createStubAgentRegistry(runner: Runner): AgentRegistry {
  const reg = new AgentRegistry();
  const asAgent = () => runner as unknown as AgentRunner;
  reg.register('claude', asAgent);
  reg.register('codex', asAgent);
  reg.register('opencode', asAgent);
  reg.register('pi', asAgent);
  reg.register('kimi', asAgent);
  return reg;
}

/** Create a minimal SessionReaderRegistry with no readers registered. */
export function createStubSessionReaderRegistry(): SessionReaderRegistry {
  return new SessionReaderRegistry();
}
