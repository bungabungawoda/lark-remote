/**
 * 跨 agent 回归：最终回答在 run 卡里必须完整。
 *
 * 缺陷：状态层对进度正文有 `MAX_TEXT_CHARS`（12000 字符）窗口，
 * 回答超过窗口时 blocks 里只剩尾部 + `…（前 N 字符已省略）`，而「回答优先」
 * 渲染提上去的正是这条残片——16,074 字符的回答在卡片里只剩后 12,000 字符，
 * 且是从中间开始的。修复后「最新一条 text 块」不受窗口约束（`capStaleTextBlocks`）。
 *
 * 为什么逐个 agent 跑真实 translator：回答**从哪个通道来**正是各家差异所在，
 * 手搓 AgentEvent 只能测到 reducer 本身。
 *   claude   assistant 完整消息（ClaudeSession 原样透传）
 *   codex    协议 `final_answer` 事件（topic: item/completed phase）
 *   opencode ACP `agent_message_chunk` 增量 delta
 *   kimi     ACP `agent_message_chunk` → turn_diff 全文快照
 *   pi       `message_end` 完整消息
 *   dsh      live text-delta + durable `assistant/message` 全文
 */
import { describe, expect, it } from 'vitest';
import { createInitialRunState, finishRun, reduceRunState, type RunState } from './run-state.js';
import { renderRunCardDetailed } from './run-renderer.js';
import { CARD_BUDGET_BYTES } from './text-truncate.js';
import type { AgentEvent } from '../runner/types.js';
import { CodexAppServerTranslator } from '../runner/codex/app-server/translator.js';
import { PiRpcTranslator } from '../runner/pi/rpc/translator.js';
import { KimiAcpTranslator } from '../runner/kimi/acp/translator.js';
import { OpencodeAcpTranslator } from '../runner/opencode/acp/translator.js';
import { DshTranslator } from '../runner/dsh/translator.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';

const ANSWER_HEAD = 'ANSWER-HEAD:';
const ANSWER_TAIL = ':ANSWER-TAIL';
/** > MAX_TEXT_CHARS(12000)，且换算成字节仍能塞进一张 28KB 卡。 */
const ANSWER = `${ANSWER_HEAD}${'A'.repeat(20_000)}${ANSWER_TAIL}`;

/** 按 37 字符切块：贴近真实流式 delta（既不是单字符，也不是整块）。 */
function deltas(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 37) out.push(text.slice(i, i + 37));
  return out;
}

/** 各 agent 的真实事件流（translator 产出，不含手写 AgentEvent）。 */
function agentEvents(agent: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  const push = (event: unknown): void => {
    events.push(event as AgentEvent);
  };
  const init = (sessionId: string): void => {
    push({ type: 'system', subtype: 'init', session_id: sessionId, cwd: '/w', model: 'm' });
  };

  if (agent === 'claude') {
    // ClaudeSession.translateEvent 对 assistant 是原样透传（补 timestamp），
    // 所以这就是它实际发出的形状。
    init('claude-s');
    push({ type: 'assistant', message: { content: [{ type: 'text', text: ANSWER }] } });
    push({ type: 'result', subtype: 'success', session_id: 'claude-s' });
    return events;
  }

  if (agent === 'codex') {
    const translator = new CodexAppServerTranslator();
    const threadId = 'th';
    const turnId = 'tn';
    const itemId = 'item-1';
    init(threadId);
    for (const delta of deltas(ANSWER)) {
      translator
        .handleNotification('item/agentMessage/delta', { threadId, turnId, itemId, delta })
        .forEach(push);
    }
    translator
      .handleNotification('item/completed', {
        threadId,
        turnId,
        item: { id: itemId, type: 'agentMessage', text: ANSWER, phase: 'final_answer' },
        completedAtMs: 1,
      })
      .forEach(push);
    translator
      .handleNotification('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'completed', items: [] },
      })
      .forEach(push);
    return events;
  }

  if (agent === 'pi') {
    const translator = new PiRpcTranslator();
    translator.setSessionId('pi-s');
    init('pi-s');
    translator
      .handleEvent({ type: 'message_start', message: { role: 'assistant' } } as never)
      .forEach(push);
    translator
      .handleEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_start' },
      } as never)
      .forEach(push);
    for (const delta of deltas(ANSWER)) {
      translator
        .handleEvent({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta },
        } as never)
        .forEach(push);
    }
    translator
      .handleEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', content: ANSWER },
      } as never)
      .forEach(push);
    translator
      .handleEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop' },
      } as never)
      .forEach(push);
    push(translator.produceResultFromSettled());
    return events;
  }

  if (agent === 'dsh') {
    const translator = new DshTranslator();
    init('dsh-s');
    for (const delta of deltas(ANSWER)) {
      translator
        .streamFrameToAgentEvents(
          {
            type: 'chunk',
            attemptId: 'att',
            time: 1_793_542_800_000,
            chunk: { type: 'text-delta', index: 0, text: delta },
          } as never,
          'dsh-s',
        )
        .forEach(push);
    }
    // durable 消息通道（live 断线重连时它是唯一的全文来源）。
    translator
      .eventToAgentEvents(
        {
          type: 'assistant/message',
          seq: 1,
          time: 1_793_542_890_000,
          data: { message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] } },
        } as never,
        'dsh-s',
      )
      .forEach(push);
    translator
      .eventToAgentEvents(
        {
          type: 'turn/end',
          seq: 2,
          time: 1_793_542_890_100,
          data: { reason: { kind: 'completed' } },
        },
        'dsh-s',
      )
      .forEach(push);
    return events;
  }

  // opencode / kimi：ACP session/update 通道（delta 与快照的差异在 translator 内）
  const sessionId = `${agent}-s`;
  const translator = agent === 'kimi' ? new KimiAcpTranslator() : new OpencodeAcpTranslator();
  init(sessionId);
  translator.produceTurnStarted(sessionId, 'turn-1');
  for (const delta of deltas(ANSWER)) {
    translator
      .handleNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: delta },
        },
      })
      .forEach(push);
  }
  push(translator.handlePromptResponse(sessionId, { stopReason: 'end_turn' }));
  return events;
}

/** 输出面板正文（`💬 输出` 折叠面板里的 lark_md）。 */
function outputPanelContent(card: object): string {
  const elements =
    (card as { body?: { elements?: Record<string, unknown>[] } }).body?.elements ?? [];
  for (const element of elements) {
    if (element.tag !== 'collapsible_panel') continue;
    const header = element.header as { title?: { content?: string } } | undefined;
    if (!String(header?.title?.content ?? '').includes('输出')) continue;
    const inner = (element.elements as Record<string, unknown>[] | undefined)?.[0] as
      { text?: { content?: string } } | undefined;
    return inner?.text?.content ?? '';
  }
  return '';
}

function renderAgent(agent: string): { state: RunState; card: object; json: string } {
  let state = createInitialRunState(`run-${agent}`);
  for (const event of agentEvents(agent)) state = reduceRunState(state, event);
  state = finishRun(state, 'done');
  const { card } = renderRunCardDetailed(state, { agentKind: agent });
  return { state, card, json: JSON.stringify(card) };
}

describe('run card final answer completeness (all agents)', () => {
  for (const agent of ['claude', 'codex', 'opencode', 'kimi', 'pi', 'dsh']) {
    it(`keeps the whole answer for ${agent}`, () => {
      const { state, card, json } = renderAgent(agent);

      // 状态层：回答全文，不是存储窗口里的残片。
      expect(state.finalAnswer?.content).toBe(ANSWER);
      // 卡片：输出面板从第一字到最后一字，且没有省略标记。
      const content = outputPanelContent(card);
      expect(content).toContain(ANSWER_HEAD);
      expect(content).toContain(ANSWER_TAIL);
      expect(content).toBe(ANSWER);
      expect(json).not.toContain('字符已省略');
      // 排版：仍在一张卡内（超限要走溢出通道，而不是切正文）。
      expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
    });
  }
});

describe('run card progress omission hint', () => {
  it('does not claim "已省略 0 个早期步骤" when every progress group fits', () => {
    let state = createInitialRunState('run-omitted-zero');
    const events = [
      { type: 'system', subtype: 'init', session_id: 's', cwd: '/w', model: 'm' },
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'PROGRESS-THINKING' }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'SHORT-ANSWER' }] } },
      { type: 'result', subtype: 'success', session_id: 's' },
    ] as AgentEvent[];
    for (const event of events) state = reduceRunState(state, event);
    state = finishRun(state, 'done');
    expect(state.finalAnswer?.content).toBe('SHORT-ANSWER');
    // 进度组仍在：答案优先卡的预算循环会走到 start=0 的「全部保留」分支。
    expect(state.blocks.length).toBeGreaterThan(0);

    const { card } = renderRunCardDetailed(state, { agentKind: 'claude' });
    const json = JSON.stringify(card);
    expect(json).toContain('SHORT-ANSWER');
    expect(json).toContain('PROGRESS-THINKING');
    expect(json).not.toContain('个早期步骤');
    expectNoV1ActionContainer(json);
  });

  /** 16 个 4KB 思考组：答案优先卡的字节预算一定会裁掉其中一部分。 */
  function bigProgressState(omittedBlocks?: number): RunState {
    return {
      runId: 'run-omitted-n',
      terminal: 'done' as const,
      footer: null,
      sessionId: 's',
      resultSubtype: 'success' as const,
      ...(omittedBlocks === undefined ? {} : { omittedBlocks }),
      finalAnswer: {
        content: 'SHORT-ANSWER',
        timestamp: '2026-11-08T12:00:00.000Z',
        complete: true,
        source: 'protocol' as const,
      },
      blocks: Array.from({ length: 16 }, (_, i) => ({
        kind: 'thinking' as const,
        content: `思考${i}:` + 'X'.repeat(4_000),
        active: false,
        timestamp: `2026-11-08T11:${String(i).padStart(2, '0')}:00.000Z`,
      })),
    } as RunState;
  }

  function stepHints(json: string): string[] {
    return json.match(/已省略 \d+ 个早期步骤/g) ?? [];
  }

  it('still reports a non-zero count when early groups are actually dropped', () => {
    const { card } = renderRunCardDetailed(bigProgressState(), { agentKind: 'claude' });
    const json = JSON.stringify(card);
    const hints = stepHints(json);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/已省略 [1-9]\d* 个早期步骤/);
    expectNoV1ActionContainer(json);
  });

  it('merges MAX_BLOCKS and render-budget omissions into one count', () => {
    const { card } = renderRunCardDetailed(bigProgressState(24), { agentKind: 'claude' });
    const json = JSON.stringify(card);
    const hints = stepHints(json);
    expect(hints).toHaveLength(1);
    const total = Number(/已省略 (\d+) 个早期步骤/.exec(hints[0])![1]);
    // 24 个状态层丢弃的块 + 至少 1 个被渲染预算裁掉的组。
    expect(total).toBeGreaterThan(24);
    expect(total).toBeLessThanOrEqual(24 + 16);
    expectNoV1ActionContainer(json);
  });

  it('keeps a single state-level hint when no progress groups are trimmed', () => {
    const state = {
      runId: 'run-omitted-base-only',
      terminal: 'done' as const,
      footer: null,
      sessionId: 's',
      resultSubtype: 'success' as const,
      omittedBlocks: 24,
      finalAnswer: {
        content: 'SHORT-ANSWER',
        timestamp: '2026-11-08T12:00:00.000Z',
        complete: true,
        source: 'protocol' as const,
      },
      blocks: [
        {
          kind: 'thinking' as const,
          content: 'PROGRESS-THINKING',
          active: false,
          timestamp: '2026-11-08T11:00:00.000Z',
        },
      ],
    } as RunState;

    const { card } = renderRunCardDetailed(state, { agentKind: 'claude' });
    expect(stepHints(JSON.stringify(card))).toEqual(['已省略 24 个早期步骤']);
  });
});
