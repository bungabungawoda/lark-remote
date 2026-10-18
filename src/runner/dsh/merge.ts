/**
 * Merge independent async iterables into one consumer stream.
 *
 * DSH delivers a turn over `session/follow` and approvals over `$events`.
 * Both must feed one runner loop without assuming which transport emits first.
 * Source failures are rethrown to the consumer; normal source completion does
 * not end the merged stream until every source has completed.
 */
export async function* mergeAsync<T>(sources: readonly AsyncIterable<T>[]): AsyncGenerator<T> {
  const queue: T[] = [];
  const waiters: Array<() => void> = [];
  let completed = 0;
  let failure: unknown;
  let hasFailure = false;

  const wake = (): void => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  for (const source of sources) {
    void (async () => {
      try {
        for await (const item of source) {
          queue.push(item);
          wake();
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

  while (true) {
    if (hasFailure) throw failure;
    if (queue.length > 0) {
      yield queue.shift() as T;
      continue;
    }
    if (completed >= sources.length) return;
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}
