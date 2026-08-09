import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import { loadJsonFile } from '../persistence/load-json-file.js';

interface OrderEntry {
  id: string;
  text: string;
  createdAt: string;
  usedAt?: string;
}

const MAX_TEXT_LENGTH = 200;
const MAX_ORDERS = 50;

/**
 * Global persistent order store.
 *
 * Atomic write (tmp + rename) and corrupt-file recovery,
 * following the same pattern as WorkspaceStore.
 */
export class OrderStore {
  private filePath: string;
  private data: OrderEntry[];

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(os.homedir(), '.lark-remote', 'orders.json');
    this.data = [];
    this.load();
  }

  /** Reload data from disk (useful when another process may have written) */
  reload(): void {
    this.load();
  }

  private load(): void {
    const parsed = loadJsonFile<OrderEntry[] | undefined>(this.filePath, undefined);
    if (!parsed) {
      this.data = [];
      return;
    }
    if (!Array.isArray(parsed)) {
      this.data = [];
      return;
    }
    const valid: OrderEntry[] = [];
    for (const e of parsed) {
      if (
        e &&
        typeof e.id === 'string' &&
        typeof e.text === 'string' &&
        typeof e.createdAt === 'string'
      ) {
        const entry: OrderEntry = {
          id: e.id,
          text: e.text.slice(0, MAX_TEXT_LENGTH),
          createdAt: e.createdAt,
        };
        if (typeof e.usedAt === 'string') entry.usedAt = e.usedAt;
        valid.push(entry);
      }
    }
    this.data = valid;
  }

  private persist(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  save(text: string): OrderEntry {
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`指令文本超过 ${MAX_TEXT_LENGTH} 字符限制`);
    }
    if (this.data.length >= MAX_ORDERS) {
      throw new Error(`指令数量已达上限 ${MAX_ORDERS}`);
    }
    const entry: OrderEntry = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    this.data.push(entry);
    this.persist();
    return entry;
  }

  updateUsedAt(id: string): void {
    const entry = this.data.find((e) => e.id === id);
    if (entry) {
      entry.usedAt = new Date().toISOString();
      this.persist();
    }
  }

  get(): OrderEntry[] {
    return [...this.data];
  }

  has(id: string): boolean {
    return this.data.some((e) => e.id === id);
  }

  remove(id: string): void {
    this.data = this.data.filter((e) => e.id !== id);
    this.persist();
  }
}
