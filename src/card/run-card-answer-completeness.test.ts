/**
 * 跨 agent 回归：最终回答在 run 卡里必须完整。
 *
 * 缺陷（2026-11-01）：状态层对进度正文有 `MAX_TEXT_CHARS`（12000 字符）窗口，
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
