import { describe, it, expect } from 'vitest';
import { currentPlatform, isWin32 } from './select.js';

/**
 * select.ts 是 `process.platform` 的唯一读取点（design.md §2.2），其余模块
 * 一律走 `currentPlatform` / `isWin32(platform)`。这里锁住该契约，防止有人
 * 在别处重新散落平台判断。
 */
describe('select', () => {
  it('currentPlatform 就是宿主 process.platform', () => {
    expect(currentPlatform).toBe(process.platform);
  });

  it('isWin32 只对 win32 为真', () => {
    expect(isWin32('win32')).toBe(true);
    expect(isWin32('linux')).toBe(false);
    expect(isWin32('darwin')).toBe(false);
  });

  it('isWin32 默认取当前宿主平台', () => {
    expect(isWin32()).toBe(process.platform === 'win32');
  });
});
