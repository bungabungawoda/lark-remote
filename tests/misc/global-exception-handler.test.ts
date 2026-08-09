/**
 * 红 agent - Round 1 anchor 测试
 *
 * 验收标准：
 * 1. 全局 uncaughtException 处理器被调用并记录日志
 * 2. 全局 unhandledRejection 处理器被调用并记录日志
 * 3. 全局处理器在进程退出前释放 instanceLock
 * 4. 进程不会因为未捕获异常而无声退出
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
  let tempDir: string;
  let pidFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-remote-test-'));
    pidFilePath = path.join(tempDir, 'test.pid');
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(pidFilePath)) {
      fs.unlinkSync(pidFilePath);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('应该存在 uncaughtException 全局处理器', () => {
    // 验证 src/index.ts 导入了 uncaughtException 处理器相关代码
    // 或者检查 process.listeners('uncaughtException')
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');

    // 期望：代码中应该注册 uncaughtException 处理器
    expect(indexContent).toMatch(/process\.on\(['"]uncaughtException['"]/);
  });

  it('应该存在 unhandledRejection 全局处理器', () => {
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');

    // 期望：代码中应该注册 unhandledRejection 处理器
    expect(indexContent).toMatch(/process\.on\(['"]unhandledRejection['"]/);
  });

  it('uncaughtException 处理器应该记录错误日志', () => {
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');

    // 期望：处理器应该调用 logger.error 记录错误
    expect(indexContent).toMatch(
      /uncaughtException.*logger\.error|logger\.error.*uncaughtException/s,
    );
  });

  it('unhandledRejection 处理器应该记录错误日志', () => {
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');

    // 期望：处理器应该调用 logger.error 记录错误
    expect(indexContent).toMatch(
      /unhandledRejection.*logger\.error|logger\.error.*unhandledRejection/s,
    );
  });

  it('全局处理器应该释放 instanceLock 资源', () => {
    const indexContent = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf-8');

    // 期望：处理器应该调用 instanceLock.release() 或类似清理方法
    expect(indexContent).toMatch(/release\(\)|instanceLock\.release/i);
  });
});
