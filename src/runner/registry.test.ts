import { describe, it, expect } from 'vitest';
import { AgentRegistry } from './registry.js';
import { ClaudeRunner } from './index.js';
import { DEFAULT_STOP_GRACE_MS, type AppConfig } from '../config/index.js';
import { makeTempDir } from '../../tests/lib/temp-dir.js';
import { ClaudeSessionReader } from '../session/claude/index.js';

const tmpDir = makeTempDir('lark-registry-test-');

describe('AgentRegistry', () => {
  it('register + get returns the runner produced by the factory', () => {
    const registry = new AgentRegistry();
    registry.register(
      'claude',
      (ws) =>
        new ClaudeRunner({ sessionReader: new ClaudeSessionReader(), pidDir: tmpDir, cwd: ws }),
    );

    const runner = registry.get('claude', '/tmp/ws-a');
    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect((runner as ClaudeRunner).kind).toBe('claude');
  });

  it('get throws "agent not registered" for an unregistered kind', () => {
    const registry = new AgentRegistry();
    registry.register(
      'claude',
      () =>
        new ClaudeRunner({ sessionReader: new ClaudeSessionReader(), cwd: 'test', pidDir: tmpDir }),
    );

    expect(() => registry.get('codex', '/tmp/ws-a')).toThrow(/agent not registered: codex/);
    expect(() => registry.get('opencode', '/tmp/ws-a')).toThrow(/agent not registered: opencode/);
  });

  it('factory can return a fresh instance per cwd (claude spawn-per-message)', () => {
    const registry = new AgentRegistry();
    registry.register(
      'claude',
      (ws) =>
        new ClaudeRunner({ sessionReader: new ClaudeSessionReader(), pidDir: tmpDir, cwd: ws }),
    );

    const a = registry.get('claude', '/tmp/ws-a');
    const b = registry.get('claude', '/tmp/ws-b');
    expect(a).not.toBe(b);
  });

  it('updateConfig replaces the snapshot returned by getLatestConfig', () => {
    const registry = new AgentRegistry();
    registry.updateConfig({ foo: 'bar' });
    expect(registry.getLatestConfig({ fallback: true })).toEqual({ foo: 'bar' });
  });

  it('getLatestConfig returns the fallback before the first update', () => {
    const registry = new AgentRegistry();
    expect(registry.getLatestConfig({ fallback: true })).toEqual({ fallback: true });
  });

  describe('factory reads latest config from the registry', () => {
    /** Build a minimal AppConfig for testing (feishu fields required by schema). */
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
        logging: { level: 'info' },
        defaultAgent: 'claude',
      } as AppConfig;
    }

    it('claude factory picks up updated model and effort', () => {
      const registry = new AgentRegistry();
      const startupConfig = makeConfig({ model: 'claude-opus-4-8', effort: 'medium' });
      const updatedConfig = makeConfig({ model: 'claude-sonnet-4-6', effort: 'max' });

      registry.updateConfig(startupConfig);

      registry.register('claude', (ws) => {
        const latestConfig = registry.getLatestConfig(startupConfig);
        const claudeConfig = latestConfig.claude;
        return new ClaudeRunner({
          sessionReader: new ClaudeSessionReader(),
          model: claudeConfig.model,
          effort: claudeConfig.effort,
          stopGraceMs: claudeConfig.stopGraceMs,
          pidDir: tmpDir,
          cwd: ws,
        });
      });

      // Before update: model = opus, effort = medium
      const before = registry.get('claude', '/tmp/ws-a') as ClaudeRunner;
      expect(before.getStatusInfo().model).toBe('opus');
      expect(before.getStatusInfo().reasoning).toBe('medium');

      registry.updateConfig(updatedConfig);

      // After update: model = sonnet, effort = max
      const after = registry.get('claude', '/tmp/ws-b') as ClaudeRunner;
      expect(after.getStatusInfo().model).toBe('sonnet');
      expect(after.getStatusInfo().reasoning).toBe('max');
    });

    it('claude factory falls back to the startup config before any update', () => {
      const registry = new AgentRegistry();
      const startupConfig = makeConfig({ model: 'claude-opus-4-8' });

      registry.register('claude', (ws) => {
        const latestConfig = registry.getLatestConfig(startupConfig);
        const claudeConfig = latestConfig.claude;
        return new ClaudeRunner({
          sessionReader: new ClaudeSessionReader(),
          model: claudeConfig.model,
          effort: claudeConfig.effort,
          stopGraceMs: claudeConfig.stopGraceMs,
          pidDir: tmpDir,
          cwd: ws,
        });
      });

      const runner = registry.get('claude', '/tmp/ws-a') as ClaudeRunner;
      expect(runner.getStatusInfo().model).toBe('opus');
    });
  });
});
