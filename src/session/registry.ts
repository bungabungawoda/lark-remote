import type { AgentKind, AgentSessionReader } from '../runner/index.js';
/**
 * Registry of `AgentSessionReader` instances, keyed by `AgentKind`. Mirrors
 * `AgentRegistry` but for session-history reads. `index.ts` registers one
 * reader per available agent at startup; router/bridge look up readers here
 * instead of importing `claude-sessions.ts` directly.
 */
export class SessionReaderRegistry {
  private readonly readers = new Map<AgentKind, AgentSessionReader>();

  register(kind: AgentKind, reader: AgentSessionReader): void {
    this.readers.set(kind, reader);
  }

  get(kind: AgentKind): AgentSessionReader {
    const reader = this.readers.get(kind);
    if (!reader) {
      throw new Error(`session reader not registered: ${kind}`);
    }
    return reader;
  }
}
