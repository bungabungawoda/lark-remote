/**
 * 共享的 logger mock —— 测试骨架收口（2026-09-21）。
 *
 * 背景：仓库里上百个测试文件各自抄了一份一模一样的 12 行骨架：
 *   const { mockLogger } = vi.hoisted(() => ({ mockLogger: { debug: vi.fn(), ... } }));
 *   vi.mock('<P>/logger/index.js', () => ({ getLogger: () => mockLogger, initLogger: () => mockLogger }));
 * 骨架重复度实测：155/377 个测试文件重复同一份 logger mock（其中 102 份连
 * `vi.hoisted` 块一起抄）。这里把它收成一份，调用方只剩两行：
 *
 *   vi.mock('<P>/logger/index.js', async () =>
 *     (await import('<rel>/tests/lib/logger-mock.js')).loggerModuleMock());
 *   import { mockLogger } from '<rel>/tests/lib/logger-mock.js';
 *
 * 为什么是 async + dynamic import：`vi.mock` 的工厂会被提升到文件顶部，**不能**
 * 引用文件作用域的变量（这正是原骨架必须塞一个 `vi.hoisted` 的原因）。dynamic
 * import 让工厂拿到本模块里**同一个** mockLogger 实例，所以测试体里的
 * `mockLogger.warn.mockReset()` / `expect(mockLogger.error).toHaveBeenCalledWith(...)`
 * 依然作用在同一个 vi.fn() 上，断言面完全不变。
 *
 * 需要「本文件独享的 logger mock」（断言/重置互不干扰）时，仍可在该文件里自行
 * `vi.hoisted` —— 本 helper 不强制所有文件迁移。
 */
import { vi } from 'vitest';

/** 被测代码 `getLogger()` / `initLogger()` 返回的那个对象。 */
export const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** `vi.mock('.../logger/index.js')` 的工厂返回值。 */
export function loggerModuleMock(): {
  getLogger: () => typeof mockLogger;
  initLogger: () => typeof mockLogger;
} {
  return { getLogger: () => mockLogger, initLogger: () => mockLogger };
}
