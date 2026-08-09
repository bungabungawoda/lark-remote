import { describe, it, expect } from 'vitest';
import { AgentRegistry } from './registry.js';
import { ClaudeRunner } from './index.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-registry-test-'));

describe('AgentRegistry', () => {
  it('register + get returns the runner produced by the factory', () => {
    const registry = new AgentRegistry();
    registry.register(
      'claude',
      (ws) => new ClaudeRunner({ binary: '/bin/true', pidDir: tmpDir, workspace: ws }),
    );

    const runner = registry.get('claude', '/tmp/ws-a');
    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect(runner.kind).toBe('claude');
  });

  it('get throws "agent not registered" for an unregistered kind', () => {
    const registry = new AgentRegistry();
    registry.register(
      'claude',
      () => new ClaudeRunner({ workspace: 'test', binary: '/bin/true', pidDir: tmpDir }),
    );

    expect(() => registry.get('codex', '/tmp/ws-a')).toThrow(/agent not registered: codex/);
    expect(() => registry.get('opencode', '/tmp/ws-a')).toThrow(/agent not registered: opencode/);
  });

  it('factory can return a fresh instance per workspace (claude spawn-per-message)', () => {
    const registry = new AgentRegistry();
    registry.register(
      'claude',
      (ws) => new ClaudeRunner({ binary: '/bin/true', pidDir: tmpDir, workspace: ws }),
    );

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
});
