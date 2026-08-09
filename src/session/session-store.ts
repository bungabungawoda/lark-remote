import fs from 'node:fs';
import { getLogger } from '../logger/index.js';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import type { AgentKind } from '../runner/index.js';

interface SessionEntry {
  /** Session IDs per agent kind (Map for in-memory, plain object for persistence). */
  sessions: Map<AgentKind, string>;
  /** Previous session IDs per agent kind - stored when switching away, for potential restore. */
  previousSessions: Map<AgentKind, string>;
  /** Arrival baseline per agent kind - the session id the user was given when
   * they last "arrived" at this agent via config.save switch ('' = cleared arrival). */
  arrivalSessions: Map<AgentKind, string>;
  /** Session actual cwd per agent (from system.init event.cwd; only claude may differ from cwd). */
  sessionCwds: Map<AgentKind, string>;
  cwd: string;
}

/**
 * Per-user session store. Persists cwd + per-agent sessions to disk so that
 * the last workspace AND the last-used sessionId per agent are restored after
 * a bridge restart.
 *
 * Persistence strategy:
 * - Persists `cwd`, `sessions` (per-agent sessionId), `previousSessions`
 *   (parked restore slots for `/config` agent switching), and `arrivalSessions`
 *   (arrival baseline; '' entries are meaningful and must survive restart).
 * - Atomic write (temp + rename) to avoid truncated files on crash
 * - Corrupt files are treated as empty (with a warning)
 *
 * P3.3: sessions is Map<AgentKind, sessionId> (one session per agent), allowing
 * each agent to maintain its own session context when switching between agents.
 */
export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly persistPath?: string;
  private readonly defaultAgent?: AgentKind;

  /**
   * 进程内会话代际（2026-08-09 /new 被在途 run init 写回撤销事故）：
   * 每次「用户意图移动 session 指针」+1。system.init 写回通道不 bump。
   * Bridge 在 run 启动时快照 epoch，init 写回前比较——不一致说明 /new、
   * /cd、/resume 等在 run 在途时移动了指针，该 run 的写回是 stale 的，丢弃。
   * 不持久化：重启后无在途 run，stale 写回不可能发生。
   * 独立 Map 而非 SessionEntry 字段：entry 有 ~10 处整体重构点，字段易漏传。
   */
  private agentEpochs = new Map<string, number>(); // key: userId agent
  private userEpochs = new Map<string, number>(); // key: userId（/cd 跨 agent 清全部）

  private static epochKey(userId: string, agent: AgentKind): string {
    return `${userId} ${agent}`;
  }

  /** 当前代际 = user 级 + agent 级之和；任一级 bump 都会改变总和。 */
  getSessionEpoch(userId: string, agent: AgentKind): number {
    return (
      (this.userEpochs.get(userId) ?? 0) +
      (this.agentEpochs.get(SessionStore.epochKey(userId, agent)) ?? 0)
    );
  }

  /** 用户意图移动了指定 agent 的 session 指针（/new、/resume、/config 切换）。 */
  bumpSessionEpoch(userId: string, agent: AgentKind): void {
    const k = SessionStore.epochKey(userId, agent);
    this.agentEpochs.set(k, (this.agentEpochs.get(k) ?? 0) + 1);
  }

  /** 用户意图移动了全部 agent 的 session 指针（/cd、/ws use 的 setCwd）。 */
  private bumpUserEpoch(userId: string): void {
    this.userEpochs.set(userId, (this.userEpochs.get(userId) ?? 0) + 1);
  }

  constructor(persistPath?: string, defaultAgent?: AgentKind) {
    this.persistPath = persistPath;
    this.defaultAgent = defaultAgent;
    if (persistPath) this.load();
  }

  get(userId: string): SessionEntry | undefined {
    return this.sessions.get(userId);
  }

  set(userId: string, entry: SessionEntry): void {
    this.sessions.set(userId, entry);
    this.autoPersist();
  }

  delete(userId: string): void {
    this.sessions.delete(userId);
    this.autoPersist();
  }

  /** Clear sessionId for a specific agent, keeping cwd and other agent sessions */
  clearSessionId(
    userId: string,
    agent: AgentKind = 'claude',
    opts?: { clearSessionCwd?: boolean },
  ): void {
    // 无条件 bump：空→空也必须可检测（事故场景正是 run 以 (none) 启动，
    // /new 后 store 仍为空，值比较会误判「没变」）。entry 不存在同样 bump。
    this.bumpSessionEpoch(userId, agent);
    const entry = this.sessions.get(userId);
    if (entry) {
      const newSessions = new Map(entry.sessions);
      newSessions.set(agent, '');
      const newSessionCwds = new Map(entry.sessionCwds);
      if (opts?.clearSessionCwd) {
        newSessionCwds.set(agent, '');
      }
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: entry.previousSessions,
        sessionCwds: newSessionCwds,
        arrivalSessions: entry.arrivalSessions,
        cwd: entry.cwd,
      });
    }
    this.autoPersist();
  }

  /** Get previous sessionId for a specific agent (stored when switching away) */
  getPreviousSessionId(userId: string, agent: AgentKind): string | undefined {
    const entry = this.sessions.get(userId);
    if (!entry) return undefined;
    const sessionId = entry.previousSessions.get(agent);
    if (!sessionId) return undefined;
    return sessionId;
  }

  /** Set previous sessionId for a specific agent (for potential restore when switching back) */
  setPreviousSessionId(userId: string, agent: AgentKind, sessionId: string): void {
    const entry = this.sessions.get(userId);
    if (entry) {
      const newPrevious = new Map(entry.previousSessions);
      newPrevious.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: entry.sessions,
        previousSessions: newPrevious,
        sessionCwds: entry.sessionCwds,
        arrivalSessions: entry.arrivalSessions,
        cwd: entry.cwd,
      });
    } else {
      const newPrevious = new Map<AgentKind, string>();
      newPrevious.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: new Map(),
        previousSessions: newPrevious,
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd: '',
      });
    }
    this.autoPersist();
  }

  /** Clear previous sessionId for a specific agent */
  clearPreviousSessionId(userId: string, agent: AgentKind): void {
    const entry = this.sessions.get(userId);
    if (entry) {
      const newPrevious = new Map(entry.previousSessions);
      newPrevious.delete(agent);
      this.sessions.set(userId, {
        sessions: entry.sessions,
        previousSessions: newPrevious,
        sessionCwds: entry.sessionCwds,
        arrivalSessions: entry.arrivalSessions,
        cwd: entry.cwd,
      });
    }
    this.autoPersist();
  }

  /** Get the arrival baseline sessionId for a specific agent ('' and missing → undefined) */
  getArrivalSessionId(userId: string, agent: AgentKind): string | undefined {
    const entry = this.sessions.get(userId);
    if (!entry) return undefined;
    const sessionId = entry.arrivalSessions.get(agent);
    if (!sessionId) return undefined;
    return sessionId;
  }

  /** Set the arrival baseline for a specific agent ('' explicitly clears the arrival baseline) */
  setArrivalSessionId(userId: string, agent: AgentKind, sessionId: string): void {
    const entry = this.sessions.get(userId);
    if (entry) {
      const newArrival = new Map(entry.arrivalSessions);
      newArrival.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: entry.sessions,
        previousSessions: entry.previousSessions,
        sessionCwds: entry.sessionCwds,
        arrivalSessions: newArrival,
        cwd: entry.cwd,
      });
    } else {
      const newArrival = new Map<AgentKind, string>();
      newArrival.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: new Map(),
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: newArrival,
        cwd: '',
      });
    }
    this.autoPersist();
  }

  /** Set cwd for a user, clearing all sessionIds (§9.1) */
  setCwd(userId: string, cwd: string): void {
    // §9.1 setCwd 清全部 agent 的 sessionId → user 级 bump，覆盖 sessions
    // map 里还没有 key 的 agent（run 刚启动、首个 init 未写回时 /cd 的边界）。
    this.bumpUserEpoch(userId);
    const entry = this.sessions.get(userId);
    if (entry) {
      const newSessions = new Map(entry.sessions);
      for (const key of newSessions.keys()) {
        newSessions.set(key, '');
      }
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd,
      });
    } else {
      this.sessions.set(userId, {
        sessions: new Map(),
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd,
      });
    }
    this.autoPersist();
  }

  /** Get cwd for a user, or undefined if no session */
  getCwd(userId: string): string | undefined {
    return this.sessions.get(userId)?.cwd;
  }

  /** Get sessionId for a specific agent, or undefined if no session or sessionId is empty */
  getSessionId(userId: string, agent: AgentKind = 'claude'): string | undefined {
    const entry = this.sessions.get(userId);
    if (!entry || !entry.sessions) return undefined;
    const sessionId = entry.sessions.get(agent);
    if (!sessionId) return undefined;
    return sessionId;
  }

  /** Set sessionId for a specific agent, optionally with cwd */
  setSessionId(userId: string, agent: AgentKind, sessionId: string, cwd?: string): void {
    this.bumpSessionEpoch(userId, agent);
    const entry = this.sessions.get(userId);
    if (entry) {
      const newSessions = new Map(entry.sessions);
      newSessions.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: entry.previousSessions,
        sessionCwds: entry.sessionCwds,
        arrivalSessions: entry.arrivalSessions,
        cwd: cwd ?? entry.cwd,
      });
    } else {
      const newSessions = new Map<AgentKind, string>();
      newSessions.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd: cwd ?? '',
      });
    }
    this.autoPersist();
  }

  /** Set sessionId for a specific agent and cwd together */
  setSessionIdAndCwd(
    userId: string,
    agent: AgentKind,
    sessionId: string,
    cwd: string,
    sessionCwd?: string,
  ): void {
    const entry = this.sessions.get(userId);
    if (entry) {
      const newSessions = new Map(entry.sessions);
      newSessions.set(agent, sessionId);
      const newSessionCwds = new Map(entry.sessionCwds);
      if (sessionCwd !== undefined) {
        newSessionCwds.set(agent, sessionCwd);
      }
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: entry.previousSessions,
        sessionCwds: newSessionCwds,
        arrivalSessions: entry.arrivalSessions,
        cwd,
      });
    } else {
      const newSessions = new Map<AgentKind, string>();
      newSessions.set(agent, sessionId);
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd,
      });
    }
    this.autoPersist();
  }

  /** Get sessionCwd for a specific agent, or undefined if not set */
  getSessionCwd(userId: string, agent: AgentKind = 'claude'): string | undefined {
    const entry = this.sessions.get(userId);
    if (!entry) return undefined;
    const sessionCwd = entry.sessionCwds.get(agent);
    if (!sessionCwd) return undefined;
    return sessionCwd;
  }

  /** Set sessionId and sessionCwd for a specific agent, without touching cwd */
  setSessionIdAndSessionCwd(
    userId: string,
    agent: AgentKind,
    sessionId: string,
    sessionCwd: string,
  ): void {
    const entry = this.sessions.get(userId);
    if (entry) {
      const newSessions = new Map(entry.sessions);
      newSessions.set(agent, sessionId);
      const newSessionCwds = new Map(entry.sessionCwds);
      newSessionCwds.set(agent, sessionCwd);
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: entry.previousSessions,
        sessionCwds: newSessionCwds,
        arrivalSessions: entry.arrivalSessions,
        cwd: entry.cwd,
      });
    } else {
      const newSessions = new Map<AgentKind, string>();
      newSessions.set(agent, sessionId);
      const newSessionCwds = new Map<AgentKind, string>();
      newSessionCwds.set(agent, sessionCwd);
      this.sessions.set(userId, {
        sessions: newSessions,
        previousSessions: new Map(),
        sessionCwds: newSessionCwds,
        arrivalSessions: new Map(),
        cwd: '',
      });
    }
    this.autoPersist();
  }

  // -- Persistence helpers --

  /** Persisted format: only cwd per user (sessionId is process-scoped) */
  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [userId, data] of Object.entries(parsed)) {
          if (typeof data === 'object' && data !== null) {
            const entry = data as {
              cwd?: string;
              sessions: Record<string, string>;
              previousSessions: Record<string, string>;
              sessionCwds: Record<string, string>;
              arrivalSessions: Record<string, string>;
            };
            // All four session fields are required; a missing one indicates a
            // corrupt record — skip it entirely. cwd is allowed to be absent
            // (legitimately-empty cwd state, see round7 tests).
            if (
              !entry.sessions ||
              !entry.previousSessions ||
              !entry.arrivalSessions ||
              !entry.sessionCwds
            ) {
              continue;
            }
            const sessions = new Map<AgentKind, string>();
            for (const [agent, sid] of Object.entries(entry.sessions)) {
              if (sid) {
                sessions.set(agent as AgentKind, sid);
              }
            }
            const previousSessions = new Map<AgentKind, string>();
            for (const [agent, sid] of Object.entries(entry.previousSessions)) {
              if (sid) {
                previousSessions.set(agent as AgentKind, sid);
              }
            }
            const arrivalSessions = new Map<AgentKind, string>();
            for (const [agent, sid] of Object.entries(entry.arrivalSessions)) {
              // '' entries are meaningful: explicit "cleared arrival" must
              // survive a restart instead of being re-defaulted.
              arrivalSessions.set(agent as AgentKind, sid);
            }
            const sessionCwds = new Map<AgentKind, string>();
            for (const [agent, scwd] of Object.entries(entry.sessionCwds)) {
              if (scwd) {
                sessionCwds.set(agent as AgentKind, scwd);
              }
            }
            // Persist any user that has state: cwd set, or any meaningful
            // sessions/previousSessions value, or any arrival baseline entry
            // ('' arrivals are meaningful). Fully empty records are skipped.
            const hasCwd = !!entry.cwd && entry.cwd.length > 0;
            if (
              hasCwd ||
              sessions.size > 0 ||
              previousSessions.size > 0 ||
              arrivalSessions.size > 0
            ) {
              this.sessions.set(userId, {
                sessions,
                previousSessions,
                sessionCwds,
                arrivalSessions,
                cwd: entry.cwd ?? '',
              });
            }
          }
        }
      }
    } catch {
      getLogger().warn('[session] persisted session store corrupted, ignoring');
    }
  }

  private autoPersist(): void {
    if (!this.persistPath) return;
    try {
      // Persist cwd, sessions, previousSessions (parked restore slots) and
      // arrivalSessions (arrival baseline; '' entries are meaningful).
      const obj: Record<
        string,
        {
          cwd: string;
          sessions: Record<string, string>;
          previousSessions: Record<string, string>;
          sessionCwds: Record<string, string>;
          arrivalSessions: Record<string, string>;
        }
      > = {};
      for (const [userId, entry] of this.sessions) {
        // Persist any user that has state: cwd set, or any meaningful
        // sessions/previousSessions value, or any arrival baseline entry
        // ('' arrivals are meaningful). Empty cwd is written as '' so the
        // other fields survive a rebuild.
        const hasSessions = [...entry.sessions.values()].some((sid) => sid);
        const hasPrevious = [...entry.previousSessions.values()].some((sid) => sid);
        const hasArrival = entry.arrivalSessions.size > 0;
        const hasSessionCwds = entry.sessionCwds.size > 0;
        if (entry.cwd.length > 0 || hasSessions || hasPrevious || hasArrival || hasSessionCwds) {
          const sessionsObj: Record<string, string> = {};
          for (const [agent, sid] of entry.sessions) {
            if (sid) {
              sessionsObj[agent] = sid;
            }
          }
          const previousObj: Record<string, string> = {};
          for (const [agent, sid] of entry.previousSessions) {
            if (sid) {
              previousObj[agent] = sid;
            }
          }
          const arrivalObj: Record<string, string> = {};
          for (const [agent, sid] of entry.arrivalSessions) {
            arrivalObj[agent] = sid;
          }
          const sessionCwdsObj: Record<string, string> = {};
          for (const [agent, scwd] of entry.sessionCwds) {
            if (scwd) {
              sessionCwdsObj[agent] = scwd;
            }
          }
          obj[userId] = {
            cwd: entry.cwd,
            sessions: sessionsObj,
            previousSessions: previousObj,
            sessionCwds: sessionCwdsObj,
            arrivalSessions: arrivalObj,
          };
        }
      }
      atomicWriteJson(this.persistPath, obj);
    } catch (err) {
      getLogger().warn('[session] failed to persist session store:', err);
    }
  }
}
