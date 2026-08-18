import type { AgentSession, SessionContent, AgentSessionReader } from '../../runner/index.js';
import { resolveCodexHome } from '../../config/codex-config.js';
import {
  listCodexRollouts,
  readCodexSessionContent,
  isCodexSessionActive,
} from './rollout-reader.js';

interface CodexSessionReaderOptions {
  codexHome?: string;
}

export class CodexSessionReader implements AgentSessionReader {
  private readonly codexHome: string;

  constructor(opts: CodexSessionReaderOptions = {}) {
    this.codexHome = resolveCodexHome(opts.codexHome);
  }

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    const result = listCodexRollouts({
      codexHome: this.codexHome,
      cwd,
      limit: opts?.limit ?? 20,
      offset: opts?.offset,
    });
    return {
      sessions: result.entries.map((entry) => ({
        sessionId: entry.threadId,
        // '(no user message)' 是 reader 的占位符，不是真实输入；给空串由
        // router 的占位符集合统一过滤。`|| entry.cwd` 永不达（rollout-reader
        // 已保证 firstUserMessage 非空字符串），去掉以免把 cwd 误当摘要。
        summary: entry.firstUserMessage === '(no user message)' ? '' : entry.firstUserMessage,
        mtime: entry.updatedAtMs,
      })),
      total: result.total,
    };
  }

  getNewestSession(cwd: string): AgentSession | null {
    return this.listSessions(cwd, { limit: 1 }).sessions[0] ?? null;
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    return readCodexSessionContent(sessionId, {
      codexHome: this.codexHome,
      maxEvents: opts?.maxEvents,
      cwd,
    });
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    return isCodexSessionActive(sessionId, { codexHome: this.codexHome, cwd });
  }
}
