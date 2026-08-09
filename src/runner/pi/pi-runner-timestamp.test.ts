import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiRunner } from './runner.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-pi-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Create a mock pi script that outputs JSONL.
function createMockPi(script: string): string {
  const scriptPath = path.join(tmpDir, 'mock-pi');
  fs.writeFileSync(scriptPath, `#!/bin/bash\n${script}`, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PiRunner timestamp', () => {
  it('test_anchor_should_generate_timestamp_for_system_init_event', async () => {
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"s1","cwd":"/tmp","model":"pi-3.5","timestamp":"2026-07-18T10:00:00.000Z"}'
      echo '{"type":"message","timestamp":"2026-07-18T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}'
      echo '{"type":"agent_end","timestamp":"2026-07-18T10:00:03.000Z"}'
    `);
    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });

    const events: any[] = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Find system init event
    const initEvents = events.filter((e) => e.type === 'system' && e.subtype === 'init');
    expect(initEvents.length).toBe(1);

    // system.init 必须有 timestamp
    expect(initEvents[0].timestamp).toBeDefined();
    expect(initEvents[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('test_anchor_should_generate_timestamp_for_assistant_event', async () => {
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"s1","cwd":"/tmp","model":"pi-3.5","timestamp":"2026-07-18T10:00:00.000Z"}'
      echo '{"type":"message_start","timestamp":"2026-07-18T10:00:00.500Z","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message","timestamp":"2026-07-18T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}'
      echo '{"type":"message_end","timestamp":"2026-07-18T10:00:01.500Z","message":{"role":"assistant","usage":{}}}'
      echo '{"type":"agent_end","timestamp":"2026-07-18T10:00:03.000Z"}'
    `);
    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });

    const events: any[] = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Find assistant events
    const assistantEvents = events.filter((e) => e.type === 'assistant');
    expect(assistantEvents.length).toBeGreaterThan(0);

    // 每个 assistant 事件必须有 timestamp
    for (const event of assistantEvents) {
      expect(event.timestamp).toBeDefined();
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('test_anchor_should_generate_timestamp_for_tool_result_event', async () => {
    const mockPi = createMockPi(`
      echo '{"type":"session","id":"s1","cwd":"/tmp","model":"pi-3.5","timestamp":"2026-07-18T10:00:00.000Z"}'
      echo '{"type":"message_start","timestamp":"2026-07-18T10:00:00.500Z","message":{"role":"assistant","content":[]}}'
      echo '{"type":"message","timestamp":"2026-07-18T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","function":{"name":"Read","arguments":"{}"}}]}}'
      echo '{"type":"message_end","timestamp":"2026-07-18T10:00:01.500Z","message":{"role":"assistant","usage":{}}}'
      echo '{"type":"message","timestamp":"2026-07-18T10:00:02.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"ok"}]}}'
      echo '{"type":"message_end","timestamp":"2026-07-18T10:00:02.500Z","message":{"role":"toolResult","usage":{}}}'
      echo '{"type":"agent_end","timestamp":"2026-07-18T10:00:03.000Z"}'
    `);
    const runner = new PiRunner({ workspace: 'test', binary: mockPi, pidDir: tmpDir });

    const events: any[] = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Find user events (tool results)
    const userEvents = events.filter((e) => e.type === 'user');
    expect(userEvents.length).toBeGreaterThan(0);

    // 每个 user 事件必须有 timestamp
    for (const event of userEvents) {
      expect(event.timestamp).toBeDefined();
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});
