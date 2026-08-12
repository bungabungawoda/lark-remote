import { describe, it, expect } from 'vitest';
import { AgentRegistry } from './registry.js';
import { ClaudeRunner } from './index.js';
import { DEFAULT_STOP_GRACE_MS, type AppConfig } from '../config/index.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-registry-test-'));

describe('AgentRegistry', () => {
  it('register + get returns the runner produced by the factory', () => {
    const registry = new AgentRegistry();
    registry.register('claude', (ws) => new ClaudeRunner({ pidDir: tmpDir, workspace: ws }));

    const runner = registry.get('claude', '/tmp/ws-a');
    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect(runner.kind).toBe('claude');
  });

  it('get throws "agent not registered" for an unregistered kind', () => {
    const registry = new AgentRegistry();
    registry.register('claude', () => new ClaudeRunner({ workspace: 'test', pidDir: tmpDir }));

    expect(() => registry.get('codex', '/tmp/ws-a')).toThrow(/agent not registered: codex/);
    expect(() => registry.get('opencode', '/tmp/ws-a')).toThrow(/agent not registered: opencode/);
  });

  it('factory can return a fresh instance per workspace (claude spawn-per-message)', () => {
    const registry = new AgentRegistry();
    registry.register('claude', (ws) => new ClaudeRunner({ pidDir: tmpDir, workspace: ws }));

    const a = registry.get('claude', '/tmp/ws-a');
    const b = registry.get('claude', '/tmp/ws-b');
    expect(a).not.toBe(b);
  });

  it('registerDisplayName + getDisplayName returns the registered name', () => {
    const registry = new AgentRegistry();
    registry.registerDisplayName('codex', 'Codex');
    expect(registry.getDisplayName('codex')).toBe('Codex');
  });

  it('getDisplayName returns the kind string when no display name registered', () => {
    const registry = new AgentRegistry();
    expect(registry.getDisplayName('opencode')).toBe('opencode');
  });

  it('setGlobalInstance + getGlobalInstance returns the same registry', () => {
    const registry = new AgentRegistry();
    AgentRegistry.setGlobalInstance(registry);
    expect(AgentRegistry.getGlobalInstance()).toBe(registry);
  });

  it('getGlobalInstance returns undefined before set', () => {
    // Reset to undefined first to test the unset state
    AgentRegistry.setGlobalInstance(undefined as unknown as AgentRegistry);
    expect(AgentRegistry.getGlobalInstance()).toBeUndefined();
  });

  it('setConfigContainer + getConfigContainer returns the same container', () => {
    const registry = new AgentRegistry();
    const container = { current: { foo: 'bar' } };
    registry.setConfigContainer(container);
    expect(registry.getConfigContainer()).toBe(container);
  });

  it('getConfigContainer returns undefined before set', () => {
    const registry = new AgentRegistry();
    expect(registry.getConfigContainer()).toBeUndefined();
  });

  describe('factory reads latest config from configContainer', () => {
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
        output: { showThinking: true, showToolUse: true, showToolResult: true },
        logging: { level: 'info' },
        defaultAgent: 'claude',
      } as AppConfig;
    }

    it('claude factory picks up updated model and effort from configContainer', () => {
      const registry = new AgentRegistry();
      const startupConfig = makeConfig({ model: 'claude-opus-4-8', effort: 'medium' });
      const updatedConfig = makeConfig({ model: 'claude-sonnet-4-6', effort: 'max' });

      const configContainer = { current: startupConfig };
      registry.setConfigContainer(configContainer);

      // Same pattern as src/index.ts after P1-15 fix
      registry.register('claude', (ws) => {
        const container = registry.getConfigContainer();
        const latestConfig = (container?.current as AppConfig) ?? startupConfig;
        const claudeConfig = latestConfig.claude;
        return new ClaudeRunner({
          model: claudeConfig.model,
          effort: claudeConfig.effort,
          stopGraceMs: claudeConfig.stopGraceMs,
          pidDir: tmpDir,
          workspace: ws,
        });
      });

      // Before update: model = opus, effort = medium
      const before = registry.get('claude', '/tmp/ws-a') as ClaudeRunner;
      expect(before.getStatusInfo().model).toBe('opus');
      expect(before.getStatusInfo().reasoning).toBe('medium');

      // Simulate bridge.setConfig() — updates configContainer.current
      configContainer.current = updatedConfig;

      // After update: model = sonnet, effort = max
      const after = registry.get('claude', '/tmp/ws-b') as ClaudeRunner;
      expect(after.getStatusInfo().model).toBe('sonnet');
      expect(after.getStatusInfo().reasoning).toBe('max');
    });

    it('claude factory fallback to startup config when configContainer not set', () => {
      const registry = new AgentRegistry();
      const startupConfig = makeConfig({ model: 'claude-opus-4-8' });

      // No configContainer set — factory must fall back gracefully
      registry.register('claude', (ws) => {
        const container = registry.getConfigContainer();
        const latestConfig = (container?.current as AppConfig) ?? startupConfig;
        const claudeConfig = latestConfig.claude;
        return new ClaudeRunner({
          model: claudeConfig.model,
          effort: claudeConfig.effort,
          stopGraceMs: claudeConfig.stopGraceMs,
          pidDir: tmpDir,
          workspace: ws,
        });
      });

      const runner = registry.get('claude', '/tmp/ws-a') as ClaudeRunner;
      expect(runner.getStatusInfo().model).toBe('opus');
    });
  });
});
