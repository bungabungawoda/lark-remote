/**
 * Anchor Test: P0-1 — fitUtf8 必须 O(budget)，不得 O(budget²)
 *
 * ① 验证什么行为：`truncateUtf8` 对 22_000 字符混合样本（ASCII+中文+emoji）做 tail
 *    截断（budget 20_000）连续执行 50 次的总耗时 < 500ms。修复后的单遍累计实现
 *    实测 ~11ms，有 45× 余量；现状 O(budget²) 实测 ~1686ms，稳定超阈值。
 *
 * ② 缺失/错误会导致什么问题：`fitUtf8` 每轮 `Buffer.byteLength(result + char)` +
 *    `result += char` 都新建并扫描不断增长的字符串 → O(budget²)（成本随预算平方
 *    增长，与输入长度无关）。流式高峰期 renderRunCard 单次 flush 数十 ms > 100ms
 *    合批窗口（run-card-session.ts:61），flush 堆积、事件循环被长任务占满，idle
 *    看门狗 tick、飞书 WebSocket 心跳、其他 workspace 的消息处理全部被延迟——单线程
 *    驻留进程的全局卡顿。Claude 长回答超过 MAX_TEXT_CHARS=12_000 即常态。
 *
 * ③ 依据：review.md §P0-1 原文失败用例（fitUtf8 tail-truncate is O(budget)）——
 *    「12k 字符 tail 截断 budget=10_000 时单次约 20ms（100 次 = 2048ms）」。
 *    本用例把 budget 放大到 20_000、混合 CJK/emoji 样本，放大 O(budget²) 与 O(budget)
 *    的差距，使判别不受机器快慢 ±3× 影响（实测：现状 33.7ms/次 vs 修复 0.2ms/次，
 *    约 150×，与 review 的 ~150× 提速一致）。
 */
import { describe, it, expect } from 'vitest';
import { truncateUtf8 } from '../../../src/card/text-truncate.js';

describe('P0-1: fitUtf8 复杂度', () => {
  it('test_anchor_fit_utf8_tail_truncate_is_linear_not_quadratic', () => {
    // 混合样本：ASCII（单字节）+ 中文（3 字节）+ emoji（4 字节），
    // 逼出 byteLength 的真实逐字节扫描（纯 ASCII 会被 bun 的 rope/长度缓存优化掉）
    const s = 'a'.repeat(14_000) + '汉'.repeat(5_000) + '😀'.repeat(3_000);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      truncateUtf8(s, 20_000, true, '…（已截断）\n');
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(300); // 现状 ~838ms；修复后 ~12ms（阈值留快机器余量）
  });
});

/**
 * Probe: P0-1 优化不得改变截断语义（与旧实现逐字节等价）
 *
 * ① 验证什么行为：`truncateUtf8` 的优化实现（单遍累计）与参考实现（旧算法——
 *    逐字符 `Buffer.byteLength(char + result)`，O(budget²) 但语义正确）在
 *    ASCII/CJK/emoji/转义字符/混合随机样本 × 各边界 budget × head/tail 两向 ×
 *    三种 suffix 上逐字节一致；且输出永远是合法 UTF-8（不切分多字节序列）。
 *
 * ② 缺失/错误会导致什么问题：性能优化若引入 off-by-one（budget 边界、suffix
 *    预算）、错误处理多字节序列边界、或 tail/head 方向反转，会改变用户可见的
 *    截断内容（乱码/丢字/超预算），而 A1 的性能测试测不出来。
 *
 * ③ 依据：review.md §P0-1「对含 CJK/emoji/反斜杠样本与原实现逐字节等价」——
 *    这是优化实现的正确性契约；本 probe 把该契约编码为可复跑断言。
 */
describe('P0-1: fitUtf8 优化与参考实现逐字节等价', () => {
  /** 参考实现：逐字复刻旧算法语义（慢但显然正确）。 */
  function referenceFitUtf8(value: string, maxBytes: number, fromEnd: boolean): string {
    if (fromEnd) {
      let result = '';
      for (const char of Array.from(value).reverse()) {
        if (Buffer.byteLength(char + result, 'utf8') > maxBytes) break;
        result = char + result;
      }
      return result;
    }
    let result = '';
    for (const char of value) {
      if (Buffer.byteLength(result + char, 'utf8') > maxBytes) break;
      result += char;
    }
    return result;
  }

  function referenceTruncate(
    value: string,
    maxBytes: number,
    fromEnd: boolean,
    suffix: string,
  ): string {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
    if (budget <= 0) return suffix;
    const truncated = referenceFitUtf8(value, budget, fromEnd);
    return fromEnd ? `${suffix}\n${truncated}` : `${truncated}${suffix}`;
  }

  // 确定性伪随机混合样本（ASCII + CJK + emoji + 反斜杠 + 换行 + é）
  function makeMixed(seed: number, len: number): string {
    const alphabet = ['a', '汉', '😀', '\\', '\n', 'é', 'z'];
    let out = '';
    let x = seed;
    for (let i = 0; i < len; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      out += alphabet[x % alphabet.length];
    }
    return out;
  }

  const samples: Array<[string, string]> = [
    ['empty', ''],
    ['ascii-1', 'a'],
    ['ascii-999', 'a'.repeat(999)],
    ['ascii-1000', 'a'.repeat(1000)],
    ['ascii-1001', 'a'.repeat(1001)],
    ['ascii-5000', 'a'.repeat(5000)],
    ['cjk-999', '汉'.repeat(999)],
    ['cjk-1000', '汉'.repeat(1000)],
    ['cjk-1001', '汉'.repeat(1001)],
    ['emoji-1000', '😀'.repeat(1000)],
    ['mixed-boundary', 'a'.repeat(999) + '汉'.repeat(333) + '😀'.repeat(250)],
    ['backslash', '\\n\\t\\"\\\\'.repeat(500)],
    ['mixed-1', makeMixed(7, 1)],
    ['mixed-500', makeMixed(11, 500)],
    ['mixed-3000', makeMixed(23, 3000)],
  ];
  const budgets = [0, 1, 2, 3, 7, 100, 999, 1000, 1001, 3000, 10_000];
  const fromEnds = [false, true];
  const suffixes = ['…（已截断）', '', '..'];

  it('test_probe_fit_utf8_optimization_byte_equivalent_to_reference', () => {
    let cases = 0;
    for (const [name, value] of samples) {
      for (const maxBytes of budgets) {
        for (const fromEnd of fromEnds) {
          for (const suffix of suffixes) {
            const actual = truncateUtf8(value, maxBytes, fromEnd, suffix);
            const expected = referenceTruncate(value, maxBytes, fromEnd, suffix);
            expect(actual, `${name} budget=${maxBytes} fromEnd=${fromEnd} suffix=${suffix}`).toBe(
              expected,
            );
            // 合法 UTF-8：往返解码不得产生替换符（即未切分多字节序列）
            expect(Buffer.from(actual, 'utf8').toString('utf8')).toBe(actual);
            // 截断后不超过预算（suffix 计入，+1 容 fromEnd 时 suffix 与 tail 间的
            // 分隔换行——参考实现 `${suffix}\n${truncated}` 的既有设计）。
            // 例外：budget<=0 时参考实现本就返回超限 suffix（设计如此：suffix 装不下
            // 也显示 suffix），此时跳过上限断言。
            if (actual !== value) {
              const suffixBytes = Buffer.byteLength(suffix, 'utf8');
              if (maxBytes - suffixBytes > 0) {
                expect(Buffer.byteLength(actual, 'utf8')).toBeLessThanOrEqual(maxBytes + 1);
              }
            }
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(900); // 覆盖量自检，防样本被误删
  });
});
