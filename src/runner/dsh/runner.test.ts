/**
 * DshRunner + DshClient + translator tests against a fake DSH HTTP server.
 *
 * All fixtures use synthetic data (AABB UUIDs, /home/user/project, generic
 * tool names) — no real agent sessions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { currentPlatform, isWin32 } from '../../../src/platform/select.js';
import { DshRunner } from './runner.js';
import { DshTranslator, mapUsage } from './translator.js';
import { FakeDshServer } from '../../../tests/lib/fake-dsh-server.js';
import type { DshDaemon } from './daemon.js';
import type { DshSessionEvent } from './types.js';
import type { AgentSessionReader } from '../types.js';

const CWD = '/home/user/project';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NO_CREDENTIALS_FILE = '/nonexistent/lark-remote-test/.credentials.yaml';

const stubReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({ events: [] }),
  isSessionActive: () => false,
};

function textChunk(delta: string, seq: number): DshSessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1700000000000,
    data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: delta } },
  };
}

function reasoningChunk(delta: string, seq: number): DshSessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1700000000000,
    data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: delta } },
  };
}

function usageMessage(usage: Record<string, unknown>, seq: number): DshSessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 1700000000000,
    data: { turn: 0, step: 0, message: { role: 'assistant', content: [] }, usage },
  };
}

function turnEnd(reason: string, seq: number): DshSessionEvent {
  return {
    type: 'turn/end',
    seq,
    time: 1700000000000,
    data: { turn: 0, reason: { kind: reason } },
  };
}

function sessionEventFrame(sessionId: string, ev: DshSessionEvent): object {
  return { type: 'session/event', sessionId, event: ev };
}

async function collect(gen: AsyncGenerator<import('../types.js').AgentEvent>) {
  const out: import('../types.js').AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('DshTranslator', () => {
  it('maps text-delta chunk to incremental assistant text', () => {
    const t = new DshTranslator();
    const events = t.eventToAgentEvents(textChunk('Hello ', 1), SID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello ' }] },
    });
  });

  it('maps reasoning-delta chunk to assistant thinking', () => {
    const t = new DshTranslator();
    const events = t.eventToAgentEvents(reasoningChunk('thinking...', 1), SID);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'thinking...' }] },
    });
  });

  it('maps turn/end completed → success result', () => {
    const t = new DshTranslator();
    const events = t.eventToAgentEvents(turnEnd('completed', 1), SID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', subtype: 'success', session_id: SID });
  });

  it('maps turn/end aborted and interrupted → interrupted result', () => {
    for (const reason of ['aborted', 'interrupted', 'forked']) {
      const t = new DshTranslator();
      const events = t.eventToAgentEvents(turnEnd(reason, 1), SID);
      expect(events[0]).toMatchObject({ type: 'result', subtype: 'interrupted' });
    }
  });

  it('maps turn/end blocked/error/max-tokens → error result with errorMessage', () => {
    for (const reason of ['blocked', 'error', 'max-tokens']) {
      const t = new DshTranslator();
      const events = t.eventToAgentEvents(turnEnd(reason, 1), SID);
      expect(events[0]).toMatchObject({
        type: 'result',
        subtype: 'error',
        errorMessage: `turn ended with reason: ${reason}`,
      });
    }
  });

  it('includes the LLM failure detail in an error result', () => {
    const t = new DshTranslator();
    const event = turnEnd('error', 1);
    event.data.reason = {
      kind: 'error',
      error: { name: 'LlmError', message: 'provider overloaded' },
    };
    const result = t.eventToAgentEvents(event, SID)[0];
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error',
      errorMessage: 'turn ended with reason: error: provider overloaded',
    });
  });

  it('records usage from assistant/message and attaches it to the result', () => {
    const t = new DshTranslator();
    t.eventToAgentEvents(
      usageMessage(
        { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
        2,
      ),
      SID,
    );
    const result = t.eventToAgentEvents(turnEnd('completed', 3), SID)[0];
    expect(result.type === 'result' && result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 30,
      cache_creation_tokens: 20,
      total_tokens: 200,
    });
  });

  it('omits usage when no assistant/message usage was seen', () => {
    const t = new DshTranslator();
    const result = t.eventToAgentEvents(turnEnd('completed', 1), SID)[0];
    expect(result.type === 'result' && result.usage).toBeUndefined();
  });

  it('mapUsage maps cacheWrite to cache_creation_tokens', () => {
    expect(mapUsage({ inputTokens: 10, outputTokens: 5, cacheWriteTokens: 7 })).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_tokens: 7,
      total_tokens: 22,
    });
  });
});

describe('DshClient / DshRunner integration', () => {
  let server: FakeDshServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('runs a full turn to success: init → assistant deltas → result with usage', async () => {
    server = new FakeDshServer();
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([
      sessionEventFrame(SID, textChunk('Hello ', 1)),
      sessionEventFrame(SID, textChunk('world', 2)),
      sessionEventFrame(SID, usageMessage({ inputTokens: 10, outputTokens: 4 }, 3)),
      sessionEventFrame(SID, turnEnd('completed', 4)),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD }));

    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    expect(init).toMatchObject({ session_id: SID, cwd: CWD, model: 'DSH' });

    const assistant = events.filter((e) => e.type === 'assistant');
    expect(assistant).toHaveLength(2);
    expect(assistant[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello ' }] },
    });
    expect(assistant[1]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'world' }] },
    });

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ type: 'result', subtype: 'success', session_id: SID });
    expect(result?.type === 'result' && result.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
    });
  });

  it('prompt is sent with queue mode and text content', async () => {
    server = new FakeDshServer();
    let promptPayload: unknown;
    server.register('session/prompt', (p) => {
      promptPayload = p;
      return { ok: true, value: { accepted: true } };
    });
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    await collect(runner.run('please help', { cwd: CWD, sessionId: SID }));
    expect(promptPayload).toMatchObject({
      sessionId: SID,
      mode: 'queue',
      content: [{ type: 'text', text: 'please help' }],
    });
    expect((promptPayload as { requestId?: string }).requestId).toMatch(/^lark-remote-/);
  });

  it('creates a session when no sessionId is provided', async () => {
    server = new FakeDshServer();
    let created = false;
    server.register('session/create', (p) => {
      created = true;
      expect(p).toEqual({ cwd: CWD });
      return { ok: true, value: { sessionId: SID } };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    expect(created).toBe(true);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('waits for the shared DSH daemon before creating a session', async () => {
    server = new FakeDshServer();
    let ensured = false;
    server.register('session/create', () => {
      expect(ensured).toBe(true);
      return { ok: true, value: { sessionId: SID } };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const daemon = {
      ensure: async () => {
        ensured = true;
        return server.baseUrl;
      },
    } as unknown as DshDaemon;
    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      daemon,
      host: server.baseUrl,
    });
    await collect(runner.run('hi', { cwd: CWD }));
    expect(ensured).toBe(true);
  });

  it('surfaces a daemon failure before any session call', async () => {
    server = new FakeDshServer();
    let created = false;
    server.register('session/create', () => {
      created = true;
      return { ok: true, value: { sessionId: SID } };
    });
    await server.start();

    const daemon = {
      ensure: async () => {
        throw new Error('DSH 未运行');
      },
    } as unknown as DshDaemon;
    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      daemon,
      host: server.baseUrl,
    });

    const events = await collect(runner.run('hi', { cwd: CWD }));
    const result = events.find((event) => event.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain('DSH 未运行');
    expect(created).toBe(false);
  });

  it('passes agentPreset to session/create and selectModel to align model before run', async () => {
    server = new FakeDshServer();
    let createPayload: unknown;
    let selectPayload: unknown;
    server.register('session/create', (p) => {
      createPayload = p;
      return { ok: true, value: { sessionId: SID } };
    });
    server.register('session/selectModel', (p) => {
      selectPayload = p;
      return {
        ok: true,
        value: {
          selected: {
            provider: 'deepseek-official',
            model: 'deepseek-v4-pro',
            reasoningEffort: 'max',
          },
        },
      };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      agentPreset: 'code',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    await collect(runner.run('hi', { cwd: CWD }));

    expect(createPayload).toEqual({ cwd: CWD, agentPreset: 'code' });
    expect(selectPayload).toEqual({
      sessionId: SID,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
  });

  it('selectModel failure only warns and does not block the run', async () => {
    server = new FakeDshServer();
    let selectCalled = false;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/selectModel', () => {
      selectCalled = true;
      return { ok: false, error: { code: 'model-not-found', message: 'no such model' } };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      model: 'deepseek-v4-pro',
    });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    expect(selectCalled).toBe(true);
    // run 仍成功
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it.skipIf(isWin32(currentPlatform))(
    'selectModel aligns once per session; repeat runs on the same session skip it',
    async () => {
      // Regression: session/selectModel writes the server global default, so a
      // repeat run on the same session must not re-send it (write amplification).
      // history always returns empty (fresh-session semantics); each run's turn/end
      // is pushed when that run's prompt is accepted (causal, no pre-queued frames).
      server = new FakeDshServer();
      let selectCount = 0;
      let promptCount = 0;
      server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
      server.register('session/selectModel', () => {
        selectCount += 1;
        return {
          ok: true,
          value: {
            selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
          },
        };
      });
      server.register('session/prompt', () => {
        promptCount += 1;
        // 与真实 DSH 一致：turn/end 只在该 prompt 被接受后产生。若两帧预先入队，
        // 固定间隔推送会让 run1 尚未关闭的订阅吞掉第二帧，run2 饿死等自己的
        // turn/end（CI 调度抖动下 20s 超时的根因）。
        server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', promptCount)));
        return { ok: true, value: { accepted: true } };
      });
      server.register('session/projections', () => ({
        ok: true,
        value: { asOfSeq: -1, values: {} },
      }));
      await server.start();

      const runner = new DshRunner({
        kind: 'dsh',
        sessionReader: stubReader,
        host: server.baseUrl,
        model: 'deepseek-v4-pro',
      });
      await collect(runner.run('first', { cwd: CWD }));
      await collect(runner.run('second', { cwd: CWD, sessionId: SID }));
      // 首次 run 对齐一次，复用同一 session 的二次 run 不重复写（selectModel 写全局默认）
      expect(selectCount).toBe(1);
    },
  );

  it('does not call selectModel when model is not configured', async () => {
    server = new FakeDshServer();
    let selectCalled = false;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/selectModel', () => {
      selectCalled = true;
      return { ok: true, value: {} };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    await collect(runner.run('hi', { cwd: CWD }));
    expect(selectCalled).toBe(false);
  });

  it('surfaces approval/requested as an assistant prompt (not silently parked)', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([
      {
        type: 'session/event',
        event: {
          type: 'approval/asked',
          seq: 1,
          time: 1700000000000,
          data: { id: 'appr-1', toolName: 'bash', reason: 'run command' },
        },
      },
      sessionEventFrame(SID, turnEnd('completed', 2)),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD, sessionId: SID }));
    const prompts = events.filter(
      (e) => e.type === 'assistant' && e.message.content.some((c) => c.type === 'text'),
    );
    expect(prompts.length).toBeGreaterThan(0);
    const text = prompts[0].message.content.find((c) => c.type === 'text');
    expect(text && 'text' in text ? text.text : '').toContain('需要授权');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('reconnects after remote mux drop and replays the snapshot (dedup by seq)', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    // Connection 1 emits live-a + live-b then the server drops mid-turn
    // ({close:true}); the reconnect snapshot fills the replay-part gap and the
    // reconnected stream delivers turn/end. Dedup skips already-seen seqs.
    server.setHistorySequence([
      { records: [] },
      {
        records: [
          { type: 'event', event: textChunk('live-a', 1) },
          { type: 'event', event: textChunk('live-b', 2) },
          { type: 'event', event: textChunk('replay-part', 5) },
        ],
      },
    ]);
    server.setMuxFrames([
      sessionEventFrame(SID, textChunk('live-a', 1)),
      sessionEventFrame(SID, textChunk('live-b', 2)),
      { close: true },
      sessionEventFrame(SID, turnEnd('completed', 6)),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD, sessionId: SID }));

    const texts = events
      .filter((e) => e.type === 'assistant')
      .map((e) => e.message.content.find((c) => c.type === 'text'))
      .filter((c): c is { type: 'text'; text: string } => !!c)
      .map((c) => c.text);
    expect(texts).toContain('live-a');
    expect(texts).toContain('live-b');
    expect(texts).toContain('replay-part');
    expect(server.connectionCount).toBeGreaterThanOrEqual(2);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('recovers a turn that ends before the mux opens (follow snapshot)', async () => {
    // Prompt is accepted and the turn completes before the subscription opens.
    // The follow snapshot must replay the already-recorded turn/end so the run
    // reaches a success terminal instead of hanging until the idle watchdog.
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setHistoryValue({
      records: [
        { type: 'event', event: textChunk('already-done ', 1) },
        { type: 'event', event: turnEnd('completed', 2) },
      ],
    });
    server.setMuxFrames([]); // live stream carries nothing — the turn already ended
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD, sessionId: SID }));

    const texts = events
      .filter((e) => e.type === 'assistant')
      .map((e) => e.message.content.find((c) => c.type === 'text'))
      .filter((c): c is { type: 'text'; text: string } => !!c)
      .map((c) => c.text);
    expect(texts).toContain('already-done ');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('second prompt in the same session consumes the current turn, not the first turn', async () => {
    // The follow snapshot is the FULL session (multiple turns), so it must
    // start after the pre-prompt high-water mark instead of replaying turn 1
    // and stopping at its turn/end.
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));

    const firstText = textChunk('first answer ', 1);
    const firstEnd = turnEnd('completed', 2);
    const secondText = textChunk('second answer ', 3);
    const secondEnd = turnEnd('completed', 4);

    // The session already committed turn 1; the pre-prompt watermark is seq 2.
    server.setProjectionValue({ asOfSeq: 2, values: {} });
    server.setHistoryValue({
      records: [
        { type: 'event', event: firstText },
        { type: 'event', event: firstEnd },
        { type: 'event', event: secondText },
        { type: 'event', event: secondEnd },
      ],
    });
    server.setMuxFrames([]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
    });
    const events = await collect(runner.run('second question', { cwd: CWD, sessionId: SID }));

    const texts = events
      .filter((e) => e.type === 'assistant')
      .map((e) => e.message.content.find((c) => c.type === 'text'))
      .filter((c): c is { type: 'text'; text: string } => !!c)
      .map((c) => c.text);

    expect(texts).toEqual(['second answer ']);
    expect(texts.join('')).not.toContain('first answer');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('stop() sends session/cancel', async () => {
    server = new FakeDshServer();
    let cancelled = false;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('session/cancel', (p) => {
      cancelled = true;
      expect(p).toEqual({ sessionId: SID });
      return { ok: true, value: { accepted: true } };
    });
    // Keep the stream open with no turn/end so the run blocks.
    server.setMuxFrames([sessionEventFrame(SID, textChunk('partial', 1))]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const iterator = runner.run('hi', { cwd: CWD, sessionId: SID })[Symbol.asyncIterator]();
    // Consume until the first assistant event to ensure prompt was sent.
    await iterator.next();
    await runner.stop({ immediate: true });
    expect(cancelled).toBe(true);
    await iterator.return?.();
  });

  it('stop during startup cancels the created session and does not prompt', async () => {
    // Regression: createSession 挂起期间 stop() 已 abort（此时 sessionId 未知，
    // stop() 无法 cancel）。createSession 返回后 run() 必须检查 abort——cancel
    // 刚建的 session 并中断，不得继续 selectModel/prompt。
    server = new FakeDshServer();
    let cancelCalled = false;
    let promptCalled = false;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/cancel', (p) => {
      cancelCalled = true;
      expect(p).toEqual({ sessionId: SID });
      return { ok: true, value: { accepted: true } };
    });
    server.register('session/prompt', () => {
      promptCalled = true;
      return { ok: true, value: { accepted: true } };
    });
    server.setMuxFrames([]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const iterator = runner.run('hi', { cwd: CWD })[Symbol.asyncIterator]();
    // 推进到 createSession 挂起（createSession resolve 后 run() 检查 abort）。
    const first = iterator.next();
    await runner.stop({ immediate: true });
    const firstResult = await first;
    // 必须产出 interrupted result（不能裸 return——调用方依赖 result 收尾 run 卡）
    expect(firstResult.value).toMatchObject({ type: 'result', subtype: 'interrupted' });
    await iterator.return?.();
    expect(cancelCalled).toBe(true);
    expect(promptCalled).toBe(false);
  });
});

describe('DshRunner stop state', () => {
  it('isRunning reflects an in-flight run', async () => {
    const server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();
    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    expect(runner.isRunning).toBe(false);
    await collect(runner.run('hi', { cwd: CWD, sessionId: SID }));
    expect(runner.isRunning).toBe(false);
    await server.stop();
  });

  it('createSession failure cleans up running state', async () => {
    const server = new FakeDshServer();
    server.register('session/create', () => ({
      ok: false,
      error: { code: 'internal', message: 'session create boom' },
    }));
    await server.start();
    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    // 失败也要产出 error result，且不再泄漏 running 状态
    expect(events.find((e) => e.type === 'result')).toMatchObject({
      subtype: 'error',
      errorMessage: expect.stringContaining('session create boom'),
    });
    expect(runner.isRunning).toBe(false);
    // 状态未污染：清理后再次 run（这次成功）可正常执行
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    const events2 = await collect(runner.run('hi', { cwd: CWD }));
    expect(events2.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
    expect(runner.isRunning).toBe(false);
    await server.stop();
  });

  it('authenticates against a protected host with the launch token', async () => {
    const server = new FakeDshServer();
    server.setRequireAuth(true, 'secret-token');
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      token: 'secret-token',
      credentialsFile: NO_CREDENTIALS_FILE,
    });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
    await server.stop();
  });

  it('surfaces a 401 when the launch token is missing', async () => {
    const server = new FakeDshServer();
    server.setRequireAuth(true, 'secret-token');
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      credentialsFile: NO_CREDENTIALS_FILE,
    });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    expect(events.find((e) => e.type === 'result')).toMatchObject({
      subtype: 'error',
      errorMessage: expect.stringContaining('DSH HTTP 401'),
    });
    await server.stop();
  });

  it('getStatusInfo reports kind/model/host', async () => {
    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: 'http://127.0.0.1:3080',
    });
    const info = runner.getStatusInfo();
    expect(info.kind).toBe('dsh');
    expect(info.model).toBe('DSH');
    expect(info.extras?.host).toBe('http://127.0.0.1:3080');
  });

  it('getStatusInfo includes preset/model/reasoning when configured', () => {
    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: 'http://127.0.0.1:3080',
      agentPreset: 'code',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    const info = runner.getStatusInfo();
    expect(info.model).toBe('deepseek-v4-pro');
    expect(info.extras).toEqual({
      host: 'http://127.0.0.1:3080',
      preset: 'code',
      reasoning: 'max',
    });
  });
});
