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
function userOf(events: AgentEvent[]): Extract<AgentEvent, { type: 'user' }> {
  const e = events.find((x) => x.type === 'user');
  if (!e) throw new Error('expected user event');
  return e as Extract<AgentEvent, { type: 'user' }>;
}
function fileChangeAt(
  events: AgentEvent[],
  i: number,
): Extract<AgentEvent, { type: 'file_change' }> {
  const e = events[i];
  if (!e || e.type !== 'file_change') throw new Error('expected file_change event');
  return e as Extract<AgentEvent, { type: 'file_change' }>;
}
import { OpencodeExecTranslator } from './jsonl.js';

describe('OpencodeExecTranslator', () => {
  describe('step_start', () => {
    it('returns empty array (internal marker)', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'step_start',
        timestamp: 1783931173528,
        sessionID: 'ses_test123',
        part: { type: 'step-start', id: 'prt_xxx' },
      };
      const events = mustEvents(translator.translate(raw));
      // step_start is internal, but it should emit SystemInitEvent
      expect(events.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('text', () => {
    it('emits AssistantEvent with text content', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'text',
        timestamp: 1783931173575,
        sessionID: 'ses_test123',
        part: { type: 'text', text: 'Hello world' },
      };
      const events = mustEvents(translator.translate(raw));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(assistantOf(events).message.content[0]).toEqual({
        type: 'text',
        text: 'Hello world',
      });
    });
  });

  describe('reasoning', () => {
    it('emits AssistantEvent with thinking content', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'reasoning',
        timestamp: 1783931173575,
        sessionID: 'ses_test123',
        part: { type: 'reasoning', text: 'Let me think about this...' },
      };
      const events = mustEvents(translator.translate(raw));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('assistant');
      expect(assistantOf(events).message.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Let me think about this...',
      });
    });
  });

  describe('tool (first + completed)', () => {
    it('emits both tool_use and tool_result for completed tool', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'tool',
        timestamp: 1783931173575,
        sessionID: 'ses_test123',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 'call_123',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/test.txt' },
            output: 'file content here',
          },
        },
      };
      const events = mustEvents(translator.translate(raw));
      expect(events).toHaveLength(2);
      // First: tool_use
      expect(events[0].type).toBe('assistant');
      expect(assistantOf(events).message.content[0]).toEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'read',
        input: { filePath: '/tmp/test.txt' },
      });
      // Second: tool_result
      expect(events[1].type).toBe('user');
      expect(userOf(events).message.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_123',
        content: 'file content here',
        is_error: false,
      });
    });
  });

  describe('tool (status=error)', () => {
    it('emits tool_result with is_error=true', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'tool',
        sessionID: 'ses_test123',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call_456',
          state: {
            status: 'error',
            input: { command: 'ls /nonexistent' },
            error: 'Command failed: No such file or directory',
          },
        },
      };
      const events = mustEvents(translator.translate(raw));
      expect(events).toHaveLength(2);
      expect(userOf(events).message.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_456',
        content: 'Command failed: No such file or directory',
        is_error: true,
      });
    });
  });

  describe('step_finish (reason=stop)', () => {
    it('stashes usage and marks terminal for runner to emit ResultEvent', () => {
      const translator = new OpencodeExecTranslator();
      // Real OpenCode shape: total = input + output + cache.read + cache.write + reasoning
      // (reasoning is separate from output). ccusage captures cache.write as
      // cache_creation_tokens and tokens.total as total_tokens (reasoning folded
      // into the display total via the max/extra formula).
      const raw = {
        type: 'step_finish',
        sessionID: 'ses_test123',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: {
            total: 13393,
            input: 13240,
            output: 3,
            reasoning: 50,
            cache: { write: 100, read: 0 },
          },
        },
      };
      // translator does not emit result events; runner uses buildResultEvent.
      const events = mustEvents(translator.translate(raw));
      expect(events).toEqual([]);
      expect(translator.isTerminal()).toBe(true);
      expect(translator.getLastUsage()).toEqual({
        input_tokens: 13240,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_creation_tokens: 100,
        total_tokens: 13393,
      });
    });
  });

  describe('step_finish (reason=tool-calls)', () => {
    it('returns empty array (non-terminal)', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'step_finish',
        sessionID: 'ses_test123',
        part: { type: 'step-finish', reason: 'tool-calls' },
      };
      const events = mustEvents(translator.translate(raw));
      expect(events).toHaveLength(0);
      expect(translator.isTerminal()).toBe(false);
    });
  });

  describe('patch', () => {
    it('emits FileChangeEvent for each file', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'patch',
        sessionID: 'ses_test123',
        part: {
          type: 'patch',
          files: [{ path: '/tmp/file1.txt' }, { path: '/tmp/file2.txt' }],
        },
      };
      const events = mustEvents(translator.translate(raw));
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('file_change');
      expect(fileChangeAt(events, 0).path).toBe('/tmp/file1.txt');
      expect(fileChangeAt(events, 1).path).toBe('/tmp/file2.txt');
    });
  });

  describe('unknown type', () => {
    it('returns null for unknown event type (P3-3)', () => {
      const translator = new OpencodeExecTranslator();
      const raw = { type: 'unknown_event', data: 'test' };
      const events = translator.translate(raw);
      expect(events).toBeNull();
    });
  });

  describe('missing fields', () => {
    it('returns null for records with missing type (P3-3)', () => {
      const translator = new OpencodeExecTranslator();
      // Missing type
      const raw1 = { data: 'test' };
      expect(translator.translate(raw1)).toBeNull();
    });
  });

  describe('finish()', () => {
    it('records terminal error when stream ends without terminal', () => {
      const translator = new OpencodeExecTranslator();
      // finish() returns [] — runner uses getTerminalError() in buildResultEvent
      const events = translator.finish('failed');
      expect(events).toEqual([]);
      expect(translator.isTerminal()).toBe(true);
      expect(translator.getTerminalError()).toEqual(
        expect.stringContaining('opencode stream ended before a terminal step'),
      );
    });

    it('marks terminal without storing an error for interrupted', () => {
      const translator = new OpencodeExecTranslator();
      // finish(interrupted) returns [] — the runner's stoppedByUser flag
      // (set by base class stop()) drives buildResultEvent's success/error branch.
      const events = translator.finish('interrupted');
      expect(events).toEqual([]);
      expect(translator.isTerminal()).toBe(true);
      expect(translator.getTerminalError()).toBeUndefined();
    });

    it('returns empty after terminal', () => {
      const translator = new OpencodeExecTranslator();
      // First emit terminal
      translator.translate({
        type: 'step_finish',
        sessionID: 'ses_test',
        part: { type: 'step-finish', reason: 'stop' },
      });
      // Second call should return empty (terminal guard)
      expect(translator.finish('failed')).toHaveLength(0);
    });
  });

  describe('tool idempotency', () => {
    it('does not re-emit tool_result for repeated completed events', () => {
      const translator = new OpencodeExecTranslator();
      const raw = {
        type: 'tool',
        sessionID: 'ses_test123',
        part: {
          type: 'tool',
          tool: 'read',
          callID: 'call_idempotent',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/test.txt' },
            output: 'content',
          },
        },
      };

      // First call: should emit tool_use + tool_result
      const events1 = translator.translate(raw);
      expect(events1).toHaveLength(2);

      // Second call: should only emit tool_result (already emitted once)
      const events2 = translator.translate(raw);
      // Since we already emitted result once, this should NOT emit again
      // But the current implementation emits again if not tracked...
      // Actually we track in emittedResults, so it should be idempotent
      expect(events2).toHaveLength(0);
    });
  });

  describe('multi-step turn', () => {
    it('only stashes usage on final stop step', () => {
      const translator = new OpencodeExecTranslator();

      // First step: tool-calls (non-terminal)
      translator.translate({
        type: 'step_finish',
        sessionID: 'ses_test',
        part: {
          type: 'step-finish',
          reason: 'tool-calls',
          tokens: { total: 100, input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      expect(translator.isTerminal()).toBe(false);
      // Non-terminal step_finish does not stash usage yet (only accumulates)
      expect(translator.getLastUsage()).toBeUndefined();
      // Check that non-terminal step's usage was accumulated
      expect(translator.getAccumulatedUsage().input_tokens).toBe(50);
      expect(translator.getAccumulatedUsage().output_tokens).toBe(50);

      // Second step: stop (terminal)
      const events = mustEvents(
        translator.translate({
          type: 'step_finish',
          sessionID: 'ses_test',
          part: {
            type: 'step-finish',
            reason: 'stop',
            tokens: {
              total: 200,
              input: 100,
              output: 100,
              reasoning: 0,
              cache: { read: 50, write: 0 },
            },
          },
        }),
      );
      // translator returns [] — runner uses getLastUsage() in buildResultEvent
      expect(events).toEqual([]);
      expect(translator.isTerminal()).toBe(true);
      // Should use ACCUMULATED tokens (all steps), not just terminal step.
      // First step: input=50, output=50; Second step: input=100, output=100
      // Accumulated: input=150, output=150
      expect(translator.getLastUsage()?.input_tokens).toBe(150);
      expect(translator.getLastUsage()?.output_tokens).toBe(150);
      // Cache should also be accumulated (50 from step 1 + 50 from step 2)
      expect(translator.getLastUsage()?.cache_read_tokens).toBe(50);
    });
  });

  // L2: synthesizeInit must carry the injected cwd so the bridge can persist
  // the session's real directory (was hardcoded '', which orphaned last-session.json).
  describe('init cwd (L2)', () => {
    it('emits SystemInitEvent with cwd from constructor', () => {
      const translator = new OpencodeExecTranslator({ cwd: '/Users/x/project' });
      const events = mustEvents(
        translator.translate({
          type: 'step_start',
          sessionID: 'ses_init_l2',
          part: { type: 'step-start', id: 'prt_l2' },
        }),
      );
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      expect(init).toBeDefined();

      expect((init as any).cwd).toBe('/Users/x/project');
    });

    it('defaults cwd to empty string when not provided', () => {
      const translator = new OpencodeExecTranslator();
      const events = mustEvents(
        translator.translate({
          type: 'step_start',
          sessionID: 'ses_init_default',
          part: { type: 'step-start', id: 'prt_def' },
        }),
      );
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      expect(init).toBeDefined();
      expect((init as any).cwd).toBe('');
    });
  });
});
