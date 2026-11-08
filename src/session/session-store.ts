import fs from 'node:fs';
import { getLogger } from '../logger/index.js';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import type { AgentKind } from '../agent-kinds.js';

/**
 * session reader 共用的失败留痕（claude stat / kimi realpath）：ENOENT 是两次
 * 查询之间的正常竞态，静默；其余 errno 必须 debug 留痕，否则「文件不可读」
 * 会被误判成「会话不活跃」。文案由调用方按场景给出，逐字保持。
 */
export function logNonEnoentDebug(err: unknown, message: (errText: string) => string): void {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
  getLogger().debug(message((err as Error)?.message ?? String(err)));
}

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

/** 落盘时机：'now' 即时原子写（默认，用户命令路径）；'soon' 走 run 写回去抖窗口。 */
type PersistTiming = 'now' | 'soon';

/**
 * per-agent 字符串 Map 的字段名：sessions / sessionCwds / previousSessions /
 * arrivalSessions。四类 getter 的方法体原本完全重复，唯一差异就是读/写
 * 哪一个 Map；合并成单一实现后用这个键显式选择，行为（空串归一、agent
 * 隔离、落盘）逐项保持。
 */
type SessionIdMapKey = 'sessions' | 'sessionCwds' | 'previousSessions' | 'arrivalSessions';

/** 四类 getter 共用的单一实现：entry 缺失 / 空串 → undefined。 */
function readSessionId(
  entry: SessionEntry | undefined,
  key: SessionIdMapKey,
  agent: AgentKind,
): string | undefined {
  if (!entry) return undefined;
  const value = entry[key].get(agent);
  if (!value) return undefined;
  return value;
}

/** 持久化记录（load 的输入契约，模块级纯数据形状）。 */
interface PersistedEntry {
  cwd?: string;
  sessions: Record<string, string>;
  previousSessions: Record<string, string>;
  sessionCwds: Record<string, string>;
  arrivalSessions: Record<string, string>;
}

/** 四个 session 字段缺一即损坏记录（整条跳过，cwd 允许缺失）。 */
function hasRequiredSessionFields(entry: PersistedEntry): boolean {
  return (
    !!entry.sessions && !!entry.previousSessions && !!entry.arrivalSessions && !!entry.sessionCwds
  );
}

/** 只保留 truthy 值（sessions / previousSessions / sessionCwds 的口径）。 */
function truthySessionMap(record: Record<string, string>): Map<AgentKind, string> {
  const map = new Map<AgentKind, string>();
  for (const [agent, sid] of Object.entries(record)) {
    if (sid) map.set(agent as AgentKind, sid);
  }
  return map;
}

/** 全保留（arrivalSessions 的 '' 是显式清空基线，必须跨重启存活）。 */
function fullSessionMap(record: Record<string, string>): Map<AgentKind, string> {
  const map = new Map<AgentKind, string>();
  for (const [agent, sid] of Object.entries(record)) {
    map.set(agent as AgentKind, sid);
  }
  return map;
}

/** 单条持久化记录 → 内存 entry；损坏 / 完全空记录返回 undefined。 */
function parsePersistedEntry(data: unknown): SessionEntry | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const entry = data as PersistedEntry;
  // 四个 session 字段缺失 = 损坏记录，整条跳过。cwd 允许缺失：
  // 全新用户（未 /cd）先切 agent 时 previous/arrival 停车位已落盘，
  // cwd 尚为空——不能因 cwd 缺失把停车位整条丢掉
  // （anchor_r7_parked_previous_survives_rebuild_without_cwd）。
  if (!hasRequiredSessionFields(entry)) return undefined;
  const sessions = truthySessionMap(entry.sessions);
  const previousSessions = truthySessionMap(entry.previousSessions);
  const arrivalSessions = fullSessionMap(entry.arrivalSessions);
  const sessionCwds = truthySessionMap(entry.sessionCwds);
  // Persist any user that has state: cwd set, or any meaningful
  // sessions/previousSessions value, or any arrival baseline entry
  // ('' arrivals are meaningful). Fully empty records are skipped.
  const hasCwd = !!entry.cwd && entry.cwd.length > 0;
  if (hasCwd || sessions.size > 0 || previousSessions.size > 0 || arrivalSessions.size > 0) {
    return {
      sessions,
      previousSessions,
      sessionCwds,
      arrivalSessions,
      cwd: entry.cwd ?? '',
    };
  }
  return undefined;
}

/** 损坏现场留痕：日志 + 改名保留（原文件继续躺着会重复告警、丢排障证据）。 */
function preserveCorruptStore(persistPath: string | undefined, err: unknown): void {
  getLogger().warn(
    `[session] persisted session store corrupted (${persistPath ?? '(memory)'}), ignoring:`,
    err,
  );
  if (persistPath) {
    const brokenPath = `${persistPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(persistPath, brokenPath);
      getLogger().warn(`[session] moved corrupt store to ${brokenPath}`);
    } catch (renameErr) {
      getLogger().warn('[session] failed to preserve corrupt store:', renameErr);
    }
  }
}

/**
 * Per-user session store. Persists cwd + per-agent sessions to disk so that
 * the last cwd AND the last-used sessionId per agent are restored after
 * a lark-remote restart.
 *
 * Persistence strategy:
 * - Persists `cwd`, `sessions` (per-agent sessionId), `previousSessions`
 *   (parked restore slots for `/config` agent switching), and `arrivalSessions`
 *   (arrival baseline; '' entries are meaningful and must survive restart).
 * - Atomic write (temp + rename) to avoid truncated files on crash
 * - Corrupt files are treated as empty (with a warning)
 *
 * 3: sessions is Map<AgentKind, sessionId> (one session per agent), allowing
 * each agent to maintain its own session context when switching between agents.
 */
export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly persistPath?: string;

  /**
   * 进程内会话代际（防 /new 被在途 run init 写回撤销）：
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

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath) this.load();
  }

  /**
   * run 生命周期写回（system.init / turn_started / result）的落盘去抖窗口。
   * 一次 run 至少 3 次写回，每次都是带 fsync 的全量原子写（mkdir+write+fsync+
   * rename+unlink 六个同步 syscall）；窗口内合并为一次。用户命令（/new、/cd、
   * /resume、/config 切换）不经过此路径，仍即时落盘。
   */
  private static readonly PERSIST_DEBOUNCE_MS = 1_500;
  private persistTimer: NodeJS.Timeout | undefined;

  private autoPersistSoon(): void {
    if (!this.persistPath) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.autoPersist();
    }, SessionStore.PERSIST_DEBOUNCE_MS);
    // unref：不阻止进程自然退出；退出路径由 flushPendingPersist 收口。
    this.persistTimer.unref?.();
  }

  /**
   * 立即落盘尚在去抖窗口内的写回（幂等；无 pending 时是 no-op）。
   * 进程退出路径（index.ts 的 'exit' 钩子）调用，防止最近一次指针更新丢失；
   * SIGKILL/断电场景丢失最近 ≤1.5s 的指针更新是已接受的损耗——指针只是
   * 恢复便利，agent 会话本身已持久化。
   */
  flushPendingPersist(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.autoPersist();
  }

  /** A fresh, empty session entry (default factory). */
  private static emptyEntry(cwd = ''): SessionEntry {
    return {
      sessions: new Map(),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd,
    };
  }

  /**
   * Clone the user's entry, apply `mutate` to it, and store the result.
   * Creates a fresh empty entry when the user has none. All the per-field
   * setters (clearSessionId / setPreviousSessionId / setArrivalSessionId /
   * setCwd / setSessionId / setSessionIdAndCwd / setSessionIdAndSessionCwd)
   * use this to avoid each re-spelling the "clone entry, tweak one Map" dance.
   */
  private mutateEntry(
    userId: string,
    mutate: (entry: SessionEntry) => SessionEntry,
    persist: PersistTiming = 'now',
  ): void {
    const current = this.sessions.get(userId);
    const base = current
      ? {
          sessions: new Map(current.sessions),
          previousSessions: new Map(current.previousSessions),
          sessionCwds: new Map(current.sessionCwds),
          arrivalSessions: new Map(current.arrivalSessions),
          cwd: current.cwd,
        }
      : SessionStore.emptyEntry();
    this.sessions.set(userId, mutate(base));
    if (persist === 'soon') this.autoPersistSoon();
    else this.autoPersist();
  }

  get(userId: string): SessionEntry | undefined {
    return this.sessions.get(userId);
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
    this.mutateEntry(userId, (entry) => {
      entry.sessions.set(agent, '');
      if (opts?.clearSessionCwd) {
        entry.sessionCwds.set(agent, '');
      }
      return entry;
    });
  }

  /** Get previous sessionId for a specific agent (stored when switching away) */
  getPreviousSessionId(userId: string, agent: AgentKind): string | undefined {
    return readSessionId(this.sessions.get(userId), 'previousSessions', agent);
  }

  /** Set previous sessionId for a specific agent (for potential restore when switching back) */
  setPreviousSessionId(userId: string, agent: AgentKind, sessionId: string): void {
    this.writeSessionId(userId, 'previousSessions', agent, sessionId);
  }

  /** Clear previous sessionId for a specific agent */
  clearPreviousSessionId(userId: string, agent: AgentKind): void {
    this.mutateEntry(userId, (entry) => {
      entry.previousSessions.delete(agent);
      return entry;
    });
  }

  /** Get the arrival baseline sessionId for a specific agent ('' and missing → undefined) */
  getArrivalSessionId(userId: string, agent: AgentKind): string | undefined {
    return readSessionId(this.sessions.get(userId), 'arrivalSessions', agent);
  }

  /** Set the arrival baseline for a specific agent ('' explicitly clears the arrival baseline) */
  setArrivalSessionId(userId: string, agent: AgentKind, sessionId: string): void {
    this.writeSessionId(userId, 'arrivalSessions', agent, sessionId);
  }

  /** previous/arrival 两类 setter 共用的单一实现（合并完全重复块）。 */
  private writeSessionId(
    userId: string,
    key: SessionIdMapKey,
    agent: AgentKind,
    sessionId: string,
  ): void {
    this.mutateEntry(userId, (entry) => {
      entry[key].set(agent, sessionId);
      return entry;
    });
  }

  /** Set cwd for a user, clearing all sessionIds (§9.1) */
  setCwd(userId: string, cwd: string): void {
    // §9.1 setCwd 清全部 agent 的 sessionId → user 级 bump，覆盖 sessions
    // map 里还没有 key 的 agent（run 刚启动、首个 init 未写回时 /cd 的边界）。
    this.bumpUserEpoch(userId);
    this.mutateEntry(userId, (entry) => {
      for (const key of entry.sessions.keys()) {
        entry.sessions.set(key, '');
      }
      entry.previousSessions = new Map();
      entry.sessionCwds = new Map();
      entry.arrivalSessions = new Map();
      entry.cwd = cwd;
      return entry;
    });
  }

  /** Get cwd for a user, or undefined if no session */
  getCwd(userId: string): string | undefined {
    return this.sessions.get(userId)?.cwd;
  }

  /** Get sessionId for a specific agent, or undefined if no session or sessionId is empty */
  getSessionId(userId: string, agent: AgentKind = 'claude'): string | undefined {
    return readSessionId(this.sessions.get(userId), 'sessions', agent);
  }

  /** Set sessionId for a specific agent, optionally with cwd */
  setSessionId(userId: string, agent: AgentKind, sessionId: string, cwd?: string): void {
    this.bumpSessionEpoch(userId, agent);
    this.mutateEntry(userId, (entry) => {
      entry.sessions.set(agent, sessionId);
      if (cwd !== undefined) entry.cwd = cwd;
      return entry;
    });
  }

  /** Set sessionId for a specific agent and cwd together */
  setSessionIdAndCwd(
    userId: string,
    agent: AgentKind,
    sessionId: string,
    cwd: string,
    sessionCwd?: string,
    opts?: { persist?: PersistTiming },
  ): void {
    this.mutateEntry(
      userId,
      (entry) => {
        entry.sessions.set(agent, sessionId);
        if (sessionCwd !== undefined) {
          entry.sessionCwds.set(agent, sessionCwd);
        }
        entry.cwd = cwd;
        return entry;
      },
      opts?.persist,
    );
  }

  /** Get sessionCwd for a specific agent, or undefined if not set */
  getSessionCwd(userId: string, agent: AgentKind = 'claude'): string | undefined {
    return readSessionId(this.sessions.get(userId), 'sessionCwds', agent);
  }

  /** Set sessionId and sessionCwd for a specific agent, without touching cwd */
  setSessionIdAndSessionCwd(
    userId: string,
    agent: AgentKind,
    sessionId: string,
    sessionCwd: string,
    opts?: { persist?: PersistTiming },
  ): void {
    this.mutateEntry(
      userId,
      (entry) => {
        entry.sessions.set(agent, sessionId);
        entry.sessionCwds.set(agent, sessionCwd);
        return entry;
      },
      opts?.persist,
    );
  }

  // -- Persistence helpers --

  /** Persisted format: cwd + sessions + previous/arrival session maps. */
  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [userId, data] of Object.entries(parsed)) {
          const entry = parsePersistedEntry(data);
          if (entry) this.sessions.set(userId, entry);
        }
      }
    } catch (err) {
      preserveCorruptStore(this.persistPath, err);
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
