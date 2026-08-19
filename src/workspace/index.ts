import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import { loadJsonFile } from '../persistence/load-json-file.js';
import { getLogger } from '../logger/index.js';

/** Internal storage format for each workspace entry. */
interface WorkspaceEntryData {
  path: string;
  lastUsedAt: number;
}

/** Public view of a workspace entry returned by list(). */
export interface WorkspaceEntry {
  name: string;
  path: string;
  lastUsedAt: number;
}

/**
 * Persistent named-alias store for workspace directories.
 *
 * Atomic write (§9.10): writes a temp file then `fs.rename` so a crash
 * mid-write cannot leave a truncated JSON file. On load, a corrupt file
 * is treated as empty (with a warning) so the bridge can still start.
 *
 * lastUsedAt 语义（2026-08-19 语义对齐）：保存（save）与使用（use/touch）
 * 都会把时间戳更新为当前时间。save 内部调用 touch，保证「最近使用」排序
 * 对新保存的 workspace 同样生效（新条目应排在列表最前，而非沉底）。
 *
 * Data migration: old format `{ alias: "path" }` is normalized to
 * `{ alias: { path, lastUsedAt: 0 } }` on first load and persisted.
 */
export class WorkspaceStore {
  private filePath: string;
  private data: Map<string, WorkspaceEntryData>;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(os.homedir(), '.lark-remote', 'workspace.json');
    this.data = new Map();
    this.load();
  }

  private load(): void {
    const parsed = loadJsonFile<Record<string, unknown> | undefined>(this.filePath, undefined);
    if (!parsed) return;

    let needsMigration = false;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') {
        // Old format: string value → { path, lastUsedAt: 0 }
        this.data.set(k, { path: v, lastUsedAt: 0 });
        needsMigration = true;
      } else if (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as Record<string, unknown>).path === 'string'
      ) {
        // New format: extract path and lastUsedAt (default 0 if missing)
        const obj = v as Record<string, unknown>;
        const lastUsedAt = typeof obj.lastUsedAt === 'number' ? obj.lastUsedAt : 0;
        if (typeof obj.lastUsedAt !== 'number') {
          if (obj.lastUsedAt !== undefined) {
            getLogger().warn(
              `[workspace] "${k}" has invalid lastUsedAt (${JSON.stringify(obj.lastUsedAt)}), resetting to 0`,
            );
          }
          needsMigration = true;
        }
        this.data.set(k, { path: obj.path as string, lastUsedAt });
      }
      // Non-string, non-object entries are silently skipped (existing behavior)
    }

    // Write back immediately if migration occurred
    if (needsMigration) {
      this.persist();
    }
  }

  private persist(): void {
    const obj: Record<string, WorkspaceEntryData> = {};
    for (const [k, v] of this.data) obj[k] = v;
    atomicWriteJson(this.filePath, obj);
  }

  save(name: string, dirPath: string): void {
    // 保存即视为使用（语义对齐）：新建/覆盖的 workspace 都应拿到当前
    // lastUsedAt，而不是 0，否则「最近使用」排序下新条目会沉底。
    // touch() 负责统一写入时间戳并 persist，消除 save 写 0 / use 写 now 的不对称。
    this.data.set(name, { path: dirPath, lastUsedAt: 0 });
    this.touch(name);
  }

  get(name: string): string | undefined {
    return this.data.get(name)?.path;
  }

  has(name: string): boolean {
    return this.data.has(name);
  }

  remove(name: string): void {
    this.data.delete(name);
    this.persist();
  }

  /**
   * Update lastUsedAt to now for the given alias and persist.
   * No-op if the alias does not exist.
   */
  touch(name: string): void {
    const entry = this.data.get(name);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    this.persist();
  }

  /**
   * List all workspace entries in insertion order.
   * Sorting is the caller's responsibility (view concern).
   */
  list(): WorkspaceEntry[] {
    return [...this.data.entries()].map(([name, data]) => ({
      name,
      path: data.path,
      lastUsedAt: data.lastUsedAt,
    }));
  }
}
