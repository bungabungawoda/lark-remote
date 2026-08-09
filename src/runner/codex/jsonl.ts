/**
 * Translates codex `exec --json` ndjson output into lark-remote `AgentEvent`s.
 *
 * Key design decisions:
 * - Fail-fast: unknown types and missing fields return [] (no event emitted),
 *   never throw, never write back to codex (root cause ② tolerance).
 * - Stream ending before a terminal event records a terminal error via `finish()`
 *   (root cause ③ fail-fast); the runner's `buildResultEvent` emits the result.
 * - Each `run()` must create a new translator instance (stateful: sessionId/terminal/startedTools).
 *
 * Terminal state (sessionId, lastUsage, terminalErrorMessage) is stored on
 * the instance and exposed via getters; `CodexExecRunner.run()` folds this
 * state into `SpawningRunner.buildResultEvent(...)` so result-event
 * semantics are uniform across all 5 agents.
 *
 * Two jsonl formats exist; this translator handles
 * the `codex exec --json` stdout format ONLY. The rollout file format is handled
 * separately by `codex-rollout-reader.ts`.
 */

import type { AgentEvent, ResultEvent } from '../types.js';
import { getLogger } from '../../logger/index.js';
import { recordValue, stringValue, numberValue, extractErrorMessage } from '../../common/guards.js';
import { ExecTranslator } from '../common/exec-translator.js';

type ResultUsage = NonNullable<ResultEvent['usage']>;

export class CodexExecTranslator extends ExecTranslator {
  protected readonly logTag = '[codex-exec-translator]';

  protected streamEndedMessage(): string {
    return 'codex stream ended before a terminal event';
  }

  /** Token usage captured from `turn.completed` (for the success result event). */
  declare getLastUsage: () => ResultUsage | undefined;

  // --- translateEvent: codex-specific dispatch ---

  protected translateEvent(raw: Record<string, unknown>): AgentEvent[] | null {
    switch (raw.type) {
      case 'thread.started':
        return this.onThreadStarted(raw);
      case 'turn.started':
        return []; // internal marker, no lark-remote event
      case 'item.started':
        return this.onItemStarted(raw);
      case 'item.completed':
        return this.onItemCompleted(raw);
      case 'agent_message':
        return this.onAgentMessage(raw);
      case 'turn.completed':
        return this.onTurnCompleted(raw);
      case 'turn.failed':
        return this.onTerminalError(raw, 'codex turn failed');
      case 'error':
        return this.onNonTerminalError(raw);
      default:
        return this.recordUnknownEvent(raw.type as string);
    }
  }

  // --- Private handlers ---

  private onThreadStarted(raw: Record<string, unknown>): AgentEvent[] {
    const threadId = stringValue(raw.thread_id);
    if (!threadId) {
      return [];
    }
    this.sessionId = threadId;
    return [
      {
        type: 'system',
        subtype: 'init',
        session_id: threadId,
        cwd: stringValue(raw.cwd) ?? '',
        model: stringValue(raw.model) ?? '',
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private onItemStarted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item || item.type !== 'command_execution') return [];

    const id = stringValue(item.id);
    if (!id) {
      return [];
    }
    this.startedTools.add(id);

    return [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id,
              name: 'command_execution',
              input: { command: stringValue(item.command) ?? '' },
            },
          ],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private onItemCompleted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item) return [];

    // agent_message → assistant text
    if (item.type === 'agent_message') {
      const text = stringValue(item.text ?? item.message);
      if (!text) return [];
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

    // reasoning → thinking content, so output.showThinking
    // applies to codex the same way it does for claude/pi/opencode.
    // Shape: {"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"..."}}
    if (item.type === 'reasoning') {
      const text = stringValue(item.text);
      if (!text) return [];
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

    // command_execution → tool result
    if (item.type === 'command_execution') {
      const id = stringValue(item.id);
      if (!id) {
        return [];
      }
      this.startedTools.delete(id);

      const exitCode = numberValue(item.exit_code);
      const output = stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? '';

      return [
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: output,
                is_error: exitCode !== undefined && exitCode !== 0,
              },
            ],
          },
          timestamp: new Date().toISOString(),
        },
      ];
    }

    return [];
  }

  private onAgentMessage(raw: Record<string, unknown>): AgentEvent[] {
    const message = stringValue(raw.message ?? raw.text);
    if (!message) return [];
    return [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: message }],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private onTurnCompleted(raw: Record<string, unknown>): AgentEvent[] {
    // mark terminal and stash usage; the runner emits the result event
    // via buildResultEvent({...usage}) so success/error is uniform across agents.
    this.terminal = true;

    const usage = recordValue(raw.usage);
    if (usage) {
      // ccusage-aligned: for codex, cached_input_tokens is a subset of
      // input_tokens, so the non-cached (displayed) input = raw - cached.
      // Codex has no separate cache-write, so cache_creation is always 0.
      const rawInput = numberValue(usage.input_tokens ?? usage.inputTokens) ?? 0;
      const cached = numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens) ?? 0;
      const total = numberValue(usage.total_tokens ?? usage.totalTokens);
      this.lastUsage = {
        input_tokens: rawInput - Math.min(cached, rawInput),
        output_tokens: numberValue(usage.output_tokens ?? usage.outputTokens) ?? 0,
        cache_read_tokens: cached,
        cache_creation_tokens: 0,
        ...(total !== undefined ? { total_tokens: total } : {}),
      };
    }

    return [];
  }

  private onTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    // mark terminal and stash the error message; the runner folds it
    // into buildResultEvent({translatorError}) so the result subtype is 'error'
    // with the agent-specific reason (e.g. codex turn.failed).
    this.terminal = true;
    this.terminalErrorMessage = extractErrorMessage(raw, fallback);
    this.terminalErrorFromAgent = true;
    return [];
  }

  private onNonTerminalError(raw: Record<string, unknown>): AgentEvent[] {
    const message = extractErrorMessage(raw, 'codex error');
    this.lastError = message;
    getLogger().warn(`[codex-exec-translator] non-terminal error: ${message.slice(0, 500)}`);
    // 将非终止错误作为 assistant 文本输出，让用户在 Run 卡片上看到进度
    // （如 404/401 重连、provider 不匹配等错误），而非静默等待。
    return [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `⚠️ ${message}` }],
        },
        timestamp: new Date().toISOString(),
      },
    ];
  }
}
