import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAgentRegistries } from './factory.js';
import { ClaudeRunner, type AgentKind } from './index.js';
import { DEFAULT_STOP_GRACE_MS, type AppConfig } from '../config/index.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let tmpDir: string;

/** Build a minimal AppConfig (feishu fields required by schema). */
function makeConfig(
  overrides: {
    model?: string;
    effort?: string;
    stopGraceMs?: number;
    agents?: NonNullable<AppConfig['agents']>;
  } = {},
): AppConfig {
  return {
    feishu: { appId: 'test-app', appSecret: 'test-secret' },
    claude: {
      model: overrides.model ?? 'claude-opus-4-8',
      effort: overrides.effort ?? 'medium',
      stopGraceMs: overrides.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    },
    ...(overrides.agents ? { agents: overrides.agents } : {}),
    idle: { watchdogMinutes: 15 },
    output: { showThinking: true, showToolUse: true, showToolResult: true },
    logging: { level: 'info' },
    defaultAgent: 'claude',
  } as AppConfig;
}

describe('production agent factories (src/runner/factory.ts)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-factory-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claude factory picks up updated model/effort/stopGraceMs from configContainer (real production factory)', () => {
    const startupConfig = makeConfig({
      model: 'claude-opus-4-8',
      effort: 'medium',
      stopGraceMs: 10_000,
    });
    const updatedConfig = makeConfig({
      model: 'claude-sonnet-4-6',
      effort: 'max',
      stopGraceMs: 20_000,
    });

    const { agentRegistry } = createAgentRegistries({
      config: startupConfig,
      configDir: tmpDir,
      cliArgs: { settings: '/tmp/settings.json' },
    });

    // Production wiring: container is seeded with the startup config.
    const container = agentRegistry.getConfigContainer();
    expect(container?.current).toBe(startupConfig);

    const before = agentRegistry.get('claude', '/tmp/ws-a') as ClaudeRunner;
    expect(before).toBeInstanceOf(ClaudeRunner);
    expect(before.getStatusInfo().model).toBe('opus');
    expect(before.getStatusInfo().reasoning).toBe('medium');
    // stopGraceMs/defaultSettings have no public accessor; reading them via
    // cast is deliberate — adding public getters just for tests would expand
    // the production API surface (see review P3-4).
    expect((before as unknown as { stopGraceMs: number }).stopGraceMs).toBe(10_000);
    expect((before as unknown as { defaultSettings?: string }).defaultSettings).toBe(
      '/tmp/settings.json',
    );

    // bridge.setConfig() does exactly this: container.current = newConfig.
    container!.current = updatedConfig;

    const after = agentRegistry.get('claude', '/tmp/ws-b') as ClaudeRunner;
    expect(after.getStatusInfo().model).toBe('sonnet');
    expect(after.getStatusInfo().reasoning).toBe('max');
    expect((after as unknown as { stopGraceMs: number }).stopGraceMs).toBe(20_000);
    expect((after as unknown as { defaultSettings?: string }).defaultSettings).toBe(
      '/tmp/settings.json',
    );
  });

  it('claude factory returns a fresh ClaudeRunner per workspace call', () => {
    const config = makeConfig();
    const { agentRegistry } = createAgentRegistries({ config, configDir: tmpDir, cliArgs: {} });

    const a = agentRegistry.get('claude', '/tmp/ws-a');
    const b = agentRegistry.get('claude', '/tmp/ws-b');
    expect(a).toBeInstanceOf(ClaudeRunner);
    expect(b).toBeInstanceOf(ClaudeRunner);
    expect(a).not.toBe(b);
  });

  it('codex/opencode/pi/kimi factories pick up updated config from configContainer', () => {
    const startupConfig = makeConfig({
      agents: {
        codex: { model: 'glm-4-5', modelProvider: 'volc', stopGraceMs: 10_000 },
        opencode: { modelID: 'claude-sonnet-4-6', providerID: 'anthropic' },
        pi: { model: 'glm-4-5', provider: 'Volcano', thinking: 'medium', tools: 'read,bash,edit' },
        kimi: { model: 'kimi-code/k2', thinkingEffort: 'high' },
      },
    });
    const updatedConfig = makeConfig({
      agents: {
        codex: { model: 'glm-5-2', modelProvider: 'volc2', stopGraceMs: 20_000 },
        opencode: { modelID: 'claude-opus-4-8', providerID: 'anthropic' },
        pi: { model: 'glm-5-2', provider: 'Volcano', thinking: 'high', tools: 'read,bash,edit' },
        kimi: { model: 'kimi-code/k3', thinkingEffort: 'max' },
      },
    });

    const { agentRegistry } = createAgentRegistries({
      config: startupConfig,
      configDir: tmpDir,
      cliArgs: {},
    });
    const container = agentRegistry.getConfigContainer();

    const before = {
      codex: agentRegistry.get('codex', '/tmp/ws-a').getStatusInfo(),
      opencode: agentRegistry.get('opencode', '/tmp/ws-a').getStatusInfo(),
      pi: agentRegistry.get('pi', '/tmp/ws-a').getStatusInfo(),
      kimi: agentRegistry.get('kimi', '/tmp/ws-a').getStatusInfo(),
    };
    expect(before.codex.model).toBe('glm-4-5');
    expect(before.codex.provider).toBe('volc');
    expect(before.opencode.model).toBe('anthropic/claude-sonnet-4-6');
    expect(before.opencode.provider).toBe('anthropic');
    expect(before.pi.model).toBe('glm-4-5');
    expect(before.pi.reasoning).toBe('medium');
    expect(before.kimi.model).toBe('kimi-code/k2');
    expect(before.kimi.reasoning).toBe('high');

    // After container update, each factory must build runners from the NEW
    // config — not the startup snapshot (P1-15 for all agents).
    // bridge.setConfig() does exactly this: container.current = newConfig.
    container!.current = updatedConfig;

    const after = {
      codex: agentRegistry.get('codex', '/tmp/ws-b').getStatusInfo(),
      opencode: agentRegistry.get('opencode', '/tmp/ws-b').getStatusInfo(),
      pi: agentRegistry.get('pi', '/tmp/ws-b').getStatusInfo(),
      kimi: agentRegistry.get('kimi', '/tmp/ws-b').getStatusInfo(),
    };
    expect(after.codex.model).toBe('glm-5-2');
    expect(after.codex.provider).toBe('volc2');
    expect(after.opencode.model).toBe('anthropic/claude-opus-4-8');
    expect(after.opencode.provider).toBe('anthropic');
    expect(after.pi.model).toBe('glm-5-2');
    expect(after.pi.reasoning).toBe('high');
    expect(after.kimi.model).toBe('kimi-code/k3');
    expect(after.kimi.reasoning).toBe('max');
  });

  it('registers all five agents and display names', () => {
    const config = makeConfig();
    const { agentRegistry } = createAgentRegistries({ config, configDir: tmpDir, cliArgs: {} });

    for (const kind of ['claude', 'codex', 'opencode', 'pi', 'kimi'] as const) {
      expect(() => agentRegistry.get(kind, '/tmp/ws-a')).not.toThrow();
      expect(agentRegistry.getDisplayName(kind)).not.toBe(kind);
    }
  });

  it('passes workspace through to pidFilePath for all five agents (P1-9 behavioral)', () => {
    const config = makeConfig();
    const { agentRegistry } = createAgentRegistries({ config, configDir: tmpDir, cliArgs: {} });

    const kinds: AgentKind[] = ['claude', 'codex', 'opencode', 'pi', 'kimi'];
    for (const kind of kinds) {
      const runner = agentRegistry.get(kind, 'ws-a');
      // SpawningRunner derives pidFilePath from workspace: `${kind}-${workspaceSanitized}.pid`.
      // pidFilePath is protected (no public accessor); the cast is deliberate
      // (same rationale as stopGraceMs above).
      const pidFilePath = (runner as unknown as { pidFilePath: string }).pidFilePath;
      expect(pidFilePath).toBe(path.join(tmpDir, `${kind}-ws_a.pid`));
    }
  });
});
