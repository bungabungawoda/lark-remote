/**
 * Durable record of DSH prompts that may outlive the bridge process.
 *
 * A DSH turn runs inside the shared `dsh web` host, not in a child process. If
 * the bridge dies (SIGKILL, crash) the turn keeps running with no subscriber —
 * the 2026-10-19 incident ran 2h21m / 345 steps after its bridge exited. The
 * runner writes one entry when it submits a prompt and removes it once the run
 * (or a verified stop) accounts for that prompt; the next startup reconciles
 * anything left behind:
 *
 *  1. a still-pending prompt (identified by `source.rpcId`) is removed from the
 *     host inbox, so it can never start a turn nobody is watching;
 *  2. a session that still reports an open turn is reported to the owner once —
 *     we deliberately do not cancel it, because the open turn may belong to the
 *     DSH Web UI rather than to the dead bridge.
 *
 * This is a best-effort safety net, never a correctness dependency: every
 * method swallows storage errors so a broken state file cannot block a run.
 */

import { getLogger } from '../../logger/index.js';
import { atomicWriteJson } from '../../persistence/atomic-write.js';
import { loadJsonFile } from '../../persistence/load-json-file.js';
import type { DshClient } from './client.js';

export interface DshInflightEntry {
  sessionId: string;
  promptRequestId: string;
  baseUrl: string;
  cwd?: string;
  updatedAt: number;
}

interface InflightFile {
  entries: DshInflightEntry[];
}

/** Keep the file bounded; stale entries are pruned by age and count. */
const MAX_ENTRIES = 50;
/** A turn cannot plausibly live this long; drop the record instead of nagging. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isEntry(value: unknown): value is DshInflightEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<DshInflightEntry>;
  return (
    typeof entry.sessionId === 'string' &&
    entry.sessionId.length > 0 &&
    typeof entry.promptRequestId === 'string' &&
    entry.promptRequestId.length > 0 &&
    typeof entry.baseUrl === 'string' &&
    entry.baseUrl.length > 0 &&
    typeof entry.updatedAt === 'number'
  );
}

function sameEntry(
  left: Pick<DshInflightEntry, 'sessionId' | 'promptRequestId'>,
  right: Pick<DshInflightEntry, 'sessionId' | 'promptRequestId'>,
): boolean {
  return left.sessionId === right.sessionId && left.promptRequestId === right.promptRequestId;
}

export class DshInflightStore {
  constructor(private readonly filePath: string) {}

  list(): DshInflightEntry[] {
    const parsed = loadJsonFile<Partial<InflightFile> | undefined>(this.filePath, undefined);
    const raw = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const now = Date.now();
    return raw
      .filter(isEntry)
      .filter((entry) => now - entry.updatedAt <= MAX_AGE_MS)
      .slice(-MAX_ENTRIES);
  }

  record(entry: Omit<DshInflightEntry, 'updatedAt'>): void {
    const next = this.list().filter((existing) => !sameEntry(existing, entry));
    next.push({ ...entry, updatedAt: Date.now() });
    this.write(next);
  }

  clear(sessionId: string, promptRequestId: string): void {
    const next = this.list().filter((entry) => !sameEntry(entry, { sessionId, promptRequestId }));
    this.write(next);
  }

  private write(entries: DshInflightEntry[]): void {
    try {
      atomicWriteJson(this.filePath, { entries: entries.slice(-MAX_ENTRIES) });
    } catch (err) {
      // The marker is a safety net; losing it must never fail the run.
      getLogger().warn(`[dsh] inflight marker write failed: ${(err as Error).message}`);
    }
  }
}

export interface DshInflightReconcileOptions {
  store: DshInflightStore;
  client: Pick<DshClient, 'baseUrl' | 'findPendingPrompt' | 'removeQueuedPrompt' | 'openTurnState'>;
  /** Owner notification; omitted when no p2p recipient is known yet. */
  notify?: (text: string) => Promise<void>;
  timeoutMs?: number;
}

export interface DshInflightReconcileResult {
  /** Pending prompts removed from the host inbox. */
  removed: number;
  /** Sessions that still reported an open turn (or an unreadable state). */
  open: number;
  /** True when the host was unreachable; entries are kept for the next start. */
  skipped: boolean;
}

/**
 * Reconcile entries left by a previous process.
 *
 * Only entries for the currently configured host are considered; entries for
 * another host are kept untouched. On a transport failure the remaining
 * entries are left in the file so a later startup can retry.
 */
export async function reconcileInflightDshRuns(
  opts: DshInflightReconcileOptions,
): Promise<DshInflightReconcileResult> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const entries = opts.store.list().filter((entry) => entry.baseUrl === opts.client.baseUrl);
  if (entries.length === 0) return { removed: 0, open: 0, skipped: false };

  let removed = 0;
  const open: DshInflightEntry[] = [];
  for (const entry of entries.slice(0, 10)) {
    try {
      const itemId = await opts.client.findPendingPrompt(entry.sessionId, entry.promptRequestId, {
        timeoutMs,
      });
      if (itemId) {
        const ok = await opts.client.removeQueuedPrompt(entry.sessionId, itemId, { timeoutMs });
        if (ok) removed++;
      }
      const state = await opts.client.openTurnState(entry.sessionId, { timeoutMs });
      if (state !== 'closed') open.push(entry);
      // Handled once: do not nag on every later startup.
      opts.store.clear(entry.sessionId, entry.promptRequestId);
    } catch (err) {
      getLogger().warn(
        `[dsh] inflight reconcile skipped (host unreachable?): ${(err as Error).message}`,
      );
      return { removed, open: open.length, skipped: true };
    }
  }

  if (open.length > 0) {
    getLogger().warn(
      `[dsh] inflight reconcile: ${open.length} session(s) may still have an open turn`,
    );
    if (opts.notify) {
      try {
        await opts.notify(formatInflightWarning(open));
      } catch (err) {
        getLogger().warn(`[dsh] inflight notice failed: ${(err as Error).message}`);
      }
    }
  }
  return { removed, open: open.length, skipped: false };
}

/** One short owner-facing notice; session ids are truncated, not paths. */
export function formatInflightWarning(entries: DshInflightEntry[]): string {
  const lines = entries.slice(0, 3).map((entry) => {
    const id = entry.sessionId.length > 8 ? entry.sessionId.slice(0, 8) : entry.sessionId;
    return `- session ${id}（${entry.cwd ?? '未知目录'}）`;
  });
  if (entries.length > 3) lines.push(`- …另有 ${entries.length - 3} 个`);
  return (
    `⚠️ 上次退出时可能留下了未结束的 DSH turn（${entries.length} 个）：\n` +
    `${lines.join('\n')}\n` +
    '请到 DSH Web UI 检查；需要终止时在对应会话再发一次 /stop。'
  );
}
