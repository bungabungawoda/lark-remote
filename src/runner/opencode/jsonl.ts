/**
 * Translates opencode `run --format json` ndjson output into lark-remote `AgentEvent`s.
 *
 * Key design decisions:
 * - opencode uses step-level events (step_start/step_finish), not turn-level like codex.
 * - Tool is a single-part state machine: state.status evolves pending→running→completed/error,
 *   input and output are in the same part.
 * - Fail-fast: unknown types and missing fields return [] (no event emitted),
 *   never throw, never write back to opencode (root cause ② tolerance).
 * - Stream ending before a terminal event records a terminal error via `finish()`
 *   (root cause ③ fail-fast); the runner's `buildResultEvent` emits the result.
 * - Each `run()` must create a new translator instance (stateful: sessionId/terminal/startedTools).
 *
 * Terminal state (sessionId, lastUsage, terminalErrorMessage) is stored on
 * the instance and exposed via getters; `OpencodeExecRunner.run()` folds
 * this state into `SpawningRunner.buildResultEvent(...)` so result-event
 * semantics are uniform across all 5 agents.
 *
 * Event mapping:
 * | opencode ndjson          | lark-remote AgentEvent                              |
 * |--------------------------|------------------------------------------------------|
 * | step_start               | SystemInitEvent (first event only)                 |
 * | text                     | AssistantEvent(text)                               |
 * | reasoning                | AssistantEvent(thinking)                          |
 * | tool/tool_use (first)    | AssistantEvent(tool_use)                          |
 * | tool (status=completed)  | UserEvent(tool_result, is_error=false)            |
 * | tool (status=error)      | UserEvent(tool_result, is_error=true)             |
 * | patch                    | FileChangeEvent                                    |
 * | step_finish(reason=stop) | [] (terminal — usage stashed for runner)          |
 * | step_finish(reason=*)    | [] (non-terminal, continues)                      |
 * | error                    | [] (terminal - error message stashed for runner)  |
 * | unknown type             | [] (no event)                                     |
 */

import type { AgentEvent, ResultEvent } from '../types.js';
import { getLogger } from '../../logger/index.js';
import { recordValue, stringValue, numberValue, extractErrorMessage } from '../../common/guards.js';
import { ExecTranslator } from '../common/exec-translator.js';

type ResultUsage = NonNullable<ResultEvent['usage']>;

export class OpencodeExecTranslator extends ExecTranslator {
  private readonly cwd: string;

  /** Accumulate usage across all steps (not just terminal step). */
  private accumulatedUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  } = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };

  /** Track which tool results have already been emitted (idempotency). */
  private readonly emittedResults = new Set<string>();

  protected readonly logTag = '[opencode-exec-translator]';

  protected streamEndedMessage(): string {
    return 'opencode stream ended before a terminal step';
  }

  /**
   * @param opts.cwd The session's real directory. Emitted on the synthesized
   * SystemInitEvent so the bridge persists the correct cwd (was hardcoded '').
   * Post-PWD-sync-fix this equals the runner's opts.cwd == opencode's directory.
   */
  constructor(opts: { cwd?: string } = {}) {
    super();
    this.cwd = opts.cwd ?? '';
  }

  /** Token usage captured from `step_finish(reason=stop)` (for the success result event). */
  declare getLastUsage: () => ResultUsage | undefined;

  /** Get accumulated usage across all steps (for diagnostics). */
  getAccumulatedUsage(): Readonly<typeof this.accumulatedUsage> {
    return { ...this.accumulatedUsage };
  }

  // --- translateEvent: opencode-specific dispatch ---

  protected translateEvent(raw: Record<string, unknown>): AgentEvent[] | null {
    // Stash sessionId from the very first event (every event carries it)
    const sid = stringValue(raw.sessionID ?? raw.sessionId);
    if (sid && !this.sessionId) {
      this.sessionId = sid;
    }

    switch (raw.type) {
      case 'step_start':
        return this.onStepStart(raw);
      case 'text':
        return this.onText(raw);
      case 'reasoning':
        return this.onReasoning(raw);
      case 'tool':
      case 'tool_use':
      case 'tool_output':
        return this.onTool(raw);
      case 'patch':
        return this.onPatch(raw);
      case 'step_finish':
        return this.onStepFinish(raw);
      case 'error':
        return this.onError(raw);
      default:
        return this.recordUnknownEvent(raw.type as string);
    }
  }

  // --- Private handlers ---

  /** SystemInitEvent: synthesize from first event with sessionId. */
  private synthesizeInit(): AgentEvent {
    return {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId ?? '',
      cwd: this.cwd,
      model: '',
      timestamp: new Date().toISOString(),
    };
  }

  private onStepStart(_raw: Record<string, unknown>): AgentEvent[] {
    // Internal marker, no lark-remote event
    // But this is the first event, so synthesize SystemInitEvent
    return this.sessionId && !this.terminal ? [this.synthesizeInit()] : [];
  }

  private onText(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part) {
      return [];
    }

    const text = stringValue(part.text);
    if (!text) {
      return [];
    }

    return [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text }],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private onReasoning(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part) {
      return [];
    }

    const text = stringValue(part.text);
    if (!text) {
      return [];
    }

    return [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: text }],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private onTool(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part) {
      return [];
    }

    const tool = stringValue(part.tool);
    const callId = stringValue(part.callID ?? part.callId);
    const state = recordValue(part.state);

    if (!callId) {
      return [];
    }

    const events: AgentEvent[] = [];

    // First time seeing this tool call: emit tool_use
    if (!this.startedTools.has(callId)) {
      this.startedTools.add(callId);

      const input = state ? recordValue(state.input) : undefined;
      const toolUseContent = {
        type: 'tool_use' as const,
        id: callId,
        name: tool ?? '',
        input: input ?? {},
      };

      events.push({
        type: 'assistant',
        message: {
          content: [toolUseContent],
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Check for completion or error status
    if (state) {
      const status = stringValue(state.status);

      // completed: emit tool_result with output
      if (status === 'completed' && !this.emittedResults.has(callId)) {
        this.emittedResults.add(callId);
        const output = stringValue(state.output) ?? '';
        events.push({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: callId,
                content: output,
                is_error: false,
              },
            ],
          },
          timestamp: new Date().toISOString(),
        });
      }

      // error: emit tool_result with error
      if (status === 'error' && !this.emittedResults.has(callId)) {
        this.emittedResults.add(callId);
        const error = stringValue(state.error) ?? stringValue(state.output) ?? 'unknown error';
        events.push({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: callId,
                content: error,
                is_error: true,
              },
            ],
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    return events;
  }

  private onPatch(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part) {
      return [];
    }

    const files = part.files as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(files) || files.length === 0) {
      return [];
    }

    // Emit a FileChangeEvent for each file
    const events: AgentEvent[] = [];
    for (const file of files) {
      const path = stringValue(file.path ?? file.file_path);
      if (!path) continue;

      events.push({
        type: 'file_change',
        path,
        operation: 'edit', // patch implies edit
        timestamp: new Date().toISOString(),
      });
    }

    return events;
  }

  private onStepFinish(raw: Record<string, unknown>): AgentEvent[] {
    const part = recordValue(raw.part);
    if (!part) {
      return [];
    }

    const reason = stringValue(part.reason);

    // Extract tokens from this step (both terminal and non-terminal steps contribute usage).
    const tokens = recordValue(part.tokens);
    if (tokens) {
      const cache = recordValue(tokens.cache);

      // Accumulate usage across ALL steps (not just terminal step).
      // This fixes the systematic undercount for multi-step runs.
      this.accumulatedUsage.input_tokens += numberValue(tokens.input) ?? 0;
      this.accumulatedUsage.output_tokens += numberValue(tokens.output) ?? 0;
      this.accumulatedUsage.cache_read_tokens += cache ? (numberValue(cache.read) ?? 0) : 0;
      this.accumulatedUsage.cache_creation_tokens += cache ? (numberValue(cache.write) ?? 0) : 0;

      // Only reason='stop' is terminal
      if (reason === 'stop') {
        // Mark terminal and stash accumulated usage; the runner emits the result event
        // via buildResultEvent({...usage}) so success/error is uniform across agents.
        this.terminal = true;

        // Use accumulated usage (all steps) for the final result
        const total = numberValue(tokens.total);
        this.lastUsage = {
          input_tokens: this.accumulatedUsage.input_tokens,
          output_tokens: this.accumulatedUsage.output_tokens,
          cache_read_tokens: this.accumulatedUsage.cache_read_tokens,
          cache_creation_tokens: this.accumulatedUsage.cache_creation_tokens,
          ...(total !== undefined ? { total_tokens: total } : {}),
        };
      }
    }

    return [];
  }

  private onError(raw: Record<string, unknown>): AgentEvent[] {
    // opencode error events are terminal in practice: opencode exits with
    // code=1 immediately after emitting one, without a step_finish(reason=stop).
    // Mark terminal so the real error message reaches the user via
    // buildResultEvent({translatorError}) instead of the generic
    // "opencode exited code=1" fallback.
    const message = extractErrorMessage(raw, 'opencode error');
    getLogger().warn(`[opencode-exec-translator] error: ${message.slice(0, 500)}`);
    getLogger().warn(
      `[opencode-exec-translator] RAW ERROR EVENT: ${JSON.stringify(raw).slice(0, 2000)}`,
    );
    this.terminal = true;
    this.terminalErrorFromAgent = true;
    this.terminalErrorMessage = message;
    return [];
  }
}
