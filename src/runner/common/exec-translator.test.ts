import { describe, it, expect } from 'vitest';
import { ExecTranslator } from './exec-translator.js';
import type { AgentEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal concrete subclass to drive the abstract base class
// ---------------------------------------------------------------------------
class TestTranslator extends ExecTranslator {
  protected readonly logTag = '[test-translator]';

  protected streamEndedMessage(): string {
    return 'test stream ended';
  }

  protected translateEvent(raw: Record<string, unknown>): AgentEvent[] | null {
    if (raw.type === 'unknown_thing') return this.recordUnknownEvent(raw.type as string);
    if (raw.type === 'boom') {
      this.lastError = 'kaboom';
      return [];
    }
    if (raw.type === 'init') {
      this.sessionId = 'sid-1';
      return [];
    }
    if (raw.type === 'usage') {
      this.lastUsage = { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
      return [];
    }
    return [];
  }

  /** Expose protected setter for testing hasAgentTerminalError. */
  markAgentError(): void {
    this.terminalErrorFromAgent = true;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('ExecTranslator (abstract base class)', () => {
  // 1. translate with non-object values → null (P3-3: filter path returns null, not [])
  it('translate returns null for non-object raw inputs', () => {
    const t = new TestTranslator();
    expect(t.translate('str')).toBeNull();
    expect(t.translate(null)).toBeNull();
    expect(t.translate(42)).toBeNull();
  });

  // 2. translate with object missing type or non-string type → null (P3-3)
  it('translate returns null for objects without a string type field', () => {
    const t = new TestTranslator();
    expect(t.translate({})).toBeNull();
    expect(t.translate({ type: 123 })).toBeNull();
    expect(t.translate({ type: null })).toBeNull();
  });

  // 3. translate dispatches to translateEvent for valid events
  it('translate dispatches valid events to translateEvent', () => {
    const t = new TestTranslator();
    expect(t.getSessionId()).toBeUndefined();
    t.translate({ type: 'init' });
    expect(t.getSessionId()).toBe('sid-1');
  });

  // 4. recordUnknownEvent path via translate
  it('recordUnknownEvent returns null for unknown event types (P3-3)', () => {
    const t = new TestTranslator();
    expect(t.translate({ type: 'unknown_thing' })).toBeNull();
  });

  // 5. finish('failed') without lastError
  it('finish(failed) with no lastError sets terminal and terminalError', () => {
    const t = new TestTranslator();
    const result = t.finish('failed');
    expect(result).toEqual([]);
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toBe('test stream ended');
  });

  // 6. finish('failed') with lastError appends it
  it('finish(failed) with lastError includes lastError in terminalError', () => {
    const t = new TestTranslator();
    t.translate({ type: 'boom' });
    t.finish('failed');
    expect(t.getTerminalError()).toBe('test stream ended: kaboom');
  });

  // 7. finish('interrupted') → isTerminal true, no terminalError
  it('finish(interrupted) sets terminal but no terminalError', () => {
    const t = new TestTranslator();
    t.finish('interrupted');
    expect(t.isTerminal()).toBe(true);
    expect(t.getTerminalError()).toBeUndefined();
  });

  // 8. After finish, translate returns null (terminal guard, P3-3)
  it('after finish, translate returns null', () => {
    const t = new TestTranslator();
    t.finish('failed');
    expect(t.translate({ type: 'init' })).toBeNull();
    expect(t.translate({ type: 'unknown_thing' })).toBeNull();
    expect(t.getSessionId()).toBeUndefined();
  });

  // 9. finish is idempotent
  it('finish is idempotent: calling twice does not change terminalError', () => {
    const t = new TestTranslator();
    const r1 = t.finish('failed');
    const r2 = t.finish('failed');
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
    expect(t.getTerminalError()).toBe('test stream ended');
  });

  // 10. hasAgentTerminalError
  it('hasAgentTerminalError defaults to false; true after subclass sets terminalErrorFromAgent', () => {
    const t = new TestTranslator();
    expect(t.hasAgentTerminalError()).toBe(false);
    t.markAgentError();
    expect(t.hasAgentTerminalError()).toBe(true);
  });

  // 11. getLastUsage
  it('getLastUsage defaults to undefined; set after usage event', () => {
    const t = new TestTranslator();
    expect(t.getLastUsage()).toBeUndefined();
    t.translate({ type: 'usage' });
    expect(t.getLastUsage()).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });
});
