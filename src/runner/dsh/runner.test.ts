/**
 * DshRunner + DshClient + translator tests against a fake DSH HTTP server.
 *
 * All fixtures use synthetic data (AABB UUIDs, /home/user/project, generic
 * tool names) — no real agent sessions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { currentPlatform, isWin32 } from '../../../src/platform/select.js';
import { DshRunner } from './runner.js';
import { dshQuestionsOf, isTimedQuestionRequest } from './client.js';
import { DshApprovalTracker } from './approval.js';
import { DshTranslator, mapUsage } from './translator.js';
import { createInitialRunState, reduceRunState } from '../../../src/card/run-state.js';
import { FakeDshServer } from '../../../tests/lib/fake-dsh-server.js';
import { sleep, waitFor } from '../../../tests/lib/wait-for.js';
import type { DshDaemon } from './daemon.js';
import type { DshAssistantStreamFrame, DshSessionEvent } from './types.js';
import type { AgentEvent, AgentSessionReader } from '../types.js';

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

/** DSH 把 prompt 的 requestId 回写进 durable user/message 的 source.rpcId。 */
function promptMessage(rpcId: string, seq: number, text = 'queued prompt'): DshSessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1700000000000,
    data: {
      id: `msg-${rpcId}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId },
    },
  };
}

function toolCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  seq: number,
): DshSessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1700000000000,
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
  };
}

function toolResult(callId: string, text: string, isError: boolean, seq: number): DshSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1700000000000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
      },
    },
  };
}

function approvalAsked(
  approvalId: string,
  callId: string,
  toolName: string,
  reason: string,
  seq: number,
): DshSessionEvent {
  return {
    type: 'approval/asked',
    seq,
    time: 1700000000000,
    data: { id: approvalId, toolName, callId, reason },
  };
}

function sessionEventFrame(sessionId: string, ev: DshSessionEvent): object {
  return { type: 'session/event', sessionId, event: ev };
}

/**
 * One forwarded `ask_user_question` waterfall frame for the fake `$events` stream.
 * `extraRequest` carries protocol fields beside `questions` (e.g. `wait.timed`).
 */
function questionWaterfall(
  eventId: string,
  questions: Array<Record<string, unknown>>,
  agentId = SID,
  extraRequest: Record<string, unknown> = {},
): object {
  return {
    type: 'waterfall',
    event: 'user-questions/request',
    eventId,
    agentId,
    request: { questions, ...extraRequest },
  };
}

/** The question text used by the question-card fixtures (answers keyed by text). */
const NEXT_STEP_QUESTION = '要我动手修吗？';

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
      message: {
        content: [{ type: 'thinking', thinking: 'thinking...', itemId: 'r:0:0' }],
      },
    });
  });

  it('stamps live reasoning deltas with attempt+block itemId and concatenates verbatim', () => {
    const liveChunk = (
      delta: string,
      index: number,
      attemptId = 'att-1',
    ): DshAssistantStreamFrame => ({
      type: 'chunk',
      attemptId,
      chunk: { type: 'reasoning-delta', index, text: delta },
    });

    const t = new DshTranslator();
    t.streamFrameToAgentEvents({ type: 'start', attemptId: 'att-1' }, SID);
    const [first] = t.streamFrameToAgentEvents(liveChunk('The', 0), SID);
    const [second] = t.streamFrameToAgentEvents(liveChunk(' file', 0), SID);
    const [nextBlock] = t.streamFrameToAgentEvents(liveChunk(' then', 1), SID);

    expect(first).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'thinking', itemId: 'r:att-1:0' }] },
    });
    // 同一 reasoning block 的 token delta 共享 itemId。
    expect(second).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'thinking', itemId: 'r:att-1:0' }] },
    });
    // 换 block index → 换 itemId。
    expect(nextBlock).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'thinking', itemId: 'r:att-1:1' }] },
    });

    // 端到端缝：translator 输出 → reducer，正文逐字拼接、无注入换行。
    let state = createInitialRunState('run-dsh-seam');
    for (const ev of [first, second]) state = reduceRunState(state, ev);
    const block = state.blocks[0];
    expect(block?.kind === 'thinking' ? block.content : '').toBe('The file');
  });

  it('maps tool/call to an assistant tool_use with parsed arguments', () => {
    const t = new DshTranslator();
    const events = t.eventToAgentEvents(
      toolCall('call-1', 'bash', { command: 'npm test' }, 1),
      SID,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'npm test' } }],
      },
    });
  });

  it('keeps non-JSON tool arguments verbatim instead of dropping the call', () => {
    const t = new DshTranslator();
    const event = toolCall('call-1', 'bash', {}, 1);
    event.data = { ...event.data, arguments: '{"command": "npm' };
    const [mapped] = t.eventToAgentEvents(event, SID);
    expect(mapped).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', input: '{"command": "npm' }] },
    });
  });

  it('drops tool/call without callId or name (malformed frame)', () => {
    const t = new DshTranslator();
    const event = toolCall('call-1', 'bash', { command: 'ls' }, 1);
    event.data = { turn: 1, callId: 'call-1' };
    expect(t.eventToAgentEvents(event, SID)).toEqual([]);
  });

  it('maps tool/result to a user tool_result carrying is_error', () => {
    const t = new DshTranslator();
    const ok = t.eventToAgentEvents(toolResult('call-1', 'all good', false, 2), SID);
    expect(ok[0]).toMatchObject({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'all good', is_error: false },
        ],
      },
    });

    const failed = t.eventToAgentEvents(toolResult('call-1', 'boom', true, 3), SID);
    expect(failed[0]).toMatchObject({
      type: 'user',
      message: { content: [{ tool_use_id: 'call-1', content: 'boom', is_error: true }] },
    });
  });

  it('flattens block content and marks images in tool/result', () => {
    const t = new DshTranslator();
    const event = toolResult('call-1', '', false, 2);
    event.data = {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call-1',
        isError: false,
        content: [
          { type: 'text', text: 'line-1' },
          { type: 'image', data: 'base64...' },
          { type: 'text', text: 'line-2' },
        ],
      },
    };
    const [mapped] = t.eventToAgentEvents(event, SID);
    expect(mapped).toMatchObject({
      type: 'user',
      message: { content: [{ content: 'line-1\n[image]\nline-2' }] },
    });
  });

  it('reduces tool/call + tool/result into one ok tool block (card tool row)', () => {
    const t = new DshTranslator();
    let state = createInitialRunState('run-1');
    for (const ev of [
      toolCall('call-1', 'bash', { command: 'npm test' }, 1),
      toolResult('call-1', 'ok', false, 2),
    ]) {
      for (const mapped of t.eventToAgentEvents(ev, SID)) {
        state = reduceRunState(state, mapped);
      }
    }
    const tools = state.blocks.filter((b) => b.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      tool: { id: 'call-1', name: 'bash', status: 'ok', output: 'ok' },
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

  it('sums usage across every sampling of the turn (multi-step tool loop)', () => {
    // DSH 每次模型调用（step）一条 usage；只取末条会把多步 run 低报
    // （实测 done 卡 Input 231 / Output 689，而整轮真实消耗是各 step 之和）。
    const t = new DshTranslator();
    t.eventToAgentEvents(
      usageMessage(
        { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10_000, cacheWriteTokens: 20 },
        2,
      ),
      SID,
    );
    t.eventToAgentEvents(
      usageMessage(
        { inputTokens: 30, outputTokens: 80, cacheReadTokens: 10_200, cacheWriteTokens: 5 },
        4,
      ),
      SID,
    );
    const result = t.eventToAgentEvents(turnEnd('completed', 5), SID)[0];
    expect(result.type === 'result' && result.usage).toEqual({
      input_tokens: 130,
      output_tokens: 130,
      cache_read_tokens: 20_200,
      cache_creation_tokens: 25,
      total_tokens: 130 + 130 + 20_200 + 25,
    });
  });

  it('does not double count the live usage chunk of a step already in assistant/message', () => {
    // 同一次采样既走 live `usage` chunk，又落 durable assistant/message.usage。
    // 两条通道相加会把该 step 翻倍，所以只以 durable 事件为累加来源。
    const t = new DshTranslator();
    const usage = { inputTokens: 40, outputTokens: 9, cacheReadTokens: 700 };
    t.streamFrameToAgentEvents(
      { type: 'chunk', attemptId: 'attempt-1', chunk: { type: 'usage', usage } },
      SID,
    );
    t.eventToAgentEvents(usageMessage(usage, 2), SID);
    t.eventToAgentEvents(usageMessage({ inputTokens: 5, outputTokens: 3 }, 4), SID);
    const result = t.eventToAgentEvents(turnEnd('completed', 5), SID)[0];
    expect(result.type === 'result' && result.usage).toEqual({
      input_tokens: 45,
      output_tokens: 12,
      cache_read_tokens: 700,
      cache_creation_tokens: 0,
      total_tokens: 45 + 12 + 700,
    });
  });

  it('falls back to the last live usage chunk when no assistant/message usage persisted', () => {
    const t = new DshTranslator();
    t.streamFrameToAgentEvents(
      {
        type: 'chunk',
        attemptId: 'attempt-1',
        chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } },
      },
      SID,
    );
    const result = t.eventToAgentEvents(turnEnd('aborted', 2), SID)[0];
    expect(result.type === 'result' && result.usage).toMatchObject({
      input_tokens: 7,
      output_tokens: 2,
      total_tokens: 9,
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

describe('DshApprovalTracker', () => {
  it('refreshes the answer client when the Host re-delivers a pending waterfall', () => {
    const tracker = new DshApprovalTracker();
    tracker.onAuditAsked({ approvalId: 'appr-1', callId: 'call-1', toolName: 'bash' });
    tracker.onWaterfall({
      eventId: 'evt-1',
      clientId: 'client-1',
      callId: 'call-1',
      toolName: 'bash',
    });
    tracker.onWaterfall({
      eventId: 'evt-1',
      clientId: 'client-2',
      callId: 'call-1',
      toolName: 'bash',
    });

    expect(tracker.getBinding('appr-1')?.waterfall.clientId).toBe('client-2');
  });
});

describe('dshQuestionsOf', () => {
  it('parses a question batch and keeps ids, headers and options', () => {
    expect(
      dshQuestionsOf({
        questions: [
          {
            id: 'next',
            header: '下一步',
            question: '要我动手修吗？',
            multiSelect: true,
            options: [{ label: '只修 P1', description: '修 1-7' }, { label: '先不改' }],
          },
        ],
      }),
    ).toEqual([
      {
        id: 'next',
        header: '下一步',
        question: '要我动手修吗？',
        multiSelect: true,
        options: [{ label: '只修 P1', description: '修 1-7' }, { label: '先不改' }],
      },
    ]);
  });

  it('rejects duplicate question texts (answers are keyed by text)', () => {
    expect(
      dshQuestionsOf({
        questions: [
          { id: 'a', question: '同名问题' },
          { id: 'b', question: '同名问题' },
        ],
      }),
    ).toBeUndefined();
  });

  it('rejects a batch missing an id or a question', () => {
    expect(dshQuestionsOf({ questions: [{ question: '无 id' }] })).toBeUndefined();
    expect(dshQuestionsOf({ questions: [{ id: 'a' }] })).toBeUndefined();
    expect(dshQuestionsOf({ questions: [] })).toBeUndefined();
    expect(dshQuestionsOf({})).toBeUndefined();
  });

  it('keeps the question detail and detects a timed wait', () => {
    // plan-review 提问的计划全文在 detail 里，必须随解析保留。
    expect(dshQuestionsOf({ questions: [{ id: 'a', question: 'Q', detail: '# 计划' }] })).toEqual([
      { id: 'a', question: 'Q', detail: '# 计划' },
    ]);
    expect(isTimedQuestionRequest({ questions: [], wait: { callId: 'c', timed: true } })).toBe(
      true,
    );
    // legacy blocking 提问没有 wait 字段，卡片必须照常展示。
    expect(isTimedQuestionRequest({ questions: [] })).toBe(false);
    expect(isTimedQuestionRequest({ questions: [], wait: { callId: 'c' } })).toBe(false);
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

  it('surfaces control projections as run_status and fills result.usage.context_limit', async () => {
    server = new FakeDshServer();
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setControlFrames([
      {
        type: 'baseline',
        value: {
          projections: {
            [SID]: {
              asOfSeq: 0,
              values: {
                contextPressure: {
                  pressureTokens: 12_000,
                  projectedTokens: 12_500,
                  contextWindow: 100_000,
                },
                sessionStats: { turns: 1, steps: 7, toolMs: 1_500 },
              },
            },
            // 别的会话的投影必须被过滤掉，不能串到本 run 的状态行。
            'session-other': {
              asOfSeq: 0,
              values: { contextPressure: { projectedTokens: 99_000, contextWindow: 100_000 } },
            },
          },
        },
      },
    ]);
    server.setMuxFrames([
      sessionEventFrame(SID, textChunk('working', 1)),
      // context_limit 挂在 usage 上（DSH 的会话读取端不产出上限），
      // 所以这一 turn 必须有采样记录。
      sessionEventFrame(SID, usageMessage({ inputTokens: 20, outputTokens: 5 }, 2)),
      sessionEventFrame(SID, turnEnd('completed', 3)),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD }));

    // baseline 里 contextPressure / sessionStats 是两帧，逐帧产出事件；
    // 末帧携带合并后的完整状态（卡片侧 reducer 同样逐帧合并）。
    const statuses = events.filter((e) => e.type === 'run_status');
    expect(statuses).toHaveLength(2);
    // 官方口径：projectedTokens 优先；steps 来自 sessionStats。
    expect(statuses[1]).toMatchObject({
      type: 'run_status',
      contextUsed: 12_500,
      contextLimit: 100_000,
      steps: 7,
    });

    const result = events.find((e) => e.type === 'result');
    expect(result?.type === 'result' && result.usage?.context_limit).toBe(100_000);
  });

  it('reports only still-running background jobs at turn end', async () => {
    server = new FakeDshServer();
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setJobRows([
      { id: 'bash-1', kind: 'bash', label: 'npm run dev', status: 'running', startedAt: 1 },
      { id: 'bash-2', kind: 'bash', label: 'old build', status: 'completed', startedAt: 1 },
      { id: 'bash-3', kind: 'bash', label: 'stopping now', status: 'stopping', startedAt: 1 },
    ]);
    server.setMuxFrames([
      sessionEventFrame(SID, textChunk('started', 1)),
      sessionEventFrame(SID, turnEnd('completed', 2)),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    const jobs = events.find((e) => e.type === 'background_jobs');
    // 已完成的任务不进卡片（列出来会被读成"还在跑"）。
    expect(jobs).toMatchObject({
      type: 'background_jobs',
      jobs: [
        { id: 'bash-1', label: 'npm run dev', status: 'running' },
        { id: 'bash-3', label: 'stopping now', status: 'stopping' },
      ],
    });
    expect(events.findIndex((e) => e.type === 'background_jobs')).toBeLessThan(
      events.findIndex((e) => e.type === 'result'),
    );
  });

  it('omits the background-jobs event when the roster is unavailable or empty', async () => {
    server = new FakeDshServer();
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setJobRows([]);
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    expect(events.find((e) => e.type === 'background_jobs')).toBeUndefined();
  });

  it('result usage sums a multi-step turn instead of reporting the last sampling', async () => {
    server = new FakeDshServer();
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    const step2 = { inputTokens: 40, outputTokens: 30, cacheReadTokens: 5100 };
    server.setMuxFrames([
      sessionEventFrame(
        SID,
        usageMessage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000 }, 1),
      ),
      sessionEventFrame(SID, usageMessage(step2, 2)),
      // 同一步的 live usage chunk：与 durable 事件同值，不得再加一次。
      {
        type: 'assistant-stream',
        frame: { type: 'chunk', attemptId: 'attempt-2', chunk: { type: 'usage', usage: step2 } },
      },
      sessionEventFrame(
        SID,
        usageMessage({ inputTokens: 12, outputTokens: 60, cacheReadTokens: 5200 }, 3),
      ),
      sessionEventFrame(SID, turnEnd('completed', 4)),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('iterate', { cwd: CWD }));
    const result = events.find((e) => e.type === 'result');
    expect(result?.type === 'result' && result.usage).toMatchObject({
      input_tokens: 152,
      output_tokens: 110,
      cache_read_tokens: 15_300,
      total_tokens: 152 + 110 + 15_300,
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

  it('passes the configured provider to selectModel', async () => {
    server = new FakeDshServer();
    let selectPayload: unknown;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/selectModel', (p) => {
      selectPayload = p;
      return {
        ok: true,
        value: {
          selected: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
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
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    await collect(runner.run('hi', { cwd: CWD }));

    expect(selectPayload).toEqual({
      sessionId: SID,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('resolves a provider-only config to that provider default model', async () => {
    server = new FakeDshServer();
    let selectPayload: unknown;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/modelCatalog', () => ({
      ok: true,
      value: {
        default: {
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
        },
        groups: [
          {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-flash', name: 'Flash' }],
          },
          {
            id: 'anthropic',
            name: 'anthropic',
            models: [
              {
                id: 'claude-sonnet-4-5',
                name: 'Sonnet',
                reasoning: {
                  efforts: [
                    { id: 'low', name: 'low' },
                    { id: 'high', name: 'high' },
                    { id: 'max', name: 'max' },
                  ],
                  defaultEffort: 'high',
                },
              },
            ],
          },
        ],
        failures: [],
      },
    }));
    server.register('session/selectModel', (p) => {
      selectPayload = p;
      return {
        ok: true,
        value: { selected: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      provider: 'anthropic',
      reasoningEffort: 'max',
    });
    await collect(runner.run('hi', { cwd: CWD }));

    expect(selectPayload).toEqual({
      sessionId: SID,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'max',
    });
  });

  it('drops an effort the provider default model does not support', async () => {
    server = new FakeDshServer();
    let selectPayload: Record<string, unknown> | undefined;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/modelCatalog', () => ({
      ok: true,
      value: {
        default: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        groups: [
          {
            id: 'anthropic',
            name: 'anthropic',
            models: [
              {
                id: 'claude-sonnet-4-5',
                name: 'Sonnet',
                reasoning: {
                  efforts: [
                    { id: 'low', name: 'low' },
                    { id: 'high', name: 'high' },
                  ],
                },
              },
            ],
          },
        ],
        failures: [],
      },
    }));
    server.register('session/selectModel', (p) => {
      selectPayload = p as Record<string, unknown>;
      return {
        ok: true,
        value: { selected: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      };
    });
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      provider: 'anthropic',
      reasoningEffort: 'off',
    });
    await collect(runner.run('hi', { cwd: CWD }));

    expect(selectPayload).toEqual({
      sessionId: SID,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('fails closed when a provider-only config names an unavailable provider', async () => {
    server = new FakeDshServer();
    let prompted = false;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/modelCatalog', () => ({
      ok: true,
      value: {
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        groups: [
          {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-flash', name: 'Flash' }],
          },
        ],
        failures: [],
      },
    }));
    server.register('session/prompt', () => {
      prompted = true;
      return { ok: true, value: { accepted: true } };
    });
    server.setMuxFrames([sessionEventFrame(SID, turnEnd('completed', 1))]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      provider: 'anthropic',
    });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    const result = events.find((event) => event.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain(
      '在 DSH 模型目录中不可用',
    );
    expect(prompted).toBe(false);
  });

  it('fails closed when an explicit provider cannot be aligned', async () => {
    server = new FakeDshServer();
    let prompted = false;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('session/selectModel', () => ({
      ok: false,
      error: { code: 'session/model-unavailable', message: 'Select an available model' },
    }));
    server.register('session/prompt', () => {
      prompted = true;
      return { ok: true, value: { accepted: true } };
    });
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const events = await collect(runner.run('hi', { cwd: CWD }));
    const result = events.find((event) => event.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain(
      'Provider "anthropic" 的模型对齐失败',
    );
    expect(result?.type === 'result' ? result.errorMessage : '').toContain('DSH Web UI');
    expect(prompted).toBe(false);
  });

  it('legacy model-only selectModel failure only warns and does not block the run', async () => {
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

  it('applies permissionPreset once before prompt via commands/execute', async () => {
    server = new FakeDshServer();
    let promptCount = 0;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('commands/execute', () => ({
      ok: true,
      value: { commandId: 'cmd-1', result: { kind: 'success' } },
    }));
    server.register('session/prompt', () => {
      promptCount += 1;
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', promptCount)));
      return { ok: true, value: { accepted: true } };
    });
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      permissionPreset: 'workspace-write',
    });
    await collect(runner.run('first', { cwd: CWD }));
    await collect(runner.run('second', { cwd: CWD, sessionId: SID }));

    const permissionCalls = server.requests.filter((r) => r.method === 'commands/execute');
    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0].payload).toEqual({
      agentId: SID,
      line: '/permission workspace-write',
      submittedAttachments: [],
    });
    const methods = server.requests.map((r) => r.method);
    expect(methods.indexOf('commands/execute')).toBeLessThan(methods.indexOf('session/prompt'));
  });

  it('fails closed when the permission preset cannot be applied', async () => {
    server = new FakeDshServer();
    let prompted = false;
    server.register('commands/execute', () => ({
      ok: true,
      value: { result: { kind: 'error', text: 'unknown preset' } },
    }));
    server.register('session/prompt', () => {
      prompted = true;
      return { ok: true, value: { accepted: true } };
    });
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      permissionPreset: 'not-a-preset',
    });
    const events = await collect(runner.run('hi', { cwd: CWD, sessionId: SID }));
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain('unknown preset');
    expect(prompted).toBe(false);
  });

  it('updateApprovalMode re-aligns the preset on the next run', async () => {
    server = new FakeDshServer();
    let promptCount = 0;
    server.register('session/create', () => ({ ok: true, value: { sessionId: SID } }));
    server.register('commands/execute', () => ({
      ok: true,
      value: { commandId: 'cmd-1', result: { kind: 'success' } },
    }));
    server.register('session/prompt', () => {
      promptCount += 1;
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', promptCount)));
      return { ok: true, value: { accepted: true } };
    });
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
      permissionPreset: 'workspace-write',
    });
    await collect(runner.run('first', { cwd: CWD }));
    await runner.updateApprovalMode({ permissionPreset: 'read-only' });
    await collect(runner.run('second', { cwd: CWD, sessionId: SID }));

    const lines = server.requests
      .filter((r) => r.method === 'commands/execute')
      .map((r) => (r.payload as { line?: string }).line);
    expect(lines).toEqual(['/permission workspace-write', '/permission read-only']);
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

  it('falls back to an assistant prompt when the live approval channel is unavailable', async () => {
    server = new FakeDshServer();
    server.setEventStreamError('gateway/interactions-forbidden');
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

  it.each([
    ['accept', 'allowed-once'],
    ['decline', 'rejected'],
  ] as const)(
    'maps a DSH sandbox escalation to a Feishu approval and answers %s',
    async (action, expected) => {
      server = new FakeDshServer();
      let approval: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
      server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
      server.register('$events/result', () => {
        server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 3)));
        return { ok: true, value: undefined };
      });
      server.setEventFrames([
        {
          type: 'waterfall',
          event: 'approval/request',
          eventId: 'evt-1',
          agentId: SID,
          request: {
            toolName: 'bash',
            callId: 'call-1',
            reason: 'escalate sandbox to danger-full-access',
          },
        },
      ]);
      server.setMuxFrames([
        sessionEventFrame(SID, toolCall('call-1', 'bash', { command: 'echo hi' }, 1)),
        sessionEventFrame(
          SID,
          approvalAsked('appr-1', 'call-1', 'bash', 'escalate sandbox to danger-full-access', 2),
        ),
      ]);
      await server.start();

      const runner = new DshRunner({
        kind: 'dsh',
        sessionReader: stubReader,
        host: server.baseUrl,
      });
      const events: AgentEvent[] = [];
      const runPromise = (async () => {
        for await (const ev of runner.run('hi', { cwd: CWD, sessionId: SID })) {
          events.push(ev);
          if (ev.type === 'approval_requested') approval = ev;
        }
      })();

      await waitFor(() => approval !== undefined);
      await sleep(50);
      if (!approval) throw new Error('approval was not surfaced');
      await runner.respondApproval(approval.requestId, { action });
      await runPromise;

      expect(approval).toMatchObject({
        type: 'approval_requested',
        requestId: 'appr-1',
        kind: 'command',
        view: {
          requestId: 'appr-1',
          command: 'echo hi',
          commandCwd: CWD,
          reason: 'escalate sandbox to danger-full-access',
          availableDecisions: ['accept', 'decline'],
          note: expect.stringContaining('仅放行这一次调用'),
        },
      });
      const answer = server.requests.find((r) => r.method === '$events/result');
      expect(answer?.payload).toMatchObject({
        clientId: expect.stringMatching(/^fake-client-/),
        eventId: 'evt-1',
        outcome: { kind: 'result', value: expected },
      });
      expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
    },
  );

  it('delegates a waterfall for another session with next', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 1)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-other',
        agentId: 'other-session',
        request: { toolName: 'bash', reason: 'other workspace' },
      },
    ]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
    });
    const events = await collect(runner.run('hi', { cwd: CWD, sessionId: SID }));
    await waitFor(() => server.requests.some((r) => r.method === '$events/result'));

    expect(events.some((e) => e.type === 'approval_requested')).toBe(false);
    const answer = server.requests.find((r) => r.method === '$events/result');
    expect(answer?.payload).toMatchObject({
      clientId: expect.stringMatching(/^fake-client-/),
      eventId: 'evt-other',
      outcome: { kind: 'next' },
    });
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('removes the Feishu approval when the Host resolves it elsewhere', async () => {
    server = new FakeDshServer();
    let approvalId: string | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setEventFrames([
      {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-1',
        agentId: SID,
        request: { toolName: 'bash', callId: 'call-1', reason: 'escalate' },
      },
    ]);
    server.setMuxFrames([
      sessionEventFrame(SID, toolCall('call-1', 'bash', { command: 'echo hi' }, 1)),
      sessionEventFrame(SID, approvalAsked('appr-1', 'call-1', 'bash', 'escalate', 2)),
    ]);
    await server.start();

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: server.baseUrl,
    });
    const events: AgentEvent[] = [];
    const runPromise = (async () => {
      for await (const ev of runner.run('hi', { cwd: CWD, sessionId: SID })) {
        events.push(ev);
        if (ev.type === 'approval_requested') approvalId = ev.requestId;
      }
    })();

    await waitFor(() => approvalId !== undefined);
    await sleep(50);
    server.pushEventFrame({ type: 'cancel', eventId: 'evt-1' });
    await waitFor(() => events.some((e) => e.type === 'approval_resolved'));
    server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 3)));
    await runPromise;

    expect(events.some((e) => e.type === 'approval_resolved' && e.requestId === 'appr-1')).toBe(
      true,
    );
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('surfaces a DSH ask_user_question prompt and answers it by option label', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-1', [
        {
          id: 'next',
          header: '下一步',
          question: NEXT_STEP_QUESTION,
          multiSelect: false,
          options: [{ label: '只修 P1', description: '修 1-7' }, { label: '先不改' }],
        },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events: AgentEvent[] = [];
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        events.push(ev);
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    if (!question) throw new Error('question was not surfaced');
    expect(question).toMatchObject({
      type: 'approval_requested',
      requestId: 'q-1',
      kind: 'question',
      timeoutMs: 30 * 60 * 1000,
      view: {
        requestId: 'q-1',
        kind: 'question',
        questions: [
          {
            id: 'next',
            header: '下一步',
            question: NEXT_STEP_QUESTION,
            options: [{ label: '只修 P1', description: '修 1-7' }, { label: '先不改' }],
          },
        ],
      },
    });

    await runner.respondApproval('q-1', {
      action: 'answer',
      answers: { [NEXT_STEP_QUESTION]: '只修 P1' },
    });
    await runPromise;

    const answer = server.requests.find((r) => r.method === '$events/result');
    expect(answer?.payload).toMatchObject({
      clientId: expect.stringMatching(/^fake-client-/),
      eventId: 'q-1',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'next', selected: ['只修 P1'] }] },
      },
    });
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('maps a free-text question answer to custom instead of an option label', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-custom', [
        {
          id: 'next',
          question: NEXT_STEP_QUESTION,
          options: [{ label: '只修 P1' }],
        },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    await runner.respondApproval('q-custom', {
      action: 'answer',
      answers: { [NEXT_STEP_QUESTION]: '我自己处理' },
    });
    await runPromise;

    const answer = server.requests.find((r) => r.method === '$events/result');
    expect(answer?.payload).toMatchObject({
      eventId: 'q-custom',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'next', selected: [], custom: '我自己处理' }] },
      },
    });
  });

  it('treats the skip button as an empty answer batch', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-skip', [
        { id: 'a', question: '问题一', options: [{ label: '选项一' }] },
        { id: 'b', question: '问题二', multiSelect: true, options: [{ label: '选项二' }] },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    await runner.respondApproval('q-skip', { action: 'decline' });
    await runPromise;

    const answer = server.requests.find((r) => r.method === '$events/result');
    expect(answer?.payload).toMatchObject({
      eventId: 'q-skip',
      outcome: {
        kind: 'result',
        value: {
          answers: [
            { id: 'a', selected: [] },
            { id: 'b', selected: [] },
          ],
        },
      },
    });
  });

  it('delegates a timed-out question with next without cancelling the turn', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => ({ ok: true, value: undefined }));
    server.setEventFrames([
      questionWaterfall('q-timeout', [
        { id: 'next', question: NEXT_STEP_QUESTION, options: [{ label: '只修 P1' }] },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    await runner.respondApproval('q-timeout', { action: 'cancel' });
    await waitFor(() => server.requests.some((r) => r.method === '$events/result'));

    // 交回应答权：不中断 turn，也不发 session/cancel（Web UI 仍可回答）。
    expect(server.requests.some((r) => r.method === 'session/cancel')).toBe(false);
    expect(server.requests.find((r) => r.method === '$events/result')?.payload).toMatchObject({
      eventId: 'q-timeout',
      outcome: { kind: 'next' },
    });

    server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
    await runPromise;
  });

  it('removes the Feishu question when the Host resolves it elsewhere', async () => {
    server = new FakeDshServer();
    let questionId: string | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setEventFrames([
      questionWaterfall('q-answered-elsewhere', [
        { id: 'next', question: NEXT_STEP_QUESTION, options: [{ label: '只修 P1' }] },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events: AgentEvent[] = [];
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        events.push(ev);
        if (ev.type === 'approval_requested') questionId = ev.requestId;
      }
    })();

    await waitFor(() => questionId !== undefined);
    server.pushEventFrame({ type: 'cancel', eventId: 'q-answered-elsewhere' });
    await waitFor(() =>
      events.some((e) => e.type === 'approval_resolved' && e.requestId === 'q-answered-elsewhere'),
    );
    server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
    await runPromise;

    expect(
      events.some((e) => e.type === 'approval_resolved' && e.requestId === 'q-answered-elsewhere'),
    ).toBe(true);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('delegates a question batch with duplicate texts to the Web UI', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-dup', [
        { id: 'a', question: '同名问题' },
        { id: 'b', question: '同名问题' },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('review', { cwd: CWD, sessionId: SID }));
    await waitFor(() => server.requests.some((r) => r.method === '$events/result'));

    expect(events.some((e) => e.type === 'approval_requested')).toBe(false);
    expect(server.requests.find((r) => r.method === '$events/result')?.payload).toMatchObject({
      eventId: 'q-dup',
      outcome: { kind: 'next' },
    });
  });

  it('delegates another session question with next', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-other', [{ id: 'next', question: '别的会话的问题' }], 'other-session'),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('review', { cwd: CWD, sessionId: SID }));
    await waitFor(() => server.requests.some((r) => r.method === '$events/result'));

    expect(events.some((e) => e.type === 'approval_requested')).toBe(false);
    expect(server.requests.find((r) => r.method === '$events/result')?.payload).toMatchObject({
      eventId: 'q-other',
      outcome: { kind: 'next' },
    });
  });

  it('carries the question detail (plan review) into the card view', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-plan', [
        {
          id: 'plan-review',
          header: 'Plan review',
          question: 'Approve this plan and leave plan mode?',
          detail: '# 计划\n\n1. 改 A\n2. 跑测试',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    if (!question) throw new Error('question was not surfaced');
    // plan-review 提问把计划全文放在 detail：丢在 runner 侧就成了「看不见计划就批准」。
    expect(question.view.questions?.[0]?.detail).toContain('1. 改 A');

    await runner.respondApproval('q-plan', { action: 'decline' });
    await runPromise;
  });

  it('answers a multi-select question with every selected label', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-multi', [
        {
          id: 'pick',
          question: '选哪些？',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        },
      ]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    if (!question) throw new Error('question was not surfaced');
    expect(question.view.questions?.[0]?.multiSelect).toBe(true);

    await runner.respondApproval('q-multi', {
      action: 'answer',
      answers: { '选哪些？': ['A', 'C'] },
    });
    await runPromise;

    expect(server.requests.find((r) => r.method === '$events/result')?.payload).toMatchObject({
      eventId: 'q-multi',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'pick', selected: ['A', 'C'] }] },
      },
    });
  });

  it('treats a multi-select question without options as a free-text answer', async () => {
    server = new FakeDshServer();
    let question: Extract<AgentEvent, { type: 'approval_requested' }> | undefined;
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall('q-free', [{ id: 'note', question: '补充说明', multiSelect: true }]),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') question = ev;
      }
    })();

    await waitFor(() => question !== undefined);
    if (!question) throw new Error('question was not surfaced');
    // 无选项的多选在卡片上没有可勾内容：必须按自由文本题渲染，否则
    // coordinator 的 answerCustom 会拒绝它（用户只剩「跳过」）。
    expect(question.view.questions?.[0]?.multiSelect).toBeUndefined();

    await runner.respondApproval('q-free', { action: 'answer', answers: { 补充说明: '我自己来' } });
    await runPromise;

    expect(server.requests.find((r) => r.method === '$events/result')?.payload).toMatchObject({
      eventId: 'q-free',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'note', selected: [], custom: '我自己来' }] },
      },
    });
  });

  it('delegates a timed question to the Web UI instead of showing a card', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    server.setEventFrames([
      questionWaterfall(
        'q-timed',
        [{ id: 'next', question: NEXT_STEP_QUESTION, options: [{ label: '只修 P1' }] }],
        SID,
        // Timed asks settle at their own foreground deadline; a card answer
        // outside that window can never land, so the Web UI keeps them.
        { wait: { callId: 'call-timed-1', timed: true } },
      ),
    ]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.run('review', { cwd: CWD, sessionId: SID }));
    await waitFor(() => server.requests.some((r) => r.method === '$events/result'));

    expect(events.some((e) => e.type === 'approval_requested')).toBe(false);
    expect(server.requests.find((r) => r.method === '$events/result')?.payload).toMatchObject({
      eventId: 'q-timed',
      outcome: { kind: 'next' },
    });
  });

  it('answers a re-delivered question on the current $events stream', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.register('$events/result', () => {
      server.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      return { ok: true, value: undefined };
    });
    const waterfall = () =>
      questionWaterfall('q-redeliver', [
        { id: 'next', question: NEXT_STEP_QUESTION, options: [{ label: '只修 P1' }] },
      ]);
    server.setEventFrames([waterfall()]);
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const seen: string[] = [];
    const runPromise = (async () => {
      for await (const ev of runner.run('review', { cwd: CWD, sessionId: SID })) {
        if (ev.type === 'approval_requested') seen.push(String(ev.requestId));
      }
    })();

    await waitFor(() => seen.length === 1);
    // Host drops `$events`; the reconnect replays the still-pending waterfall
    // with a fresh clientId (api-gateway replays pending events to new clients).
    server.pushEventFrame({ close: true });
    server.pushEventFrame(waterfall());
    // 重连有 200ms 退避 + 建连开销，默认 1s 轮询窗口太紧。
    await waitFor(() => seen.length === 2, 3000);
    expect(seen).toEqual(['q-redeliver', 'q-redeliver']);

    const currentClientId = server.lastEventClientId;
    expect(currentClientId).toBeDefined();
    await runner.respondApproval('q-redeliver', {
      action: 'answer',
      answers: { [NEXT_STEP_QUESTION]: '只修 P1' },
    });
    await runPromise;

    const answer = server.requests.find((r) => r.method === '$events/result');
    expect(answer?.payload).toMatchObject({
      clientId: currentClientId,
      eventId: 'q-redeliver',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'next', selected: ['只修 P1'] }] },
      },
    });
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

  it('queued prompt stays on its own turn instead of ending on the turn it queues behind', async () => {
    // 验证什么：agent 忙时 DSH 会受理 prompt 并排队（mode:'queue'），follow
    // 快照先送来的是「正在跑的 turn」的尾巴和它的 turn/end。run 若在这里收尾，
    // 卡片会在自己的 turn 开始前显示「已完成」——用户据此点 Compact，DSH 以
    // agent 不空闲拒绝。run 必须丢掉 foreign 尾巴，等自己 rpcId 的 user/message。
    const srv = new FakeDshServer();
    server = srv;
    srv.setAutoPromptMessage(false);
    srv.register('session/prompt', (payload) => {
      const { requestId } = payload as { requestId: string };
      srv.pushMuxFrame(sessionEventFrame(SID, textChunk('previous turn tail ', 1)));
      srv.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 2)));
      srv.pushMuxFrame(sessionEventFrame(SID, promptMessage(requestId, 3)));
      srv.pushMuxFrame(sessionEventFrame(SID, textChunk('queued answer ', 4)));
      srv.pushMuxFrame(sessionEventFrame(SID, turnEnd('completed', 5)));
      return { ok: true, value: { accepted: true } };
    });
    await srv.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: srv.baseUrl });
    const events = await collect(runner.run('queued', { cwd: CWD, sessionId: SID }));

    const texts = events
      .filter((e) => e.type === 'assistant')
      .map((e) => e.message.content.find((c) => c.type === 'text'))
      .filter((c): c is { type: 'text'; text: string } => !!c)
      .map((c) => c.text);

    expect(texts).toEqual(['queued answer ']);
    expect(texts.join('')).not.toContain('previous turn tail');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('compact precheck refuses a session whose newest event is mid-turn', async () => {
    // 验证什么：桥接重启后内存里没有在途 run，但 DSH 服务端可能还在跑上一轮。
    // runCompact 用只读探测兜底（session/projections 水位 + session/page 末条），
    // 末条是 turn 内事件就直接给明确原因，不把注定被拒的命令发出去。
    server = new FakeDshServer();
    let commandCalled = false;
    server.register('commands/execute', () => {
      commandCalled = true;
      return { ok: true, value: { kind: 'success', text: 'Compacted 1 history item.' } };
    });
    server.setProjectionValue({ asOfSeq: 12, values: {} });
    server.setHistoryValue({
      records: [
        {
          type: 'event',
          event: {
            type: 'step/start',
            seq: 12,
            time: 1700000000000,
            data: { turn: 3, step: 2 },
          },
        },
      ],
      hasMore: false,
    });
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.runCompact('', { cwd: CWD, sessionId: SID }));

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain('还有一轮在跑');
    expect(commandCalled).toBe(false);
  });

  it('compact precheck proceeds when the newest event is a turn end', async () => {
    // 验证什么：末条是 turn/end 说明服务端空闲，探测必须放行而不是误拒。
    server = new FakeDshServer();
    server.register('commands/execute', () => ({
      ok: true,
      value: { kind: 'success', text: 'Compacted 2 history items.' },
    }));
    server.setProjectionValue({ asOfSeq: 4, values: {} });
    server.setHistoryValue({
      records: [{ type: 'event', event: turnEnd('completed', 4) }],
      hasMore: false,
    });
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.runCompact('', { cwd: CWD, sessionId: SID }));

    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
  });

  it('compact executes /compact through commands/execute and finishes success', async () => {
    // 验证什么：DSH 的压缩走 commands/execute（不是 session/prompt）——后者会把
    // 文本当普通 user message 交给模型，永远压不了上下文。
    server = new FakeDshServer();
    let commandPayload: unknown;
    server.register('commands/execute', (p) => {
      commandPayload = p;
      return {
        ok: true,
        value: { kind: 'success', text: 'Compacted 12 history items (~34000 tokens).' },
      };
    });
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.runCompact('', { cwd: CWD, sessionId: SID }));

    expect(commandPayload).toEqual({
      agentId: SID,
      line: '/compact',
      submittedAttachments: [],
    });
    expect(events.find((e) => e.type === 'system')).toMatchObject({
      subtype: 'init',
      session_id: SID,
    });
    const text = events
      .filter((e) => e.type === 'assistant')
      .flatMap((e) => (e.type === 'assistant' ? e.message.content : []))
      .find((c) => c.type === 'text') as { text: string } | undefined;
    expect(text?.text).toContain('Compacted 12 history items');
    expect(events.find((e) => e.type === 'result')).toMatchObject({ subtype: 'success' });
    // 压缩不得经过 prompt（DSH 侧只会把它当模型输入）。
    expect(server.requests.some((r) => r.method === 'session/prompt')).toBe(false);
  });

  it("compact maps DSH command kind:'error' to an error result", async () => {
    // 验证什么：busy / 无历史 / 摘要失败是 DSH 的「预期拒绝」，返回 value.kind='error'
    // 而不是 RPC 错误；卡片终态必须跟着它变 error，不能显示成功。
    server = new FakeDshServer();
    server.register('commands/execute', () => ({
      ok: true,
      value: {
        kind: 'error',
        text: 'Compaction is unavailable because this process has an active compaction.',
      },
    }));
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.runCompact('', { cwd: CWD, sessionId: SID }));

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain(
      'Compaction is unavailable',
    );
  });

  it('compact reports an admission miss (no such command) as an error result', async () => {
    // 验证什么：命令未注册时 commands/execute 返回 ok:true 无 value（admission
    // miss，什么都没执行）；不能把「没压」当成「压完了」。
    server = new FakeDshServer();
    server.register('commands/execute', () => ({ ok: true, value: undefined }));
    await server.start();

    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });
    const events = await collect(runner.runCompact('', { cwd: CWD, sessionId: SID }));

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ subtype: 'error' });
    expect(result?.type === 'result' ? result.errorMessage : '').toContain('/compact');
  });

  it('compact requires a sessionId', async () => {
    server = new FakeDshServer();
    await server.start();
    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });

    await expect(collect(runner.runCompact('', { cwd: CWD }))).rejects.toThrow(
      'compact requires a sessionId',
    );
  });

  it('compact rejects when a turn already owns the runner', async () => {
    server = new FakeDshServer();
    server.register('session/prompt', () => ({ ok: true, value: { accepted: true } }));
    server.setMuxFrames([sessionEventFrame(SID, textChunk('partial', 1))]);
    await server.start();
    const runner = new DshRunner({ kind: 'dsh', sessionReader: stubReader, host: server.baseUrl });

    const iterator = runner.run('hi', { cwd: CWD, sessionId: SID })[Symbol.asyncIterator]();
    await iterator.next();
    await expect(collect(runner.runCompact('', { cwd: CWD, sessionId: SID }))).rejects.toThrow(
      'already running',
    );
    await runner.stop({ immediate: true });
    await iterator.return?.();
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
    // create 不跟随 run abort（abort 会丢掉刚建的 sessionId），而是落定后在后台补
    // cancel：/stop 立即释放队列，孤儿 session 仍会被收起。
    expect(await waitFor(() => cancelCalled, 2000)).toBe(true);
    expect(promptCalled).toBe(false);
  });

  it('test_anchor_dsh_stop_with_hung_unary_releases_run', async () => {
    // 服务接受连接但不返回任何 unary 响应时，stop() 必须让 run 结束，
    // 否则 workspace 串行队列被永久占住。fetchImpl 永不 resolve，只在 abort 时
    // reject（模拟真实 fetch 的 AbortSignal 行为）。
    const fetchImpl = ((url: string, init?: { signal?: AbortSignal }) => {
      // cancel 照常应答（服务端还能处理控制请求），其余 unary 永不返回。
      if (String(url).endsWith('/api/session/cancel')) {
        return Promise.resolve(
          new Response(JSON.stringify({ result: { ok: true, value: { accepted: true } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }) as unknown as typeof fetch;

    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: 'http://127.0.0.1:1',
      credentialsFile: NO_CREDENTIALS_FILE,
      fetchImpl,
    });

    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of runner.run('hi', { cwd: CWD, sessionId: SID })) {
        events.push(ev);
      }
    })();

    // 等 run 进入 unary 挂起（synthetic init 已产出）。
    expect(await waitFor(() => events.some((e) => e.type === 'system'), 2000)).toBe(true);
    await runner.stop({ immediate: true });

    // stop 后必须收尾（不能等 60s 超时）：generator 结束 + interrupted result。
    expect(await waitFor(() => !runner.isRunning, 2000)).toBe(true);
    await done;
    expect(events.find((e) => e.type === 'result')).toMatchObject({
      subtype: 'interrupted',
    });
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
    expect(info.provider).toBe('deepseek-official');
    expect(info.extras?.host).toBe('http://127.0.0.1:3080');
  });

  it('getStatusInfo includes preset/model/reasoning when configured', () => {
    const runner = new DshRunner({
      kind: 'dsh',
      sessionReader: stubReader,
      host: 'http://127.0.0.1:3080',
      agentPreset: 'code',
      permissionPreset: 'workspace-write',
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    });
    const info = runner.getStatusInfo();
    expect(info.model).toBe('deepseek-v4-pro');
    expect(info.provider).toBe('anthropic');
    expect(info.extras).toEqual({
      host: 'http://127.0.0.1:3080',
      preset: 'code',
      permissionPreset: 'workspace-write',
      reasoning: 'max',
    });
  });
});
