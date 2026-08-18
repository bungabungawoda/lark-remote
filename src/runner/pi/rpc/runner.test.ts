import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiRpcRunner } from './runner.js';
import type { AgentSessionReader } from '../../types.js';
import { prependPath, restorePath, writeMockBin } from '../../../../tests/lib/path-mock.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

const MOCK_SERVER = `#!/usr/bin/env node
const config = JSON.parse(process.env.MOCK_PI_SCENARIO || '{}');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'get_state') {
    send({ id: msg.id, type: 'response', command: 'get_state', success: true, data: { sessionId: config.sessionId || '${SESSION_ID}' } });
  } else if (msg.type === 'prompt') {
    send({ id: msg.id, type: 'response', command: 'prompt', success: true });
    if (config.emitEvents !== false) {
      send({ type: 'message_start', message: { role: 'assistant', content: [] } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello' } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], usage: { input: 100, output: 20 } } });
      send({ type: 'agent_settled' });
    }
  } else if (msg.type === 'compact') {
    send({ type: 'compaction_start', reason: 'manual' });
    send({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false });
    if (config.compactSuccess !== false) {
      send({ id: msg.id, type: 'response', command: 'compact', success: true, data: {} });
    } else {
      send({ id: msg.id, type: 'response', command: 'compact', success: false, error: config.compactError || 'Nothing to compact (session too small)' });
    }
  } else if (msg.type === 'abort') {
    send({ id: msg.id, type: 'response', command: 'abort', success: true });
  }
});
`;

const emptyReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({ events: [] }),
  isSessionActive: () => false,
};

let tmpDir: string;
let savedPath: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-pi-rpc-test-'));
  savedPath = prependPath(tmpDir);
  writeMockBin(tmpDir, 'pi', MOCK_SERVER);
});

afterEach(() => {
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeRunner(scenario: Record<string, unknown> = {}): PiRpcRunner {
  process.env.MOCK_PI_SCENARIO = JSON.stringify(scenario);
  return new PiRpcRunner({
    provider: 'Volcano',
    model: 'glm-5.2',
    workspace: tmpDir,
    sessionReader: emptyReader,
    idleTtlMs: 60_000,
    turnIdleTimeoutMs: 5000,
  });
}

describe('PiRpcRunner', () => {
  it('test_anchor_run_new_session_captures_session_id_and_succeeds', async () => {
    const runner = makeRunner();
    const events = [];
    for await (const ev of runner.run('hello', { cwd: tmpDir })) events.push(ev);
    await runner.dispose();

    const result = events.find((e) => e.type === 'result') as {
      subtype: string;
      session_id: string;
    };
    expect(result.subtype).toBe('success');
    expect(result.session_id).toBe(SESSION_ID);
    const turn = events.find((e) => e.type === 'turn_started') as { operationKind: string };
    expect(turn.operationKind).toBe('turn');
    const assistant = events.find((e) => e.type === 'assistant') as {
      message: { content: Array<{ text: string }> };
    };
    expect(assistant.message.content).toContainEqual({ type: 'text', text: 'Hello' });
  });

  it('test_anchor_run_has_runCompact_duck_typing', () => {
    const runner = makeRunner();
    expect('runCompact' in runner).toBe(true);
    expect(typeof (runner as unknown as { runCompact: unknown }).runCompact).toBe('function');
  });

  it('test_anchor_compact_requires_session_id', async () => {
    const runner = makeRunner();
    const events = [];
    for await (const ev of runner.runCompact('', { cwd: tmpDir })) events.push(ev);
    await runner.dispose();
    const result = events.find((e) => e.type === 'result') as {
      subtype: string;
      errorMessage?: string;
    };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toContain('compact requires a sessionId');
  });

  it('test_anchor_compact_success_produces_result', async () => {
    const runner = makeRunner({ compactSuccess: true });
    const events = [];
    for await (const ev of runner.runCompact('', { cwd: tmpDir, sessionId: SESSION_ID })) {
      events.push(ev);
    }
    await runner.dispose();
    const result = events.find((e) => e.type === 'result') as { subtype: string };
    expect(result.subtype).toBe('success');
    const turn = events.find((e) => e.type === 'turn_started') as { operationKind: string };
    expect(turn.operationKind).toBe('compaction');
  });

  it('test_anchor_compact_error_produces_error_result', async () => {
    const runner = makeRunner({
      compactSuccess: false,
      compactError: 'Nothing to compact (session too small)',
    });
    const events = [];
    for await (const ev of runner.runCompact('', { cwd: tmpDir, sessionId: SESSION_ID })) {
      events.push(ev);
    }
    await runner.dispose();
    const result = events.find((e) => e.type === 'result') as {
      subtype: string;
      errorMessage?: string;
    };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toContain('Nothing to compact');
  });

  it('test_anchor_get_status_info', () => {
    const runner = makeRunner();
    const info = runner.getStatusInfo();
    expect(info.kind).toBe('pi');
    expect(info.model).toBe('glm-5.2');
    expect(info.provider).toBe('Volcano');
    expect(info.extras).toMatchObject({ mode: 'rpc' });
  });
});
