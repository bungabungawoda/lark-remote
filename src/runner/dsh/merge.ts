/**
 * Merge independent async iterables into one consumer stream.
 *
 * DSH delivers a turn over `session/follow` and approvals over `$events`.
 * Both must feed one runner loop without assuming which transport emits first.
 * Source failures are rethrown to the consumer; normal source completion does
 * not end the merged stream until every source has completed.
 */
export interface MergeAsyncOptions {
  queueLimit?: number;
}

export async function* mergeAsync<T>(
  sources: readonly AsyncIterable<T>[],
  opts: MergeAsyncOptions = {},
): AsyncGenerator<T> {
  const queue: T[] = [];
  const consumerWaiters: Array<() => void> = [];
  const spaceWaiters: Array<() => void> = [];
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  let completed = 0;
  let failure: unknown;
  let hasFailure = false;
  const queueLimit = opts.queueLimit ?? 1024;
  let closing = false;

  const wake = (): void => {
    for (const resolve of consumerWaiters.splice(0)) resolve();
  };

  const releaseSpace = (): void => {
    if (queue.length < queueLimit) spaceWaiters.shift()?.();
  };

  const deliver = (item: T): void => {
    if (queue.length >= queueLimit) {
      spaceWaiters.push(() => undefined);
      return;
    }
    queue.push(item);
    wake();
  };

  for (const iterator of iterators) {
    void (async () => {
      try {
        while (true) {
          const result = await iterator.next();
          if (closing || result.done) break;
          if (queue.length < queueLimit) {
            deliver(result.value);
            continue;
          }
          await new Promise<void>((resolve) => {
            spaceWaiters.push(resolve);
          });
          deliver(result.value);
        }
      } catch (err) {
        if (!hasFailure) {
          hasFailure = true;
          failure = err;
        }
      } finally {
        completed += 1;
        wake();
      }
    })();
  }

  try {
    while (true) {
      if (hasFailure) throw failure;
      if (queue.length > 0) {
        yield queue.shift() as T;
        releaseSpace();
        continue;
      }
      if (completed >= sources.length) return;
      await new Promise<void>((resolve) => consumerWaiters.push(resolve));
    }
  } finally {
    wake();
    for (const resolve of spaceWaiters.splice(0)) resolve();
    closing = true;
    void Promise.all(
      iterators.map(async (iterator) => {
        await iterator.return?.();
      }),
    );
  }
}
