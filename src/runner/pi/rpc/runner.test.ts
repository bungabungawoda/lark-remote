import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiRpcRunner } from './runner.js';
import type { AgentSessionReader } from '../../types.js';
import { prependPath, restorePath, writeMockSource } from '../../../../tests/lib/path-mock.js';
import { rmRf } from '../../../../tests/lib/tmp-cleanup.js';

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
const sendSettled = () => send({ type: 'agent_settled' });
let stateRequests = 0;
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (config.commandLog) require('node:fs').appendFileSync(config.commandLog, msg.type + '\\n');
  if (config.promptLog && msg.type === 'prompt') require('node:fs').appendFileSync(config.promptLog, JSON.stringify(msg) + '\\n');
  if (msg.type === 'get_state') {
    if (++stateRequests > 1 && config.ignoreHealth) return;
    send({ id: msg.id, type: 'response', command: 'get_state', success: true, data: { sessionId: config.sessionId || '${SESSION_ID}', model: config.model } });
  } else if (msg.type === 'prompt') {
    if (config.promptSuccess === false) {
      send({ id: msg.id, type: 'response', command: 'prompt', success: false, error: config.promptError || 'invalid model' });
      return;
    }
    send({ id: msg.id, type: 'response', command: 'prompt', success: true });
    if (config.emitEvents !== false) {
      send({ type: 'message_start', message: { role: 'assistant', content: [] } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello' } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], usage: { input: 100, output: 20 } } });
      sendSettled();
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
  writeMockSource(tmpDir, 'pi', MOCK_SERVER);
});

afterEach(() => {
  restorePath(savedPath);
  rmRf(tmpDir);
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
  it('unattended Pi keeps a live session and sends checkpoint guidance on every turn', async () => {
    const promptLog = path.join(tmpDir, 'prompts.jsonl');
    const runner = new PiRpcRunner({
      workspace: tmpDir,
      sessionReader: emptyReader,
      unattended: true,
      env: { MOCK_PI_SCENARIO: JSON.stringify({ promptLog }) },
    });
    try {
      for (const sessionId of [undefined, SESSION_ID]) {
        const events = [];
        for await (const event of runner.run('Complete the tests', { cwd: tmpDir, sessionId })) {
          events.push(event);
        }
        expect(events).toContainEqual(
          expect.objectContaining({ type: 'result', subtype: 'success' }),
        );
        expect(events.some((event) => event.type === 'approval_requested')).toBe(false);
      }
      const prompts = fs
        .readFileSync(promptLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(prompts).toHaveLength(2);
      expect(prompts.every((prompt) => prompt.message.includes('checkpoint'))).toBe(true);
      expect(await runner.probeHealth()).toBe(1);
    } finally {
      await runner.dispose();
    }
    expect(await runner.probeHealth()).toBe(0);
  });
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

  it('主动重建连接不会让旧 Pi close hook 误伤新 run', async () => {
    const runner = makeRunner();
    const first = [];
    for await (const ev of runner.run('first', { cwd: tmpDir })) first.push(ev);

    const second = [];
    for await (const ev of runner.run('second', {
      cwd: tmpDir,
      sessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
    })) {
      second.push(ev);
    }

    expect(second.find((e) => e.type === 'result')).toEqual(
      expect.objectContaining({ subtype: 'success' }),
    );
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Pi RPC connection closed'),
    );
    await runner.dispose();
  });

  it('uses the live model limit and resets API count on resumed turns', async () => {
    const runner = makeRunner({ model: { id: 'actual-model', contextWindow: 1000000 } });
    try {
      for (const sessionId of [undefined, SESSION_ID]) {
        const events = [];
        for await (const ev of runner.run('hello', { cwd: tmpDir, sessionId })) events.push(ev);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'system',
            subtype: 'init',
            model: 'actual-model',
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'result',
            usage: expect.objectContaining({ api_calls: 1, context_limit: 1000000 }),
          }),
        );
      }
    } finally {
      await runner.dispose();
    }
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

  it('test_anchor_prompt_failure_success_false_produces_error_result_not_timeout', async () => {
    // CC-08: prompt 返回 success:false（无效模型/provider/忙）时必须立即产出
    // error result（含 pi 的错误文本），而不是忽略响应继续等 agent_settled →
    // 最长 turn idle timeout。
    const runner = makeRunner({
      promptSuccess: false,
      promptError: 'invalid model: glm-does-not-exist',
    });
    const events = [];
    for await (const ev of runner.run('hello', { cwd: tmpDir })) events.push(ev);
    await runner.dispose();
    const result = events.find((e) => e.type === 'result') as {
      subtype: string;
      errorMessage?: string;
    };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toContain('invalid model: glm-does-not-exist');
  }, 15000);
});

describe('zero-cost RPC health', () => {
  it('does not create a client while idle', async () => {
    const runner = makeRunner();
    expect(await runner.probeHealth()).toBe(0);
    await runner.dispose();
  });
  it('only sends get_state on an existing client', async () => {
    const commandLog = path.join(tmpDir, 'commands');
    const runner = makeRunner({ commandLog });
    try {
      for await (const _event of runner.run('mock only', { cwd: tmpDir })) {
        /* drain */
      }
      fs.writeFileSync(commandLog, '');
      expect(await runner.probeHealth()).toBe(1);
      expect(fs.readFileSync(commandLog, 'utf8')).toBe('get_state\n');
    } finally {
      await runner.dispose();
    }
  });
  it('fails when a live child stops answering RPC', async () => {
    const runner = makeRunner({ ignoreHealth: true });
    try {
      for await (const _event of runner.run('mock only', { cwd: tmpDir })) {
        /* drain */
      }
      await expect(runner.probeHealth()).rejects.toThrow('timeout');
    } finally {
      await runner.dispose();
    }
  }, 10000);
});
