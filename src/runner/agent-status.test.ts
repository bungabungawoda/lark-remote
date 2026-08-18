import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from './index.js';
import { PiRpcRunner } from './pi/index.js';
import type { AgentSessionReader } from './types.js';

const emptyReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({ events: [] }),
  isSessionActive: () => false,
};

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ClaudeRunner getStatusInfo', () => {
  it('returns status info with model and reasoning', () => {
    const runner = new ClaudeRunner({
      workspace: 'test',
      model: 'claude-opus-4-8',
      effort: 'high',
      pidDir: tmpDir,
    });

    const info = runner.getStatusInfo();

    expect(info.kind).toBe('claude');
    expect(info.model).toBe('opus');
    expect(info.reasoning).toBe('high');
  });

  it('returns reasoning as off for haiku', () => {
    const runner = new ClaudeRunner({
      workspace: 'test',
      model: 'claude-haiku-4-5-20250501',
      pidDir: tmpDir,
    });

    const info = runner.getStatusInfo();

    expect(info.kind).toBe('claude');
    expect(info.model).toBe('haiku');
    expect(info.reasoning).toBe('off');
  });

  it('returns reasoning from effort for sonnet', () => {
    const runner = new ClaudeRunner({
      workspace: 'test',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      pidDir: tmpDir,
    });

    const info = runner.getStatusInfo();

    expect(info.kind).toBe('claude');
    expect(info.model).toBe('sonnet');
    expect(info.reasoning).toBe('medium');
  });

  it('maps unknown model IDs to themselves', () => {
    const runner = new ClaudeRunner({
      workspace: 'test',
      model: 'unknown-model-xyz',
      effort: 'medium',
      pidDir: tmpDir,
    });

    const info = runner.getStatusInfo();

    expect(info.model).toBe('unknown-model-xyz');
    expect(info.reasoning).toBe('medium'); // default effort
  });
});

describe('PiRpcRunner getStatusInfo', () => {
  it('returns status info with model, provider and thinking', () => {
    const runner = new PiRpcRunner({
      workspace: 'test',
      sessionReader: emptyReader,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      thinking: 'high',
    });

    const info = runner.getStatusInfo();

    expect(info.kind).toBe('pi');
    expect(info.model).toBe('claude-sonnet-4-20250514');
    expect(info.provider).toBe('anthropic');
    expect(info.reasoning).toBe('high');
  });

  it('returns default values when not specified', () => {
    const runner = new PiRpcRunner({ workspace: 'test', sessionReader: emptyReader });

    const info = runner.getStatusInfo();

    expect(info.kind).toBe('pi');
    expect(info.model).toBe('glm-5.2');
    expect(info.provider).toBe('Volcano');
    expect(info.reasoning).toBe('medium');
  });
});
