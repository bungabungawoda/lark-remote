/**
 * Abstract base class for exec-stream translators (codex, opencode, pi, kimi).
 *
 * Encapsulates the shared state machine and guard logic that was duplicated
 * across every concrete translator:
 *   - Terminal-state tracking (idempotent `finish()`)
 *   - `translate()` guard (terminal → []; non-record / non-string-type → anomaly)
 *   - `recordUnknownEvent()` helper (warn-logs unknown event types)
 *   - Session / usage / error getters
 *
 * Subclasses provide:
 *   - `logTag` — prefix for warn logs
 *   - `streamEndedMessage()` — agent-specific "stream ended early" message
 *   - `translateEvent(raw)` — agent-specific event dispatch
 *
 * @see SpawningRunner for the runner that consumes translators
 */

import type { AgentEvent, ResultEvent } from '../types.js';
import { getLogger } from '../../logger/index.js';
import { isRecord } from '../../common/guards.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why the stream ended without a natural terminal event. */
type ExecFinishReason = 'failed' | 'interrupted' | 'timeout';

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class ExecTranslator {
  // --- Shared state ---

  protected terminal = false;
  protected lastError: string | undefined;
  protected lastUsage: NonNullable<ResultEvent['usage']> | undefined;
  protected terminalErrorMessage: string | undefined;
  protected terminalErrorFromAgent = false;
  protected sessionId: string | undefined;
  protected readonly startedTools = new Set<string>();

  // --- Abstract hooks ---

  /** Log prefix, e.g. `'[codex-exec-translator]'`. */
  protected abstract readonly logTag: string;

  /** Human-readable message when the stream ends before a terminal event. */
  protected abstract streamEndedMessage(): string;

  /** Agent-specific event dispatch. Called only for valid records with a string `type`. */
  protected abstract translateEvent(raw: Record<string, unknown>): AgentEvent[] | null;

  // --- translate() guard (shared) ---

  /** Translate a single parsed ndjson line into zero or more `AgentEvent`s.
   *  P3-3: filter paths (terminal / non-record / non-string-type) return `null`
   *  instead of `[]` to avoid a throwaway array allocation per non-emitting
   *  event on codex/opencode hot paths. The consumer (SpawningRunner) already
   *  handles `null` via `Array.isArray` + null guards. */
  translate(raw: unknown): AgentEvent[] | null {
    if (this.terminal) return null;
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      return null;
    }
    return this.translateEvent(raw);
  }

  // --- recordUnknownEvent helper ---

  /** Warn-log an unknown event type and return `null` (P3-3: no throwaway []). */
  protected recordUnknownEvent(type: string): AgentEvent[] | null {
    getLogger().warn(`${this.logTag} unknown event type: ${type}`);
    return null;
  }

  // --- finish() (shared, idempotent) ---

  /**
   * Called when the stream ends without a natural terminal event.
   *
   * - Marks the translator terminal (idempotent — second call returns `[]`).
   * - For `reason='failed'`, stores `terminalErrorMessage` so the runner can
   *   surface it via `buildResultEvent({translatorError})`.
   * - Returns `[]` — the runner is responsible for emitting the result event.
   */
  finish(reason: ExecFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;

    if (reason === 'failed') {
      const detail = this.lastError ? `: ${this.lastError}` : '';
      this.terminalErrorMessage = `${this.streamEndedMessage()}${detail}`;
    }
    // interrupted / timeout: no terminalErrorMessage — the runner's
    // stoppedByUser flag (set by base class stop()) drives the result subtype.
    return [];
  }

  // --- Getters (shared) ---

  /** Whether a terminal event has already been seen. */
  isTerminal(): boolean {
    return this.terminal;
  }

  /** Session ID captured from the agent stream (for the result event). */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Token usage captured from the terminal event (for the success result event). */
  getLastUsage(): NonNullable<ResultEvent['usage']> | undefined {
    return this.lastUsage;
  }

  /**
   * Terminal error message captured from an agent-reported error or
   * `finish('failed')`. Returns `undefined` if no terminal error occurred.
   */
  getTerminalError(): string | undefined {
    return this.terminalErrorMessage;
  }

  /**
   * True iff `getTerminalError()` was populated by an agent-reported terminal
   * error (e.g. codex `turn.failed`). The runner uses this to pick the correct
   * root cause for `buildResultEvent`: agent errors override signal/non-zero-code
   * (the agent error is the root cause), but stream-ended-early errors
   * (`finish('failed')`) yield to signal/non-zero-code (the signal is the root
   * cause and the early stream-end is a symptom).
   */
  hasAgentTerminalError(): boolean {
    return this.terminalErrorFromAgent;
  }
}
