import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import { loadJsonFile } from '../persistence/load-json-file.js';

export const MAX_ALIASES = 50;
export const MAX_ALIAS_NAME_LENGTH = 20;
export const MAX_ALIAS_TEXT_LENGTH = 200;

/**
 * 别名名称规则：`[A-Za-z_][A-Za-z0-9_]*`，≤20 字符，不能数字开头
 * —— `$500`、`$3d` 这类正常文本永远不匹配，不会误展开。
 */
export const ALIAS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface AliasEntry {
  name: string;
  text: string;
  createdAt: string;
}

/**
 * 全局别名存储。
 *
 * 独立于 OrderStore（aliases.json），避免破坏 orders.json 向后兼容。
 * 原子写（tmp + rename）+ 损坏恢复，复用 OrderStore/WorkspaceStore 同一模式。
 */
export class AliasStore {
  private filePath: string;
  private data: AliasEntry[];

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(os.homedir(), '.lark-remote', 'aliases.json');
    this.data = [];
    this.load();
  }

  /** Reload data from disk (useful when another process may have written). */
  reload(): void {
    this.load();
  }

  private load(): void {
    const parsed = loadJsonFile<AliasEntry[] | undefined>(this.filePath, undefined);
    if (!parsed || !Array.isArray(parsed)) {
      this.data = [];
      return;
    }
    const valid: AliasEntry[] = [];
    for (const e of parsed) {
      if (
        e &&
        typeof e.name === 'string' &&
        typeof e.text === 'string' &&
        typeof e.createdAt === 'string' &&
        ALIAS_NAME_PATTERN.test(e.name) &&
        e.name.length <= MAX_ALIAS_NAME_LENGTH
      ) {
        valid.push({
          name: e.name,
          text: e.text.slice(0, MAX_ALIAS_TEXT_LENGTH),
          createdAt: e.createdAt,
        });
      }
    }
    this.data = valid;
  }

  private persist(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  has(name: string): boolean {
    return this.data.some((a) => a.name === name);
  }

  get(name: string): AliasEntry | undefined {
    return this.data.find((a) => a.name === name);
  }

  list(): AliasEntry[] {
    return [...this.data];
  }

  /**
   * 注册/更新别名（同名覆盖文本，保留 createdAt）。返回写入后的条目。
   * 名称/文本/数量超限时抛错，由调用方提示用户。
   */
  set(name: string, text: string): AliasEntry {
    if (!ALIAS_NAME_PATTERN.test(name) || name.length > MAX_ALIAS_NAME_LENGTH) {
      throw new Error(
        `别名名称只能包含字母/数字/下划线，不能数字开头，且不超过 ${MAX_ALIAS_NAME_LENGTH} 字符`,
      );
    }
    if (text.length > MAX_ALIAS_TEXT_LENGTH) {
      throw new Error(`别名文本超过 ${MAX_ALIAS_TEXT_LENGTH} 字符限制`);
    }
    if (!this.has(name) && this.data.length >= MAX_ALIASES) {
      throw new Error(`别名数量已达上限 ${MAX_ALIASES}`);
    }

    const existing = this.get(name);
    const entry: AliasEntry = {
      name,
      text,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const idx = this.data.findIndex((a) => a.name === name);
    if (idx >= 0) {
      this.data[idx] = entry;
    } else {
      this.data.push(entry);
    }
    this.persist();
    return entry;
  }

  /** 删除别名；不存在返回 false。 */
  remove(name: string): boolean {
    const before = this.data.length;
    this.data = this.data.filter((a) => a.name !== name);
    if (this.data.length === before) return false;
    this.persist();
    return true;
  }
}
