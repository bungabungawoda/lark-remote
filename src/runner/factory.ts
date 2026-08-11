import { getAgentConfig, DEFAULT_STOP_GRACE_MS, type AppConfig } from '../config/index.js';
import {
  ClaudeRunner,
  CodexExecRunner,
  OpencodeExecRunner,
  PiRunner,
  KimiRunner,
} from './index.js';
import { AgentRegistry } from './registry.js';
import {
  SessionReaderRegistry,
  ClaudeSessionReader,
  CodexSessionReader,
  OpencodeSessionReader,
  PiSessionReader,
  KimiSessionReader,
} from '../session/index.js';

export interface AgentRegistryDeps {
  /** Startup config; seeded into configContainer and used as factory fallback. */
  config: AppConfig;
  configDir: string;
  cliArgs: { settings?: string };
}

/**
 * Wire the production registries: per-workspace runner factories + session
 * readers + display names for all five agents (claude/codex/opencode/pi/kimi).
 *
 * Extracted from src/index.ts's initializeRunner (P1-15) so tests can exercise
 * the real factory closures — e.g. claude reads model/effort/stopGraceMs from
 * agentRegistry.getConfigContainer() at get() time, not a startup snapshot.
 * Pure construction: no global state, no process probes, no process side
 * effects. Callers (main) layer on setGlobalInstance + probeAllAgents.
 */
export function createAgentRegistries(deps: AgentRegistryDeps): {
  agentRegistry: AgentRegistry;
  sessionReaderRegistry: SessionReaderRegistry;
} {
  const { config, configDir, cliArgs } = deps;
  const agentRegistry = new AgentRegistry();

  // 2026-07-12 / P1-15: factory 闭包必须能访问到最新的 config，而不是启动时的快照。
  // 用可变容器存储 config 引用，registry 持有容器引用，factory 每次调用时从容器读取
  // 最新值（bridge.setConfig() 更新 container.current → 运行中改配置立即生效）。
  const configContainer = { current: config };
  agentRegistry.setConfigContainer(configContainer);

  // P1-15: Claude factory reads from configContainer (not closure) so runtime
  // config changes (model, effort, stopGraceMs) take effect after
  // bridge.setConfig() + clearRunners(). Same pattern as codex/pi/kimi.
  agentRegistry.register('claude', (ws) => {
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const claudeConfig = latestConfig.claude;
    return new ClaudeRunner({
      model: claudeConfig.model,
      effort: claudeConfig.effort,
      stopGraceMs: claudeConfig.stopGraceMs,
      settings: cliArgs.settings,
      pidDir: configDir,
      workspace: ws,
    });
  });

  // Register CodexExecRunner (codex exec --json, approval_policy=never).
  // Factory reads latest config from container.current so runtime config changes
  // (reasoningEffort, model, etc.) take effect after bridge.setConfig() + clearRunners().
  const codexSessionReader = new CodexSessionReader({ codexHome: process.env.CODEX_HOME });
  agentRegistry.register('codex', (ws: string) => {
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const codexConfig = getAgentConfig(latestConfig, 'codex');
    return new CodexExecRunner({
      model: codexConfig?.model,
      modelProvider: codexConfig?.modelProvider,
      reasoningEffort: codexConfig?.reasoningEffort,
      stopGraceMs:
        codexConfig?.stopGraceMs ?? latestConfig.claude?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      pidDir: configDir,
      workspace: ws,
      sessionReader: codexSessionReader,
    });
  });

  // Register session reader (same instance as used by runner)
  const sessionReaderRegistry = new SessionReaderRegistry();
  sessionReaderRegistry.register('claude', new ClaudeSessionReader());
  sessionReaderRegistry.register('codex', codexSessionReader);

  // Register OpencodeSessionReader (CLI version)
  // Using `opencode session list` and `opencode export` instead of HTTP API
  const opencodeSessionReader = new OpencodeSessionReader();

  agentRegistry.register('opencode', (ws: string) => {
    // Get latest config from container
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const ocConfig = getAgentConfig(latestConfig, 'opencode');

    // Build model string with validation: provider/model format
    let model: string | undefined;
    if (ocConfig?.modelID) {
      const provider = ocConfig.providerID ?? 'anthropic';
      // Validate: if modelID contains '/', it's already in provider/model format
      if (ocConfig.modelID.includes('/')) {
        model = ocConfig.modelID;
      } else {
        model = `${provider}/${ocConfig.modelID}`;
      }
    }

    return new OpencodeExecRunner({
      model,
      // P1-15: read stopGraceMs from latestConfig (not startup closure)
      stopGraceMs: latestConfig.claude?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      pidDir: configDir,
      workspace: ws,
      sessionReader: opencodeSessionReader,
    });
  });
  sessionReaderRegistry.register('opencode', opencodeSessionReader);

  // Register PiRunner and PiSessionReader
  const piSessionReader = new PiSessionReader();
  agentRegistry.register('pi', (ws: string) => {
    // 每次 factory 调用时从 registry 获取最新 config
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const piConf = getAgentConfig(latestConfig, 'pi');
    return new PiRunner({
      provider: piConf?.provider ?? 'Volcano',
      model: piConf?.model ?? 'glm-5.2',
      thinking: piConf?.thinking ?? 'medium',
      tools: (piConf?.tools ?? 'read,bash,edit,write,grep,find,ls')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      pidDir: configDir,
      workspace: ws,
      sessionReader: piSessionReader,
    });
  });
  sessionReaderRegistry.register('pi', piSessionReader);

  // Register KimiRunner and KimiSessionReader
  const kimiSessionReader = new KimiSessionReader();
  agentRegistry.register('kimi', (ws: string) => {
    // 每次 factory 调用时从 registry 获取最新 config
    const container = agentRegistry.getConfigContainer();
    const latestConfig = (container?.current as AppConfig) ?? config;
    const kimiConf = getAgentConfig(latestConfig, 'kimi');
    return new KimiRunner({
      model: kimiConf?.model ?? 'kimi-code/k3',
      thinkingEffort: kimiConf?.thinkingEffort ?? 'max',

      // P1-15: read stopGraceMs from latestConfig (not startup closure)
      stopGraceMs: latestConfig.claude?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      pidDir: configDir,
      workspace: ws,
      sessionReader: kimiSessionReader,
    });
  });
  sessionReaderRegistry.register('kimi', kimiSessionReader);

  // 2026-07-17: 注册所有 agent 的显示名，实现单点真相
  agentRegistry.registerDisplayName('claude', 'Claude');
  agentRegistry.registerDisplayName('codex', 'Codex');
  agentRegistry.registerDisplayName('opencode', 'Opencode');
  agentRegistry.registerDisplayName('pi', 'Pi');
  agentRegistry.registerDisplayName('kimi', 'Kimi');

  return { agentRegistry, sessionReaderRegistry };
}
