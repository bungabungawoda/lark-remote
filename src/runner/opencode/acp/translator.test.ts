import { describe, expect, it } from 'vitest';
import { OpencodeAcpTranslator } from './translator.js';
import {
  NotificationMethod,
  SessionEventType,
  ServerRequestMethod,
} from '../../common/acp/protocol-types.js';
import { createInitialRunState, reduceRunState } from '../../../card/run-state.js';
import type { AgentEvent, ApprovalRequestedEvent } from '../../types.js';

/**
 * Build a session/update notification params object using the REAL wire shape:
 * {sessionId, update: {sessionUpdate: '<kind>', ...}} (opencode
 * packages/opencode/src/acp/event.ts + service.ts, dev@1c965451b5).
 *
 * Test fixture data uses AABB UUIDs and /home/user/project paths
 * (CLAUDE.md red line: no real user data in test fixtures).
 */
function sessionUpdate(
  sessionId: string,
  update: { sessionUpdate: string; [key: string]: unknown },
) {
  return {
    sessionId,
    update,
  };
}

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

describe('OpencodeAcpTranslator', () => {
  it('maps agent_message_chunk content.text delta DIRECTLY to assistant/text (incremental channel, no accumulation)', () => {
    // opencode event.ts:231-258 handlePartDelta sends props.delta verbatim —
    // the translator must NOT accumulate; each chunk is one assistant event.
    const t = new OpencodeAcpTranslator();
    const events1 = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AGENT_MESSAGE_CHUNK,
        messageId: 'msg-aaaa',
        content: { type: 'text', text: '你' },
      }),
    );
    const events2 = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AGENT_MESSAGE_CHUNK,
        messageId: 'msg-aaaa',
        content: { type: 'text', text: '好' },
      }),
    );

    expect(events1).toHaveLength(1);
    expect(events1[0].type).toBe('assistant');
    const c1 = (events1[0] as { message: { content: Array<{ type: string; text: string }> } })
      .message.content[0];
    expect(c1).toEqual({ type: 'text', text: '你' });
    // Second chunk carries ONLY its own delta, not the accumulated text.
    const c2 = (events2[0] as { message: { content: Array<{ type: string; text: string }> } })
      .message.content[0];
    expect(c2).toEqual({ type: 'text', text: '好' });
  });

  it('maps agent_thought_chunk delta to assistant/thinking (incremental channel)', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AGENT_THOUGHT_CHUNK,
        messageId: 'msg-aaaa',
        content: { type: 'text', text: '思考中' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
    const c = (events[0] as { message: { content: Array<{ type: string; thinking: string }> } })
      .message.content[0];
    expect(c).toEqual({ type: 'thinking', thinking: '思考中' });
  });

  it('maps tool_call to assistant/tool_use with rawInput object passthrough', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'call_aaaa',
        title: 'Bash',
        kind: 'bash',
        status: 'pending',
        rawInput: { command: 'ls /home/user/project' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
    const c = (
      events[0] as { message: { content: Array<{ type: string; id: string; input: unknown }> } }
    ).message.content[0];
    expect(c.type).toBe('tool_use');
    expect(c.id).toBe('call_aaaa');
    expect(c.input).toEqual({ command: 'ls /home/user/project' });
  });

  it('normalizes tool_call without rawInput to {} (defensive, per event contract)', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'call_bbbb',
        title: 'Read',
        kind: 'read',
        status: 'pending',
      }),
    );
    const c = (events[0] as { message: { content: Array<{ type: string; input: unknown }> } })
      .message.content[0];
    expect(c.input).toEqual({});
  });

  it('maps tool_call_update completed to user/tool_result with rawOutput.output extracted', () => {
    // opencode completedToolUpdate: rawOutput is an OBJECT {output, metadata?}
    // (tool.ts:186-199, 230-236), not a plain string like kimi.
    const t = new OpencodeAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL_UPDATE,
        toolCallId: 'call_aaaa',
        status: 'completed',
        rawOutput: { output: 'file.ts' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user');
    const c = (
      events[0] as {
        message: { content: Array<{ type: string; content: unknown; is_error: boolean }> };
      }
    ).message.content[0];
    expect(c).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_aaaa',
      content: 'file.ts',
      is_error: false,
    });
  });

  it('maps tool_call_update failed to is_error:true with rawOutput.error extracted', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL_UPDATE,
        toolCallId: 'call_aaaa',
        status: 'failed',
        rawOutput: { error: 'boom' },
      }),
    );
    const c = (
      events[0] as {
        message: { content: Array<{ content: unknown; is_error: boolean }> };
      }
    ).message.content[0];
    expect(c.content).toBe('boom');
    expect(c.is_error).toBe(true);
  });

  it('discards control-plane updates (available_commands_update etc.)', () => {
    const t = new OpencodeAcpTranslator();
    for (const kind of [
      SessionEventType.AVAILABLE_COMMANDS_UPDATE,
      SessionEventType.SESSION_INFO_UPDATE,
      SessionEventType.CURRENT_MODE_UPDATE,
      SessionEventType.CONFIG_OPTION_UPDATE,
      SessionEventType.PLAN,
    ]) {
      expect(
        t.handleNotification(
          NotificationMethod.SESSION_UPDATE,
          sessionUpdate(SESSION_ID, { sessionUpdate: kind }),
        ),
      ).toEqual([]);
    }
  });

  it('folds usage_update into the result event (context occupancy + cost)', () => {
    // opencode usage_update: {used, size, cost:{amount, currency:'USD'}}
    // (service.ts:653-663).
    const t = new OpencodeAcpTranslator();
    t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.USAGE_UPDATE,
        used: 12345,
        size: 200000,
        cost: { amount: 0.42, currency: 'USD' },
      }),
    );
    const result = t.handlePromptResponse(SESSION_ID, { stopReason: 'end_turn' }) as {
      subtype: string;
      usage?: { total_tokens?: number; context_limit?: number };
      total_cost_usd?: number;
    };
    expect(result.subtype).toBe('success');
    expect(result.usage?.total_tokens).toBe(12345);
    expect(result.usage?.context_limit).toBe(200000);
    expect(result.total_cost_usd).toBe(0.42);
  });

  it('maps prompt stopReason: end_turn→success, cancelled→interrupted, other→error', () => {
    const t = new OpencodeAcpTranslator();
    expect(
      (t.handlePromptResponse(SESSION_ID, { stopReason: 'end_turn' }) as { subtype: string })
        .subtype,
    ).toBe('success');
    expect(
      (t.handlePromptResponse(SESSION_ID, { stopReason: 'cancelled' }) as { subtype: string })
        .subtype,
    ).toBe('interrupted');
    const err = t.handlePromptResponse(SESSION_ID, { stopReason: 'max_tokens' }) as {
      subtype: string;
      errorMessage?: string;
    };
    expect(err.subtype).toBe('error');
    expect(err.errorMessage).toContain('max_tokens');
  });

  it('omits usage from result when no usage_update was seen', () => {
    const t = new OpencodeAcpTranslator();
    const result = t.handlePromptResponse(SESSION_ID, { stopReason: 'end_turn' }) as {
      usage?: unknown;
      total_cost_usd?: unknown;
    };
    expect(result.usage).toBeUndefined();
    expect(result.total_cost_usd).toBeUndefined();
  });

  it('maps session/request_permission to approval_requested with command view', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleServerRequest(42, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: 'call_perm',
        title: 'Bash: ls',
        kind: 'bash',
        status: 'pending',
        rawInput: { command: 'ls /home/user/project' },
      },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as ApprovalRequestedEvent;
    expect(ev.type).toBe('approval_requested');
    expect(ev.requestId).toBe(42);
    expect(ev.view.command).toBe('Bash: ls');
    // §P4: options 含 allow_always → 派生 acceptForSession
    expect(ev.view.availableDecisions).toEqual(['accept', 'decline', 'cancel', 'acceptForSession']);
  });

  it('permission request without always option → no acceptForSession (§P4)', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleServerRequest(44, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: 'call_perm_once',
        title: 'Bash: ls /home/user/project',
        kind: 'bash',
        status: 'pending',
        rawInput: { command: 'ls /home/user/project' },
      },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as ApprovalRequestedEvent;
    expect(ev.view.availableDecisions).toEqual(['accept', 'decline', 'cancel']);
  });

  it('leaves permission request without toolCall to the runner fallback (no events)', () => {
    const t = new OpencodeAcpTranslator();
    const events = t.handleServerRequest(43, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }],
    });
    expect(events).toEqual([]);
  });

  it('produceTurnStarted carries operationKind turn vs compaction', () => {
    const t = new OpencodeAcpTranslator();
    expect(t.produceTurnStarted(SESSION_ID, 't1').operationKind).toBe('turn');
    t.setOperationKind('compact');
    const ev = t.produceTurnStarted(SESSION_ID, 't2');
    expect(ev.operationKind).toBe('compaction');
    expect(ev.threadId).toBe(SESSION_ID);
  });
});

describe('OpencodeAcpTranslator → run-state reducer integration (seam contract)', () => {
  it('streaming text chunks render exactly one concatenation (no duplication)', () => {
    const t = new OpencodeAcpTranslator();
    let state = createInitialRunState('run-1');
    for (const text of ['你', '好', '，']) {
      const [ev] = t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.AGENT_MESSAGE_CHUNK,
          messageId: 'msg-aaaa',
          content: { type: 'text', text },
        }),
      );
      state = reduceRunState(state, ev as AgentEvent);
    }
    const textBlocks = state.blocks.filter((b) => b.kind === 'text');
    expect(textBlocks).toHaveLength(1);
    expect((textBlocks[0] as { content: string }).content).toBe('你好，');
  });

  it('streaming thinking chunks render exactly one thinking block (no duplication)', () => {
    const t = new OpencodeAcpTranslator();
    let state = createInitialRunState('run-2');
    for (const text of ['思考', '中', '。']) {
      const [ev] = t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.AGENT_THOUGHT_CHUNK,
          messageId: 'msg-aaaa',
          content: { type: 'text', text },
        }),
      );
      state = reduceRunState(state, ev as AgentEvent);
    }
    const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    // assistant thinking channel joins chunks with '\n' (reducer semantics).
    expect((thinkingBlocks[0] as { content: string }).content).toBe('思考\n中\n。');
  });

  it('tool_call without rawInput reaches the reducer without crashing', () => {
    const t = new OpencodeAcpTranslator();
    const [ev] = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'call_lazy',
        title: 'Read',
        kind: 'read',
        status: 'pending',
      }),
    );
    let state = createInitialRunState('run-3');
    expect(() => {
      state = reduceRunState(state, ev as AgentEvent);
    }).not.toThrow();
    const tool = state.blocks.find((b) => b.kind === 'tool');
    // Translator normalized missing rawInput to {}; the reducer renders the
    // args summary as the stringified empty object, not undefined.
    expect(tool && tool.kind === 'tool' ? tool.tool.input : undefined).toBe('{}');
  });
});
