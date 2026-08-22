import type { AgentKind, Runner } from './index.js';

/**
 * 单例 registry 实例，供 agentDisplayName 等全局查询使用。
 * 在 index.ts 初始化后设置。
 */
let globalRegistry: AgentRegistry | undefined;

/**
 * Registry of agent factories, keyed by `AgentKind`. `index.ts` registers one
 * factory per available agent at startup; `Bridge.getRunner(workspace)` looks
 * up `config.defaultAgent` here to pick the concrete runner.
 *
 * Singleton caching: the factory MAY cache its instance internally. Most
 * current spawn-type agents (claude, opencode, pi, kimi) are spawn-per-message; codex is
 * workspace-lifetime (app-server); dsh is HTTP+WS direct connection (no local
 * subprocess). Each factory returns a runner per call.
 *
 * Dynamic config reload: factory can read latest config via registry's
 * configContainer, enabling runtime config changes to take effect.
 */
export class AgentRegistry {
  private readonly factories = new Map<AgentKind, (workspace: string) => Runner>();
  private readonly displayNames = new Map<AgentKind, string>();
  /** Container for runtime config updates (pi provider dynamic reload). */
  private configContainer?: { current: unknown };

  register(kind: AgentKind, factory: (workspace: string) => Runner): void {
    this.factories.set(kind, factory);
  }

  /**
   * 注册 agent 的显示名。应在 register(kind, factory) 后调用。
   * 用于 agentDisplayName 等全局查询，实现单点真相。
   */
  registerDisplayName(kind: AgentKind, displayName: string): void {
    this.displayNames.set(kind, displayName);
  }

  /**
   * 获取 agent 显示名。未注册时返回原始 kind。
   */
  getDisplayName(kind: AgentKind): string {
    return this.displayNames.get(kind) ?? kind;
  }

  /**
   * 设置全局 registry 实例，供 agentDisplayName 等全局函数使用。
   * 在 index.ts 初始化所有 agents 后调用。
   */
  static setGlobalInstance(reg: AgentRegistry | undefined): void {
    globalRegistry = reg;
  }

  /**
   * 获取全局 registry 实例。
   */
  static getGlobalInstance(): AgentRegistry | undefined {
    return globalRegistry;
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

  get(kind: AgentKind, workspace: string): Runner {
    const factory = this.factories.get(kind);
    if (!factory) {
      throw new Error(`agent not registered: ${kind}`);
    }
    return factory(workspace);
  }
}
