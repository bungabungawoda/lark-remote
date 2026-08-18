import { describe, expect, it } from 'vitest';
import { KimiAcpTranslator } from './translator.js';
import {
  NotificationMethod,
  SessionEventType,
  ServerRequestMethod,
} from '../../common/acp/protocol-types.js';
import { createInitialRunState, reduceRunState } from '../../../card/run-state.js';
import type { AgentEvent, ApprovalRequestedEvent } from '../../types.js';

/**
 * Build a session/update notification params object using the REAL wire shape:
 * {sessionId, update: {sessionUpdate: '<kind>', ...}} (kimi-code
 * packages/acp-server/src/events-map.ts). The discriminator field is
 * `update.sessionUpdate` — NOT a nested `event.type`.
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

describe('KimiAcpTranslator', () => {
  const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

  it('maps real-shape agent_message_chunk (params.update.sessionUpdate + content.text) to turn_diff text snapshot with accumulation', () => {
    const t = new KimiAcpTranslator();
    t.produceTurnStarted(SESSION_ID, 'turn-1');
    const events1 = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AGENT_MESSAGE_CHUNK,
        content: { type: 'text', text: 'Hello' },
      }),
    );
    const events2 = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AGENT_MESSAGE_CHUNK,
        content: { type: 'text', text: ' world' },
      }),
    );

    expect(events1).toHaveLength(1);
    expect(events1[0].type).toBe('turn_diff');
    const diff1 = events1[0] as { itemId: string; text: string; threadId: string; turnId: string };
    // Full accumulated snapshot, scoped to the fixed text item.
    expect(diff1.text).toBe('Hello');
    expect(diff1.itemId).toBe('text');
    expect(diff1.threadId).toBe(SESSION_ID);
    expect(diff1.turnId).toBe('turn-1');

    expect(events2).toHaveLength(1);
    const diff2 = events2[0] as { text: string };
    expect(diff2.text).toBe('Hello world');
  });

  it('maps agent_thought_chunk to turn_diff reasoning snapshot', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AGENT_THOUGHT_CHUNK,
        content: { type: 'text', text: 'Let me think...' },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('turn_diff');
    const diff = events[0] as { itemId: string; reasoning: string };
    expect(diff.reasoning).toBe('Let me think...');
    expect(diff.itemId).toBe('thinking');
  });

  it('maps tool_call (rawInput as args object) to assistant/tool_use', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'tc-001',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls -la' },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
    const content = (
      events[0] as {
        message: { content: Array<{ type: string; id: string; name: string; input: unknown }> };
      }
    ).message.content;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toBe('tc-001');
    expect(content[0].name).toBe('Bash');
    expect(content[0].input).toEqual({ command: 'ls -la' });
  });

  it('maps tool_call with string rawInput by parsing JSON (defensive fallback)', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'tc-002',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: '{"command":"ls"}',
      }),
    );

    const content = (events[0] as { message: { content: Array<{ type: string; input: unknown }> } })
      .message.content;
    expect(content[0].input).toEqual({ command: 'ls' });
  });

  it('maps tool_call without rawInput (lazy-create shape) to tool_use with empty input', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'tc-003',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text: '' } }],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
    const content = (
      events[0] as {
        message: { content: Array<{ type: string; id: string; name: string; input: unknown }> };
      }
    ).message.content;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toBe('tc-003');
    expect(content[0].name).toBe('Read');
    expect(content[0].input).toEqual({});
  });

  it('maps tool_call_update status:failed to user/tool_result with is_error:true', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL_UPDATE,
        toolCallId: 'tc-001',
        status: 'failed',
        rawOutput: 'command not found',
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user');
    const content = (
      events[0] as {
        message: {
          content: Array<{ type: string; tool_use_id: string; content: string; is_error: boolean }>;
        };
      }
    ).message.content;
    expect(content[0].type).toBe('tool_result');
    expect(content[0].tool_use_id).toBe('tc-001');
    expect(content[0].is_error).toBe(true);
    expect(content[0].content).toBe('command not found');
  });

  it('maps tool_call_update status:completed to user/tool_result with is_error:false', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL_UPDATE,
        toolCallId: 'tc-002',
        status: 'completed',
        rawOutput: 'total 0',
      }),
    );

    expect(events).toHaveLength(1);
    const content = (
      events[0] as { message: { content: Array<{ type: string; is_error: boolean }> } }
    ).message.content;
    expect(content[0].is_error).toBe(false);
  });

  it('discards plan event', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.PLAN,
        entries: [{ content: 'plan item', priority: 'medium', status: 'pending' }],
      }),
    );
    expect(events).toHaveLength(0);
  });

  it('discards available_commands_update event', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.AVAILABLE_COMMANDS_UPDATE,
        availableCommands: [],
      }),
    );
    expect(events).toHaveLength(0);
  });

  it('discards session_info_update / current_mode_update / config_option_update', () => {
    const t = new KimiAcpTranslator();
    expect(
      t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.SESSION_INFO_UPDATE,
          title: null,
        }),
      ),
    ).toHaveLength(0);
    expect(
      t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.CURRENT_MODE_UPDATE,
          currentModeId: 'default',
        }),
      ),
    ).toHaveLength(0);
    expect(
      t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.CONFIG_OPTION_UPDATE,
          configOptions: [],
        }),
      ),
    ).toHaveLength(0);
  });

  it('maps usage_update {used, size} to live context usage (total_tokens/context_limit)', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.USAGE_UPDATE,
        used: 27430,
        size: 200000,
      }),
    );

    // usage_update does not produce an AgentEvent — it updates internal state
    expect(events).toHaveLength(0);

    // But the live usage is captured: used → contextLength (total_tokens),
    // size → context_limit. No invented input/output split (R1).
    const result = t.produceErrorResult(SESSION_ID, 'boom') as { usage?: Record<string, unknown> };
    expect(result.usage?.total_tokens).toBe(27430);
    expect(result.usage?.context_limit).toBe(200000);
    expect(result.usage?.input_tokens).toBeUndefined();
    expect(result.usage?.output_tokens).toBeUndefined();
  });

  it('returns empty for non-session/update notifications', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleNotification('some/other/method', {});
    expect(events).toHaveLength(0);
  });

  it('prompt stopReason:end_turn → result success', () => {
    const t = new KimiAcpTranslator();
    const event = t.handlePromptResponse(SESSION_ID, { stopReason: 'end_turn' });
    expect(event.type).toBe('result');
    expect(event.subtype).toBe('success');
    expect(event.session_id).toBe(SESSION_ID);
  });

  it('prompt stopReason:cancelled → result interrupted (independent terminal state)', () => {
    const t = new KimiAcpTranslator();
    const event = t.handlePromptResponse(SESSION_ID, { stopReason: 'cancelled' });
    expect(event.type).toBe('result');
    // §4.2: cancelled is independent terminal state, MUST NOT merge into error
    expect(event.subtype).toBe('interrupted');
  });

  it('prompt other stopReason → result error', () => {
    const t = new KimiAcpTranslator();
    const event = t.handlePromptResponse(SESSION_ID, { stopReason: 'tool_error' });
    expect(event.type).toBe('result');
    expect(event.subtype).toBe('error');
    expect(event.errorMessage).toContain('tool_error');
  });

  it('produceTurnStarted with operationKind=turn', () => {
    const t = new KimiAcpTranslator();
    const event = t.produceTurnStarted(SESSION_ID, 'turn-1');
    expect(event.type).toBe('turn_started');
    expect(event.operationKind).toBe('turn');
    expect(event.threadId).toBe(SESSION_ID);
    expect(event.turnId).toBe('turn-1');
  });

  it('produceTurnStarted with operationKind=compaction when setOperationKind=compact', () => {
    const t = new KimiAcpTranslator();
    t.setOperationKind('compact');
    const event = t.produceTurnStarted(SESSION_ID, 'turn-2');
    expect(event.type).toBe('turn_started');
    expect(event.operationKind).toBe('compaction');
  });

  it('produceErrorResult creates error result event', () => {
    const t = new KimiAcpTranslator();
    const event = t.produceErrorResult(SESSION_ID, 'Something went wrong');
    expect(event.type).toBe('result');
    expect(event.subtype).toBe('error');
    expect(event.errorMessage).toBe('Something went wrong');
    expect(event.session_id).toBe(SESSION_ID);
  });

  it('session/request_permission with toolCall → approval_requested', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleServerRequest(42, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      toolCall: { title: 'Bash', rawInput: 'rm -rf /tmp/test' },
      options: [
        { optionId: 'allow_once', name: 'Approve once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
      ],
    });

    expect(events).toHaveLength(1);
    const approval = events[0] as ApprovalRequestedEvent;
    expect(approval.type).toBe('approval_requested');
    expect(approval.requestId).toBe(42);
    expect(approval.kind).toBe('command');
    expect(approval.view.command).toBe('Bash');
    expect(approval.view.availableDecisions).toContain('accept');
    expect(approval.view.availableDecisions).toContain('decline');
    expect(approval.view.availableDecisions).toContain('cancel');
  });

  it('session/request_permission with approve_always option → acceptForSession available (§P4)', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleServerRequest(45, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      toolCall: { title: 'Bash', rawInput: 'rm -rf /tmp/test' },
      options: [
        { optionId: 'approve_once', name: 'Approve once', kind: 'approve_once' },
        { optionId: 'approve_always', name: 'Approve always', kind: 'approve_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });

    expect(events).toHaveLength(1);
    const approval = events[0] as ApprovalRequestedEvent;
    expect(approval.view.availableDecisions).toContain('acceptForSession');
  });

  it('session/request_permission question elicitation → empty (auto-cancelled by runner)', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleServerRequest(43, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      isQuestion: true,
      options: [{ optionId: 'skip', name: 'Skip', kind: 'skip' }],
    });

    // §5.4: question elicitation is not surfaced as approval_requested;
    // the runner will auto-respond cancelled
    expect(events).toHaveLength(0);
  });

  it('session/request_permission without toolCall → empty (question-like)', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleServerRequest(44, ServerRequestMethod.REQUEST_PERMISSION, {
      sessionId: SESSION_ID,
      options: [{ optionId: 'skip', name: 'Skip', kind: 'skip' }],
    });

    expect(events).toHaveLength(0);
  });

  it('unsupported server request methods return empty', () => {
    const t = new KimiAcpTranslator();
    const events = t.handleServerRequest(45, 'unknown/method', {});
    expect(events).toHaveLength(0);
  });

  it('prompt response carries live context usage snapshot (used/size, no invented tokens)', () => {
    const t = new KimiAcpTranslator();
    // Feed a usage_update first
    t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.USAGE_UPDATE,
        used: 500,
        size: 200000,
      }),
    );

    const event = t.handlePromptResponse(SESSION_ID, { stopReason: 'end_turn' });
    expect(event.usage).toBeDefined();
    expect(event.usage!.total_tokens).toBe(500);
    expect(event.usage!.context_limit).toBe(200000);
    // No invented input/output split: bridge falls back to wire.jsonl
    // usage.record for token stats (dual path, R1).
    expect(event.usage!.input_tokens).toBeUndefined();
    expect(event.usage!.output_tokens).toBeUndefined();
  });

  it('prompt response without any usage_update has no usage attached', () => {
    const t = new KimiAcpTranslator();
    const event = t.handlePromptResponse(SESSION_ID, { stopReason: 'end_turn' });
    expect(event.usage).toBeUndefined();
  });
});

describe('KimiAcpTranslator → run-state reducer integration (seam contract)', () => {
  const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

  it('streaming text chunks render exactly one concatenation (no duplication)', () => {
    const t = new KimiAcpTranslator();
    let state = createInitialRunState('run-1');
    for (const text of ['你', '你好', '你好，']) {
      const [ev] = t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.AGENT_MESSAGE_CHUNK,
          content: { type: 'text', text },
        }),
      );
      state = reduceRunState(state, ev as AgentEvent);
    }
    const textBlocks = state.blocks.filter((b) => b.kind === 'text');
    expect(textBlocks).toHaveLength(1);
    expect((textBlocks[0] as { content: string }).content).toBe('你你好你好，');
  });

  it('streaming thinking chunks render exactly one thinking block (no duplication)', () => {
    const t = new KimiAcpTranslator();
    let state = createInitialRunState('run-2');
    for (const text of ['思考', '思考中', '思考中。']) {
      const [ev] = t.handleNotification(
        NotificationMethod.SESSION_UPDATE,
        sessionUpdate(SESSION_ID, {
          sessionUpdate: SessionEventType.AGENT_THOUGHT_CHUNK,
          content: { type: 'text', text },
        }),
      );
      state = reduceRunState(state, ev as AgentEvent);
    }
    const thinkingBlocks = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect((thinkingBlocks[0] as { content: string }).content).toBe('思考思考中思考中。');
  });

  it('tool_call without rawInput reaches the reducer without crashing', () => {
    const t = new KimiAcpTranslator();
    const [ev] = t.handleNotification(
      NotificationMethod.SESSION_UPDATE,
      sessionUpdate(SESSION_ID, {
        sessionUpdate: SessionEventType.TOOL_CALL,
        toolCallId: 'tc-lazy',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text: '' } }],
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
