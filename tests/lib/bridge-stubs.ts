/**
 * Shared stub factories for Bridge dependency registries.
 *
 * Every test file that constructs `new Bridge({ ... })` must pass
 * `agentRegistry` and `sessionReaderRegistry` (both are required since
 * the registry-mandatory refactor). Import from here to avoid duplicating
 * boilerplate across 60+ test files.
 *
 * Usage:
 *   import { createStubAgentRegistry, createStubSessionReaderRegistry } from '../lib/bridge-stubs.js';
 *   const bridge = new Bridge({
 *     runner,
 *     connector,
 *     sessionStore,
 *     config,
 *     agentRegistry: createStubAgentRegistry(runner),
 *     sessionReaderRegistry: createStubSessionReaderRegistry(),
 *   });
 */

import type { Runner, AgentRunner } from '../../src/runner/index.js';
import { AgentRegistry } from '../../src/runner/registry.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

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
