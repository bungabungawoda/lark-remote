import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KimiRunner } from './runner.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';

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
let savedPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-kimi-test-'));
  savedPath = prependPath(tmpDir);
});

afterEach(() => {
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Create a mock kimi script that outputs JSONL.
function createMockKimi(script: string): string {
  return writeMockBin(tmpDir, 'kimi', `#!/bin/bash\n${script}`);
}

describe('KimiRunner timestamp', () => {
  it('test_anchor_should_generate_timestamp_for_assistant_text_event', async () => {
    createMockKimi(`
      echo '{"type":"message","role":"meta","subtype":"session.resume_hint","session_id":"s1"}'
      echo '{"type":"message","role":"assistant","content":"hello"}'
      echo '{"type":"message","role":"user","content":"ok"}'
    `);
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });

    const events: any[] = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Find assistant text events
    const assistantEvents = events.filter(
      (e) => e.type === 'assistant' && e.message?.content?.[0]?.type === 'text',
    );
    expect(assistantEvents.length).toBeGreaterThan(0);

    // 每个 assistant 事件必须有 timestamp
    for (const event of assistantEvents) {
      expect(event.timestamp).toBeDefined();
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('test_anchor_should_generate_timestamp_for_tool_call_event', async () => {
    createMockKimi(`
      echo '{"type":"message","role":"meta","subtype":"session.resume_hint","session_id":"s1"}'
      echo '{"type":"message","role":"assistant","tool_calls":[{"id":"t1","function":{"name":"Read","arguments":"{}"}}]}'
      echo '{"type":"message","role":"user","content":"ok"}'
    `);
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });

    const events: any[] = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Find assistant tool call events
    const toolEvents = events.filter(
      (e) => e.type === 'assistant' && e.message?.content?.[0]?.type === 'tool_use',
    );
    expect(toolEvents.length).toBeGreaterThan(0);

    // 每个 tool 事件必须有 timestamp
    for (const event of toolEvents) {
      expect(event.timestamp).toBeDefined();
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('test_anchor_should_generate_timestamp_for_tool_result_event', async () => {
    createMockKimi(`
      echo '{"type":"message","role":"meta","subtype":"session.resume_hint","session_id":"s1"}'
      echo '{"type":"message","role":"assistant","content":"using tool"}'
      echo '{"type":"message","role":"assistant","tool_calls":[{"id":"t1","function":{"name":"Read","arguments":"{}"}}]}'
      echo '{"type":"message","role":"tool","tool_call_id":"t1","content":"file content"}'
    `);
    const runner = new KimiRunner({ workspace: 'test', pidDir: tmpDir });

    const events: any[] = [];
    for await (const event of runner.run('hello', { cwd: '/tmp' })) {
      events.push(event);
    }

    // Find tool result events (type: user)
    const toolResultEvents = events.filter(
      (e) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result',
    );
    expect(toolResultEvents.length).toBeGreaterThan(0);

    // 每个 tool result 事件必须有 timestamp
    for (const event of toolResultEvents) {
      expect(event.timestamp).toBeDefined();
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});
