import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { currentPlatform, isWin32 } from '../../../src/platform/select.js';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionReader, AgentEvent } from '../../../src/runner/types.js';
import { CodexAppServerRunner } from '../../../src/runner/codex/app-server/runner.js';
import { rmRf } from '../../../tests/lib/tmp-cleanup.js';
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
    rmRf(tmpDir);
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
      // 400ms：须显著大于子进程冷启动（CI 慢环境下 ~50ms+），idle 窗口从
      // run() 启动就开始计；20/40/80ms 级裕度会被冷启动吃光导致假红。
      turnTimeoutMs: 400,
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

  // 亚秒级时序用例（400ms deadline < 500ms 消息间隔）：win32 冷启动 1s+，
  // 首轮必超时，语义无法在 win32 上确定性验证，门控。
  it.skipIf(isWin32(currentPlatform))(
    'test_anchor_turn_idle_timeout_resets_when_output_keeps_flowing',
    async () => {
      const cwd = join(tmpDir, 'workspace');
      mkdirSync(cwd, { recursive: true });
      const requestLog = join(tmpDir, 'active-requests.jsonl');
      const server = writeActiveServerScript(tmpDir);

      const runner = new CodexAppServerRunner({
        kind: 'codex',
        sessionReader: makeSessionReader(),
        binary: process.execPath,
        appServerArgs: [server, requestLog],
        // 裕度须覆盖子进程冷启动。turn/completed 在 500ms > 400ms 初始 deadline
        // 才到达：滚动重置坏掉（定时器不随通知重置）时 turn 必先超时变红，
        // 本用例才能确定性地验证「输出流动 → idle 不超时」语义。
        turnTimeoutMs: 400,
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
    },
  );
});
