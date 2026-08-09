import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import { loadJsonFile } from '../persistence/load-json-file.js';

/**
 * Persistent named-alias store for workspace directories.
 *
 * Atomic write (§9.10): writes a temp file then `fs.rename` so a crash
 * mid-write cannot leave a truncated JSON file. On load, a corrupt file
 * is treated as empty (with a warning) so the bridge can still start.
 */
export class WorkspaceStore {
  private filePath: string;
  private data: Map<string, string>;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(os.homedir(), '.lark-remote', 'workspace.json');
    this.data = new Map();
    this.load();
  }

  private load(): void {
    const parsed = loadJsonFile<Record<string, string> | undefined>(this.filePath, undefined);
    if (!parsed) return;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') this.data.set(k, v);
    }
  }

  private persist(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.data) obj[k] = v;
    atomicWriteJson(this.filePath, obj);
  }

  save(name: string, dirPath: string): void {
    this.data.set(name, dirPath);
    this.persist();
  }

  get(name: string): string | undefined {
    return this.data.get(name);
  }

  has(name: string): boolean {
    return this.data.has(name);
  }

  remove(name: string): void {
    this.data.delete(name);
    this.persist();
  }

  list(): [string, string][] {
    return [...this.data.entries()];
  }
}
