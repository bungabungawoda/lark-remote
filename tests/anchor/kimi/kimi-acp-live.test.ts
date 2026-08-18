/**
 * Live anchor: KimiAcpRunner against the real `kimi acp` binary.
 *
 * Gated behind KIMI_LIVE_TEST=1 (default skipped, so external contributors
 * without kimi credentials can still run `bun run test` green). This file is
 * the red-green anchor for the ACP wire shapes: it must go RED when the
 * translator drifts from the real protocol (session/update uses
 * params.update.sessionUpdate, not a nested event.type).
 *
 * All sessions run in mkdtemp cwds; no real session data is committed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KimiAcpRunner } from '../../../src/runner/kimi/acp/runner.js';
import { KimiSessionReader } from '../../../src/session/kimi/sessions.js';
import type { AgentEvent } from '../../../src/runner/types.js';

function resolveKimiBinary(): string | null {
  const which = spawnSync('which', ['kimi'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  const fallback = join(homedir(), '.kimi-code', 'bin', 'kimi');
  return existsSync(fallback) ? fallback : null;
}

const kimiBinary = resolveKimiBinary();
const describeLive = process.env.KIMI_LIVE_TEST && kimiBinary ? describe : describe.skip;

/**
 * mkdtemp + realpath: kimi stores the session cwd verbatim in state.json and
 * the reader guards against fs.realpathSync(cwd) — same contract the bridge
 * uses (cwd 必须存 realpath 形式). On macOS tmpdir lives under /var →
 * /private/var, so a raw mkdtemp path would fail the guard.
 */
function newLiveCwd(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'kimi-acp-live-')));
}

function newRunner(permissionMode: 'manual' | 'auto' | 'yolo'): KimiAcpRunner {
  return new KimiAcpRunner({
    kind: 'kimi',
    sessionReader: new KimiSessionReader(),
    binary: kimiBinary ?? 'kimi',
    permissionMode,
    turnIdleTimeoutMs: 90_000,
  });
}

describeLive('kimi-acp live anchor (KIMI_LIVE_TEST=1)', () => {
  it('握手 + 一轮 prompt：system.init + 流式 text + result success + contextLength 非 0（jsonl 权威回读）', async () => {
    const cwd = newLiveCwd();
    const runner = newRunner('yolo');
    const events: AgentEvent[] = [];
    let sessionId = '';
    try {
      for await (const event of runner.run('回复 ok 即可。', { cwd })) {
        events.push(event);
        if (event.type === 'system' && event.subtype === 'init') {
          sessionId = (event as { session_id?: string }).session_id ?? '';
        }
      }

      const init = events.find((e) => e.type === 'system' && e.subtype === 'init') as
        (AgentEvent & { session_id?: string }) | undefined;
      expect(init).toBeDefined();
      expect(init?.session_id).toBeTruthy();

      // R1: 流式 text 必须走 session/update 通知到达（被打回时静默丢弃）。
      // 2026-08-17 起文本/思考走 turn_diff 快照通道（a39e049 修卡片重复），
      // assistant 事件只承载 tool_use，不再含 text 块。
      const hasStreamingText = events.some(
        (e) =>
          e.type === 'turn_diff' &&
          typeof (e as { text?: string }).text === 'string' &&
          ((e as { text?: string }).text ?? '').length > 0,
      );
      expect(hasStreamingText).toBe(true);

      const result = events.find((e) => e.type === 'result') as
        (AgentEvent & { subtype?: string }) | undefined;
      expect(result).toBeDefined();
      expect(result?.subtype).toBe('success');

      // R1/暗卷：usage contextLength 非 0。实测 usage_update 在 prompt response
      // 之后 ~1ms 到达（events-map 注释 "after a turn settles"），result 事件
      // 带不上；done 卡 contextLength 走 wire.jsonl usage.record 权威回读。
      // kimi 在 turn.ended 后才 flush wire，轮询等它落盘再断言（生产 bridge
      // 的 resolveFinalUsage 读同一文件，连接不 dispose 时自然落盘）。
      const reader = new KimiSessionReader();
      let usageContextLength: number | undefined;
      for (let i = 0; i < 50; i++) {
        const content = reader.readSessionContent(sessionId, cwd, { maxEvents: 0 });
        if (content.usage?.contextLength) {
          usageContextLength = content.usage.contextLength;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(usageContextLength).toBeGreaterThan(0);
    } finally {
      await runner.dispose();
    }
  }, 90_000);

  it('审批全流：approval_requested → accept → tool_result 到达 + result success', async () => {
    const cwd = newLiveCwd();
    const runner = newRunner('manual');
    const events: AgentEvent[] = [];
    let approvalSeen = false;
    try {
      for await (const event of runner.run('请用 bash 执行 echo ACP_LIVE_OK，然后直接结束。', {
        cwd,
      })) {
        events.push(event);
        if (event.type === 'approval_requested') {
          approvalSeen = true;
          const decisions = (event as { view?: { availableDecisions?: string[] } }).view
            ?.availableDecisions;
          expect(decisions).toContain('accept');
          expect(decisions).toContain('decline');
          expect(decisions).toContain('cancel');
          await runner.respondApproval(event.requestId, { action: 'accept' });
        }
      }
    } finally {
      await runner.dispose();
    }

    expect(approvalSeen).toBe(true);

    // R1: tool 流必须经 session/update 通知到达（被打回时 tool_result 丢）。
    const hasToolResult = events.some(
      (e) =>
        e.type === 'user' &&
        'message' in e &&
        Array.isArray(
          (e as { message?: { content?: Array<{ type?: string }> } }).message?.content,
        ) &&
        (e as { message: { content: Array<{ type: string }> } }).message.content.some(
          (c) => c.type === 'tool_result',
        ),
    );
    expect(hasToolResult).toBe(true);

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('success');
  }, 90_000);

  it('stop → interrupted（独立终态，不是 error）', async () => {
    const cwd = newLiveCwd();
    const runner = newRunner('yolo');
    const events: AgentEvent[] = [];
    try {
      const runPromise = (async () => {
        for await (const event of runner.run('请写一篇关于软件架构的 3000 字长文，不要提前结束。', {
          cwd,
        })) {
          events.push(event);
        }
      })();

      // turn_started 后立即 stop。
      for (let i = 0; i < 600 && !events.some((e) => e.type === 'turn_started'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(events.some((e) => e.type === 'turn_started')).toBe(true);
      await runner.stop();
      await runPromise;
    } finally {
      await runner.dispose();
    }

    const result = events.find((e) => e.type === 'result') as
      (AgentEvent & { subtype?: string }) | undefined;
    expect(result).toBeDefined();
    expect(result?.subtype).toBe('interrupted');
  }, 90_000);
});
