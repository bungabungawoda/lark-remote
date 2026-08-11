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
  overrides: { model?: string; effort?: string; stopGraceMs?: number } = {},
): AppConfig {
  return {
    feishu: { appId: 'test-app', appSecret: 'test-secret' },
    claude: {
      model: overrides.model ?? 'claude-opus-4-8',
      effort: overrides.effort ?? 'medium',
      stopGraceMs: overrides.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    },
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
      const pidFilePath = (runner as unknown as { pidFilePath: string }).pidFilePath;
      expect(pidFilePath).toBe(path.join(tmpDir, `${kind}-ws_a.pid`));
    }
  });
});
