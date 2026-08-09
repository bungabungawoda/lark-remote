import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../types.js';

/** translate() returns null for filtered records; unit tests expect real events. */
function mustEvents(events: AgentEvent[] | null): AgentEvent[] {
  if (!events) throw new Error('translate() returned null');
  return events;
}
function assistantOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'assistant' }> {
  const e = events.find((x) => x.type === 'assistant');
  if (!e) throw new Error('expected assistant event');
  return e as Extract<AgentEvent, { type: 'assistant' }>;
}
import { CodexExecTranslator } from './jsonl.js';

describe('CodexExecTranslator', () => {
  // ① thread.started → SystemInitEvent
  it('translates thread.started to SystemInitEvent', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'thread.started',
        thread_id: '019f-abc',
        cwd: '/tmp/project',
        model: 'glm-5.2',
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: '019f-abc',
      cwd: '/tmp/project',
      model: 'glm-5.2',
    });
  });

  // ② item.started (command_execution) → AssistantEvent (tool_use)
  it('translates item.started command_execution to AssistantEvent with tool_use', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.started',
        item: { type: 'command_execution', id: 'cmd_1', command: 'ls -la' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'cmd_1',
            name: 'command_execution',
            input: { command: 'ls -la' },
          },
        ],
      },
    });
  });

  // ③ item.completed (agent_message) → AssistantEvent (text)
  it('translates item.completed agent_message to AssistantEvent with text', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Hello world' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
  });

  // ③b item.completed (reasoning) → AssistantEvent (thinking)
  it('translates item.completed reasoning to AssistantEvent with thinking', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { id: 'item_1', type: 'reasoning', text: 'Let me compute this.\n\n17 * 23 = 391.' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'Let me compute this.\n\n17 * 23 = 391.' }],
      },
    });
  });

  // ③c item.completed (reasoning) without text → no event
  it('ignores reasoning item with empty text', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { id: 'item_1', type: 'reasoning' },
      }),
    );
    expect(events).toHaveLength(0);
  });

  // ④ item.completed (command_execution) → UserEvent (tool_result)
  it('translates item.completed command_execution to UserEvent with tool_result', () => {
    const t = new CodexExecTranslator();
    // First start the tool
    t.translate({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd_1', command: 'ls' },
    });
    // Then complete it
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd_1', exit_code: 0, output: 'file1\nfile2' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'cmd_1', content: 'file1\nfile2', is_error: false },
        ],
      },
    });
  });

  // ④b exit_code != 0 → is_error=true
  it('sets is_error=true when exit_code is non-zero', () => {
    const t = new CodexExecTranslator();
    t.translate({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd_2', command: 'bad-cmd' },
    });
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd_2', exit_code: 1, output: 'error msg' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', is_error: true }],
      },
    });
  });

  // ⑤ turn.completed → terminal, stashes usage for runner's buildResultEvent
  it('translates turn.completed to terminal state with uncached input + cache fields', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'turn.completed',
        usage: { input_tokens: 1200, output_tokens: 80, cached_input_tokens: 900 },
      }),
    );
    // translator does not emit result events; runner uses buildResultEvent.
    expect(events).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toBeUndefined();
    expect(t.getLastUsage()).toMatchObject({
      input_tokens: 300, // 1200 - 900 (non-cached)
      output_tokens: 80,
      cache_read_tokens: 900,
      cache_creation_tokens: 0,
    });
  });

  it('passes through total_tokens when codex exec emits them', () => {
    const t = new CodexExecTranslator();
    t.translate({
      type: 'turn.completed',
      usage: {
        input_tokens: 1200,
        output_tokens: 80,
        cached_input_tokens: 900,
        total_tokens: 1280,
      },
    });
    expect(t.getLastUsage()).toMatchObject({
      input_tokens: 300,
      output_tokens: 80,
      cache_read_tokens: 900,
      cache_creation_tokens: 0,
      total_tokens: 1280,
    });
  });

  // ⑥ turn.failed → terminal, stashes error message for runner's buildResultEvent
  it('translates turn.failed to terminal state with stashed error message', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'turn.failed',
        error: { message: 'something went wrong' },
      }),
    );
    // translator does not emit result events; runner uses buildResultEvent.
    expect(events).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toBe('something went wrong');
  });

  // ⑦ unknown type → recordUnknownEvent warns + returns null (P3-3)
  it('returns null for unknown event type', () => {
    const t = new CodexExecTranslator();
    const events = t.translate({ type: 'some_future_event', data: 42 });
    expect(events).toBeNull();
  });

  // ⑧ field missing → translate guard returns []
  it('returns [] for records with missing required fields', () => {
    const t = new CodexExecTranslator();
    // thread.started without thread_id
    const events = mustEvents(t.translate({ type: 'thread.started', cwd: '/tmp' }));
    expect(events).toEqual([]);
  });

  // ⑨ stream ends before terminal → finish('failed') records terminal error
  it('finish(failed) records terminal error when stream ends before terminal event', () => {
    const t = new CodexExecTranslator();
    const events = t.finish('failed');
    // finish() returns [] — runner uses getTerminalError() in buildResultEvent
    expect(events).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toEqual(
      expect.stringContaining('codex stream ended before a terminal event'),
    );
  });

  // ⑨b finish('failed') includes lastError in terminal error message
  it('finish(failed) includes last non-terminal error in terminal error message', () => {
    const t = new CodexExecTranslator();
    t.translate({ type: 'error', message: 'partial failure' });
    t.finish('failed');
    expect(t.getTerminalError()).toEqual(expect.stringContaining('partial failure'));
  });

  // ⑩ already terminal → translate() returns null (P3-3); finish() still returns []
  it('returns null from translate() and [] from finish() after terminal', () => {
    const t = new CodexExecTranslator();
    t.translate({ type: 'turn.completed', usage: {} });
    expect(t.translate({ type: 'thread.started', thread_id: 'x' })).toBeNull();
    expect(t.finish('failed')).toEqual([]);
  });

  // ⑪ finish('interrupted') → terminal, no error (runner's stoppedByUser drives success)
  it('finish(interrupted) marks terminal without storing an error', () => {
    const t = new CodexExecTranslator();
    const events = t.finish('interrupted');
    // finish(interrupted) returns [] — the runner's stoppedByUser flag
    // (set by base class stop()) drives buildResultEvent's success/error branch.
    expect(events).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toBeUndefined();
  });

  // Additional: non-JSON input → translate guard returns null (P3-3)
  it('returns null for non-record input', () => {
    const t = new CodexExecTranslator();
    expect(t.translate('not an object')).toBeNull();
    expect(t.translate(42)).toBeNull();
    expect(t.translate(null)).toBeNull();
  });

  // Additional: error event is non-terminal but now yields an assistant message for user visibility
  it('handles non-terminal error event and yields assistant message for visibility', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(t.translate({ type: 'error', message: 'transient issue' }));
    // 返回一个 assistant 消息，让用户能看到错误进度
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
    expect(assistantOf(events).message.content[0]).toEqual({
      type: 'text',
      text: '⚠️ transient issue',
    });
    expect(t.isTerminal()).toBe(false);
  });

  // Additional: turn.started is silently skipped
  it('skips turn.started event', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(t.translate({ type: 'turn.started', turn_id: 'turn-1' }));
    expect(events).toEqual([]);
  });

  // Additional: item.started with non-command_execution type is skipped
  it('skips item.started for non-command_execution items', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.started',
        item: { type: 'agent_message', id: 'msg_1' },
      }),
    );
    expect(events).toEqual([]);
  });

  // Additional: agent_message top-level event
  it('translates agent_message top-level event', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(t.translate({ type: 'agent_message', text: 'Hello' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
  });

  // Additional: item.completed command_execution without prior item.started → still yields a tool result
  it('yields tool result for command_execution completion without matching start', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'orphan_cmd', exit_code: 0, output: '' },
      }),
    );
    expect(events).toHaveLength(1);
  });

  // Additional: finish('timeout') → terminal, no error (like interrupted)
  it('finish(timeout) marks terminal without storing an error', () => {
    const t = new CodexExecTranslator();
    const events = t.finish('timeout');
    // finish(timeout) returns [] — runner drives success via buildResultEvent
    expect(events).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toBeUndefined();
  });

  // anchor: getThreadId() is a dead alias of the base getSessionId() and must
  // be removed. Production callers use ExecTranslator.getSessionId()
  // (spawning-runner.ts:434 `translator?.getSessionId?.()`), so
  // CodexExecTranslator must NOT define its own getThreadId.
  it('test_anchor_codex_translator_no_get_thread_id', () => {
    const t = new CodexExecTranslator();
    expect(typeof (t as unknown as { getThreadId?: unknown }).getThreadId).toBe('undefined');
  });

  // --- Missing branch coverage ---

  // item.started with command_execution but missing id → empty return (line 89)
  it('skips item.started command_execution without id', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.started',
        item: { type: 'command_execution', command: 'ls' },
      }),
    );
    expect(events).toEqual([]);
  });

  // item.completed command_execution without id → empty return (line 151)
  it('skips item.completed command_execution without id', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'command_execution', exit_code: 0, output: 'result' },
      }),
    );
    expect(events).toEqual([]);
  });

  // item.completed with unknown item type → fallthrough return [] (line 176)
  it('skips item.completed with unknown item type', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'unknown_type', id: 'x1' },
      }),
    );
    expect(events).toEqual([]);
  });

  // item.completed agent_message with text from item.message fallback (line 117)
  it('translates item.completed agent_message using message field as text fallback', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'agent_message', message: 'fallback text' },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'fallback text' }] },
    });
  });

  // item.completed agent_message with empty text → skip (line 118)
  it('skips item.completed agent_message with empty text', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: { type: 'agent_message' },
      }),
    );
    expect(events).toEqual([]);
  });

  // item.completed command_execution with aggregated_output fallback (line 156)
  it('translates command_execution completion using aggregated_output fallback', () => {
    const t = new CodexExecTranslator();
    // Start the tool first so startedTools has it
    t.translate({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd_agg', command: 'test' },
    });
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_agg',
          exit_code: 0,
          aggregated_output: 'agg result',
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'agg result', is_error: false }] },
    });
  });

  // item.completed command_execution with stdout fallback (line 156)
  it('translates command_execution completion using stdout fallback', () => {
    const t = new CodexExecTranslator();
    t.translate({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd_stdout', command: 'test' },
    });
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_stdout',
          exit_code: 0,
          stdout: 'stdout result',
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'stdout result', is_error: false }] },
    });
  });

  // onAgentMessage with message field (line 180 raw.message fallback)
  it('translates agent_message top-level event using message field', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(t.translate({ type: 'agent_message', message: 'via message field' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'via message field' }] },
    });
  });

  // onAgentMessage with empty text → skip (line 181)
  it('skips agent_message top-level event with empty text', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(t.translate({ type: 'agent_message' }));
    expect(events).toEqual([]);
  });

  // turn.completed without usage block → terminal but no usage
  it('handles turn.completed without usage block', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(t.translate({ type: 'turn.completed' }));
    expect(events).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getLastUsage()).toBeUndefined();
  });

  // command_execution completion with output field taking priority over aggregated_output
  it('prefers output over aggregated_output in command_execution completion', () => {
    const t = new CodexExecTranslator();
    t.translate({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd_priority', command: 'test' },
    });
    const events = mustEvents(
      t.translate({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_priority',
          exit_code: 0,
          output: 'primary output',
          aggregated_output: 'secondary',
          stdout: 'tertiary',
        },
      }),
    );
    expect(events).toHaveLength(1);
    // output field takes priority
    expect(events[0]).toMatchObject({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'primary output' }] },
    });
  });

  // thread.started without cwd or model → defaults to empty strings
  it('thread.started defaults cwd and model to empty strings', () => {
    const t = new CodexExecTranslator();
    const events = mustEvents(
      t.translate({
        type: 'thread.started',
        thread_id: '019f-minimal',
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: '019f-minimal',
      cwd: '',
      model: '',
    });
  });
});
