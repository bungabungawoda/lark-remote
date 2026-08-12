/**
 * 全局异常处理器 wiring 守卫
 *
 * 保留的 2 个断言是 index.ts 全局异常处理器 process.on 注册的唯一守卫。
 * 宽松正则的日志/锁断言已删除（近乎恒真，不提供实际覆盖）。
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock logger
vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
  }),
  initLogger: vi.fn(),
}));

describe('全局异常处理器 - anchor 测试', () => {
  it('应该存在 uncaughtException 全局处理器', () => {
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');
    expect(indexContent).toMatch(/process\.on\(['"]uncaughtException['"]/);
  });

  it('应该存在 unhandledRejection 全局处理器', () => {
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');
    expect(indexContent).toMatch(/process\.on\(['"]unhandledRejection['"]/);
  });
});
