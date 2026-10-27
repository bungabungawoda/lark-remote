import type {
  AgentSession,
  AgentSessionReader,
  SessionContent,
  SessionSummary,
} from '../../session-contract.js';
import { resolveCodexHome } from '../../config/codex-config.js';
import { DEFAULT_LIST_LIMIT } from '../common/pagination.js';
import { newestOf } from '../common/recency.js';
import {
  listCodexRollouts,
  readCodexSessionContent,
  readCodexSessionSummary,
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
      limit: opts?.limit ?? DEFAULT_LIST_LIMIT,
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
    return newestOf(this, cwd);
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

  readSessionSummary(sessionId: string, cwd: string): SessionSummary {
    return readCodexSessionSummary(sessionId, { codexHome: this.codexHome, cwd });
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    return isCodexSessionActive(sessionId, { codexHome: this.codexHome, cwd });
  }
}
