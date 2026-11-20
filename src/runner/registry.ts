import type { AgentKind } from '../agent-kinds.js';
import type { Runner } from './index.js';

/**
 * Registry of agent factories, keyed by `AgentKind`. `index.ts` registers one
 * factory per available agent at startup; `Bridge.getRunner(cwd)` looks
 * up `config.defaultAgent` here to pick the concrete runner.
 *
 * Singleton caching: the factory MAY cache its instance internally. All
 * local-subprocess agents (claude/codex/opencode/pi/kimi) are
 * workspace-lifetime (long-lived session); dsh is HTTP+WS direct connection
 * (no local subprocess). Each factory returns a runner per call.
 *
 * Dynamic config reload: factories read the latest config through the
 * registry, enabling runtime config changes to take effect.
 */
export class AgentRegistry {
  private readonly factories = new Map<AgentKind, (cwd: string) => Runner>();
  /** Latest config snapshot for runtime reloads. */
  private latestConfig?: unknown;

  register(kind: AgentKind, factory: (cwd: string) => Runner): void {
    this.factories.set(kind, factory);
  }

  /** Update the config snapshot read by factories. */
  updateConfig(config: unknown): void {
    this.latestConfig = config;
  }

  /** Latest config for factories, falling back to the startup snapshot. */
  getLatestConfig<T>(fallback: T): T {
    return (this.latestConfig as T | undefined) ?? fallback;
  }

  get(kind: AgentKind, cwd: string): Runner {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new Error(`agent not registered: ${kind}`);
    }
    return factory(cwd);
  }
}
