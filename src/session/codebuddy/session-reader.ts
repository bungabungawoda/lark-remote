import type { AgentSession, AgentSessionReader, SessionContent } from '../../session-contract.js';
import { TtlCache } from '../../common/ttl-cache.js';
import { paginate } from '../common/pagination.js';
import {
  listCodebuddySessions,
  getNewestCodebuddySession,
  readCodebuddySessionContent,
  isCodebuddySessionActive,
} from './sessions.js';

/**
 * Adapter that exposes CodeBuddy's session-reading functions through the
 * unified `AgentSessionReader` interface. Same shape as ClaudeSessionReader —
 * path config（configDir）住在 reader 构造器，router/bridge 只见契约接口。
 */
export class CodebuddySessionReader implements AgentSessionReader {
  private readonly configDir?: string;

  constructor(opts: { configDir?: string } = {}) {
    this.configDir = opts.configDir;
  }

  /**
   * cwd → 会话全集（mtime 倒序）缓存。listCodebuddySessions 每次全量
   * readdir + stat + 逐文件 cwd 早停扫描，无 claude 式索引；TTL 窗口内的
   * /resume 翻页与 getNewest 复用同一份快照（opencode reader 同款口径）。
   */
  private readonly listCache = new TtlCache<string, AgentSession[]>(10_000);

  listSessions(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): { sessions: AgentSession[]; total: number } {
    // 先拿全集，total 用全集长度，再按 [offset, offset+limit) 切片。
    let all = this.listCache.get(cwd);
    if (!all) {
      all = listCodebuddySessions(cwd, { configDir: this.configDir });
      this.listCache.set(cwd, all);
    }
    const { items, total } = paginate(all, opts ?? {});
    return { sessions: items, total };
  }

  getNewestSession(cwd: string): AgentSession | null {
    return getNewestCodebuddySession(cwd, { configDir: this.configDir }) ?? null;
  }

  readSessionContent(
    sessionId: string,
    cwd: string,
    opts?: { maxEvents?: number },
  ): SessionContent {
    return readCodebuddySessionContent(sessionId, cwd, { ...opts, configDir: this.configDir });
  }

  isSessionActive(sessionId: string, cwd: string): boolean {
    return isCodebuddySessionActive(sessionId, cwd, { configDir: this.configDir });
  }
}
