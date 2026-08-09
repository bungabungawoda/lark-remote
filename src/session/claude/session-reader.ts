import type { AgentSession, AgentSessionReader, SessionContent } from '../../runner/index.js';
import {
  listClaudeSessions,
  getNewestSession,
  readSessionContent,
  isClaudeSessionActive,
} from '../../session/claude/sessions.js';

/**
 * Adapter that exposes Claude Code's session-reading functions through the
 * unified `AgentSessionReader` interface. This lets `SessionReaderRegistry`
 * treat Claude / Codex / OpenCode uniformly.
 *
 * Q-C decision: `projectsDir` lives on the reader (not the router). The router
 * injects a reader configured with its test `projectsDir`; production code
 * uses the default (`~/.claude/projects/`).
 *
 * All methods are thin wrappers around `claude-sessions.ts` exports — zero
 * behavior change. Router and bridge reach session data exclusively through
 * this reader (via `SessionReaderRegistry`); the underlying functions remain
 * exported for tests and the reader itself.
 */
export class ClaudeSessionReader implements AgentSessionReader {
  private readonly projectsDir?: string;

  constructor(opts: { projectsDir?: string } = {}) {
    this.projectsDir = opts.projectsDir;
  }

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    // 先拿全集（不传 limit → listClaudeSessions 不切片），total 用全集长度，
    // 再由 reader 按 [offset, offset+limit) 切片。
    const all = listClaudeSessions(cwd, this.readerOpts());
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit;
    return {
      sessions: limit === undefined ? all.slice(offset) : all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  getNewestSession(cwd: string): AgentSession | null {
    const session = getNewestSession(cwd, this.readerOpts());
    return session ?? null;
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    return readSessionContent(sessionId, cwd, { ...this.readerOpts(), ...opts });
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    return isClaudeSessionActive(sessionId, cwd, this.readerOpts());
  }

  private readerOpts(): { projectsDir?: string } {
    return this.projectsDir ? { projectsDir: this.projectsDir } : {};
  }
}
