/**
 * 共享的轮询 helper。
 *
 * 此前 20+ 个测试文件各自复制了一份 `sleep` + `waitFor`（DRY），统一到这里。
 * 语义与主流副本完全一致：waitFor 轮询 10ms，超时返回 false（不抛错）。
 * 需要「超时即 throw」语义的测试请保留自己的变体。
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a condition with real waits; returns false on timeout. */
export async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

/**
 * Poll a condition with real waits; throws on timeout.
 *
 * 与 waitFor 的区别：超时即抛错（waitFor 返回 false）。6 个 p1 测试此前
 * 各自复制了同一实现，仅默认超时不同（3000/5000），统一收敛到这里。
 */
export async function waitForOrThrow(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
