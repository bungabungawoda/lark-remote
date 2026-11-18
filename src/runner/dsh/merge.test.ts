import { describe, expect, it } from 'vitest';

import { mergeAsync } from './merge.js';

function immediateSource(values: readonly number[]): {
  iterable: AsyncIterable<number>;
  calls: () => number;
} {
  let index = 0;
  let callCount = 0;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<number>> {
            callCount += 1;
            if (index < values.length) {
              const value = values[index] as number;
              index += 1;
              return { value, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
    calls: () => callCount,
  };
}

describe('mergeAsync', () => {
  it('bounds source iteration while a slow consumer leaves the queue full', async () => {
    const sourceA = immediateSource([1, 3, 5, 7, 9, 11, 13, 15]);
    const sourceB = immediateSource([2, 4, 6, 8, 10, 12, 14, 16]);
    const merged = mergeAsync([sourceA.iterable, sourceB.iterable], { queueLimit: 2 });
    const first = merged.next();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sourceA.calls() + sourceB.calls()).toBeLessThanOrEqual(5);

    const collected: number[] = [(await first).value as number];
    for (let index = 1; index < 16; index += 1) {
      const result = await merged.next();
      if (result.done) break;
      collected.push(result.value as number);
    }

    expect(collected).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(new Set(collected).size).toBe(collected.length);
  });
});
