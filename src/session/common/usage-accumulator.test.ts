import { describe, it, expect } from 'vitest';
import { UsageAccumulator } from './usage-accumulator.js';

interface TokenComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning?: number;
  total?: number;
}

describe('UsageAccumulator', () => {
  it('新实例：count === 0；last === null；totals 六个字段全为 0', () => {
    const acc = new UsageAccumulator();
    expect(acc.count).toBe(0);
    expect(acc.last).toBeNull();
    expect(acc.totals).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
      total: 0,
    });
  });

  it('单次 add：count === 1；totals 各字段等于传入值；last 深度等于传入记录', () => {
    const acc = new UsageAccumulator();
    const record: TokenComponents = {
      input: 5,
      output: 10,
      cacheRead: 2,
      cacheCreation: 3,
      reasoning: 7,
      total: 27,
    };
    acc.add(record);
    expect(acc.count).toBe(1);
    expect(acc.totals).toEqual({
      input: 5,
      output: 10,
      cacheRead: 2,
      cacheCreation: 3,
      reasoning: 7,
      total: 27,
    });
    expect(acc.last).toEqual(record);
  });

  it('多次 add 求和', () => {
    const acc = new UsageAccumulator();
    acc.add({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    acc.add({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheCreation: 40,
      reasoning: 5,
      total: 68,
    });
    expect(acc.count).toBe(2);
    expect(acc.totals.input).toBe(11);
    expect(acc.totals.output).toBe(22);
    expect(acc.totals.cacheRead).toBe(33);
    expect(acc.totals.cacheCreation).toBe(44);
    expect(acc.totals.reasoning).toBe(5);
    expect(acc.totals.total).toBe(68);
    expect(acc.last).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheCreation: 40,
      reasoning: 5,
      total: 68,
    });
  });

  it('可选字段缺失按 0', () => {
    const acc = new UsageAccumulator();
    acc.add({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    expect(acc.totals.reasoning).toBe(0);
    expect(acc.totals.total).toBe(0);
  });

  it('get totals 返回副本：修改不影响再次读取', () => {
    const acc = new UsageAccumulator();
    acc.add({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    const t = acc.totals;
    t.input = 999;
    expect(acc.totals.input).toBe(1);
  });

  it('get last 返回副本：对返回值做字段修改不影响再次读取的值', () => {
    const acc = new UsageAccumulator();
    acc.add({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    const l = acc.last!;
    l.input = 999;
    expect(acc.last!.input).toBe(1);
  });
});
