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
 * Dynamic config reload: factory can read latest config via registry's
 * configContainer, enabling runtime config changes to take effect.
 */
export class AgentRegistry {
  private readonly factories = new Map<AgentKind, (cwd: string) => Runner>();
  /** Container for runtime config updates (pi provider dynamic reload). */
  private configContainer?: { current: unknown };

  register(kind: AgentKind, factory: (cwd: string) => Runner): void {
    this.factories.set(kind, factory);
  }

  /**
   * Set config container reference. Call after bridge config is updated.
   * Factory functions can read latest config from here.
   */
  setConfigContainer(container: { current: unknown }): void {
    this.configContainer = container;
  }

  /**
   * Get the config container for factory functions to read latest config.
   * Returns undefined if not set.
   */
  getConfigContainer(): { current: unknown } | undefined {
    return this.configContainer;
  }

  get(kind: AgentKind, cwd: string): Runner {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new Error(`agent not registered: ${kind}`);
    }
    return factory(cwd);
  }
}
