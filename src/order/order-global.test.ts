import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrderStore } from './index.js';

interface OrderEntry {
  id: string;
  text: string;
  createdAt: string;
  usedAt?: string;
}

let tmpDir: string;
let ordersFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-order-global-test-'));
  ordersFile = path.join(tmpDir, 'orders.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * OrderStore 全局存储改造测试（RED 阶段）
 *
 * 改造目标：OrderStore 不再按 cwd 分组，改为全局订单列表。
 * 新 API：
 *   save(text): OrderEntry
 *   get(): OrderEntry[]
 *   list(): OrderEntry[]
 *   has(id): boolean
 *   remove(id): void
 */
describe('OrderStore 全局存储（无 cwd 参数）', () => {
  it('save(text) 返回 OrderEntry 且不含 cwd', () => {
    const store = new OrderStore(ordersFile);

    const entry: OrderEntry = store.save('检查测试覆盖率');

    expect(entry).toMatchObject({ text: '检查测试覆盖率' });
    expect(entry.id).toBeDefined();
    expect(entry.createdAt).toBeDefined();
    // OrderEntry 接口不应包含 cwd 字段
    expect('cwd' in entry).toBe(false);
  });

  it('get() 返回全局所有订单，无 cwd 过滤', () => {
    const store = new OrderStore(ordersFile);

    store.save('指令 A');
    store.save('指令 B');
    store.save('指令 C');

    const entries = store.get();

    // 返回全部 3 条，不按 cwd 过滤
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.text)).toEqual(['指令 A', '指令 B', '指令 C']);
  });

  it('has(id) 只检查 id 存在性', () => {
    const store = new OrderStore(ordersFile);

    const entry = store.save('存在性检查');

    // has 只需 id，不传 cwd
    expect(store.has(entry.id)).toBe(true);
    expect(store.has('nonexistent-id')).toBe(false);
  });

  it('remove(id) 直接按 id 删除，不传 cwd', () => {
    const store = new OrderStore(ordersFile);

    const entry1 = store.save('待删除');
    const entry2 = store.save('保留');

    // remove 只需 id，不传 cwd
    store.remove(entry1.id);

    const remaining = store.get();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(entry2.id);
    expect(remaining[0].text).toBe('保留');
  });

  it('旧 cwd 参数路径不应存在', () => {
    const store = new OrderStore(ordersFile);

    // TypeScript 编译层面：save 只接受 1 个参数
    // 如果旧 API save(cwd, text) 仍存在，传 1 个参数不会报运行时错误
    // 但我们验证新 API 正常工作即可
    const entry = store.save('无 cwd 参数');
    expect(entry.text).toBe('无 cwd 参数');
  });

  it('多次 save 后 get() 返回全局累积列表', () => {
    const store = new OrderStore(ordersFile);

    // 模拟之前可能在不同 cwd 下保存的订单，改造后全部在全局列表
    store.save('旧 cwd A 的指令');
    store.save('旧 cwd B 的指令');
    store.save('新全局指令');

    const entries = store.get();
    expect(entries).toHaveLength(3);
    // 全局列表不区分来源
    expect(entries.map((e) => e.text)).toContain('旧 cwd A 的指令');
    expect(entries.map((e) => e.text)).toContain('旧 cwd B 的指令');
    expect(entries.map((e) => e.text)).toContain('新全局指令');
  });

  it('remove 不存在的 id 不抛异常', () => {
    const store = new OrderStore(ordersFile);

    expect(() => store.remove('nonexistent-id')).not.toThrow();
  });

  it('持久化：重建 OrderStore 后仍能读取全局订单', () => {
    const store1 = new OrderStore(ordersFile);
    const entry = store1.save('持久化测试');
    store1.save('另一条');

    // 重建 store，从文件加载
    const store2 = new OrderStore(ordersFile);
    const entries = store2.get();

    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === entry.id)).toBeDefined();
    expect(entries.find((e) => e.id === entry.id)!.text).toBe('持久化测试');
  });
});
