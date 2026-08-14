import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionReader, AgentEvent } from '../../../src/runner/types.js';
import { CodexAppServerRunner } from '../../../src/runner/codex/app-server/runner.js';
import {
  writeIdleServerScript,
  writeActiveServerScript,
} from '../../lib/codex-app-server-test-server.js';

function makeSessionReader(): AgentSessionReader {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [] }),
    isSessionActive: () => false,
  };
}

describe('Codex app-server turn idle timeout', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-codex-idle-timeout-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_turn_idle_timeout_sends_interrupt_when_no_output', async () => {
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const requestLog = join(tmpDir, 'requests.jsonl');
    const server = writeIdleServerScript(tmpDir);

    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: makeSessionReader(),
      binary: process.execPath,
      appServerArgs: [server, requestLog],
      turnTimeoutMs: 80,
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('no output', { cwd })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('error');

    const requests = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const interrupt = requests.find((r) => r.method === 'turn/interrupt');
    expect(interrupt).toBeDefined();
    expect(interrupt.params).toEqual({
      threadId: 'th-idle',
      turnId: 'tn-idle',
    });

    await runner.dispose();
  });

  it('test_anchor_turn_idle_timeout_resets_when_output_keeps_flowing', async () => {
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const requestLog = join(tmpDir, 'active-requests.jsonl');
    const server = writeActiveServerScript(tmpDir);

    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: makeSessionReader(),
      binary: process.execPath,
      appServerArgs: [server, requestLog],
      turnTimeoutMs: 60,
    });

    const events: AgentEvent[] = [];
    for await (const event of runner.run('keep working', { cwd })) {
      events.push(event);
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');

    const textEvents = events.filter(
      (e): e is AgentEvent & { type: 'turn_diff'; text?: string } =>
        e.type === 'turn_diff' && 'text' in e,
    );
    expect(textEvents.at(-1)?.text).toBe('done');

    await runner.dispose();
  });
});
