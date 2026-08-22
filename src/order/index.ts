import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from '../persistence/atomic-write.js';
import { loadJsonFile } from '../persistence/load-json-file.js';

export interface OrderEntry {
  id: string;
  text: string;
  createdAt: string;
  usedAt?: string;
  /** 可选别名名（该指令的 $name 触发词）。全局唯一，由 OrderStore 校验。 */
  alias?: string;
}

const MAX_TEXT_LENGTH = 200;
const MAX_ORDERS = 50;

/** 别名名称规则：`[A-Za-z_][A-Za-z0-9_]*`，≤20 字符，不能数字开头。 */
const ALIAS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ALIAS_NAME_LENGTH = 20;

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
        if (
          typeof e.alias === 'string' &&
          ALIAS_NAME_PATTERN.test(e.alias) &&
          e.alias.length <= MAX_ALIAS_NAME_LENGTH
        ) {
          entry.alias = e.alias;
        }
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

  /**
   * 修改指令文本。保留 usedAt / alias / createdAt（编辑不应重置使用统计或别名）。
   * newText===oldText 短路 persist，避免空写盘。长度 > MAX_TEXT_LENGTH 抛错（与 save 一致）。
   * 内部统一 trim：卡片（handleOrderTextInput）与 CLI（/order edit）都直接传原始文本，
   * 避免双 trim 语义混淆、也避免两条入口存出不同结果。纯空白（trim 后空）抛错。
   * @returns 更新后的 entry；id 不存在返回 undefined。
   */
  updateText(id: string, newText: string): OrderEntry | undefined {
    const trimmed = newText.trim();
    if (trimmed === '') {
      throw new Error('指令文本不能为空');
    }
    if (trimmed.length > MAX_TEXT_LENGTH) {
      throw new Error(`指令文本超过 ${MAX_TEXT_LENGTH} 字符限制`);
    }
    const entry = this.data.find((e) => e.id === id);
    if (!entry) return undefined;
    if (entry.text === trimmed) return entry; // no-op: 短路 persist
    entry.text = trimmed;
    this.persist();
    return entry;
  }

  /**
   * 给指令绑定别名（或解绑）。别名全局唯一，撞名抛错；名称必须通过
   * `ALIAS_NAME_PATTERN`（字母/数字/下划线、不能数字开头、≤20 字符）。
   * @returns 绑定后的条目。
   */
  setAlias(id: string, name: string | undefined): OrderEntry | undefined {
    const entry = this.data.find((e) => e.id === id);
    if (!entry) return undefined;

    if (name === undefined || name === '') {
      delete entry.alias;
      this.persist();
      return entry;
    }
    if (!ALIAS_NAME_PATTERN.test(name) || name.length > MAX_ALIAS_NAME_LENGTH) {
      throw new Error(
        `别名名称只能包含字母/数字/下划线，不能数字开头，且不超过 ${MAX_ALIAS_NAME_LENGTH} 字符`,
      );
    }
    const existing = this.data.find((e) => e.id !== id && e.alias === name);
    if (existing) {
      throw new Error(`别名 $${name} 已被其他指令占用`);
    }
    entry.alias = name;
    this.persist();
    return entry;
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
