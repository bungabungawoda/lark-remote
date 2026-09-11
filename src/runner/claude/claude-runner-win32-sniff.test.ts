/**
 * §4.4 win32 command-not-found 双条件定性回归（W1.1 从 SpawningRunner 基类
 * run() 重接到 ClaudeSession.buildStreamEndedError）。
 *
 * 独立成文件的原因：真实 isWindowsCommandNotFoundLine 在非 win32 平台恒
 * false（嗅探双条件之一），这里经 vi.mock 把 platform/spawn.js 的该函数
 * 包装为强制 win32 语义，其余导出保持原实现。
 *
 * 用例（计划 §1 要求）：
 * 1. 嗅探命中 + 非零退出 → 错误文案含「命令未找到」（定性生效）；
 * 2. 嗅探命中 + 正常 turn 收尾 → success 不受影响（防误杀）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from './index.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';
import type { AgentEvent } from '../types.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// 强制 win32 嗅探语义：其余 spawn 导出（spawnProcess/mergeProcessEnv 等）
// 保持原实现，spawnProcess 仍真实起子进程。
vi.mock('../../platform/spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/spawn.js')>();
  return {
    ...actual,
    isWindowsCommandNotFoundLine: (line: string) =>
      actual.isWindowsCommandNotFoundLine(line, 'win32'),
  };
});

let tmpDir: string;
let savedPath: string | undefined;
const runners: ClaudeRunner[] = [];

function createMockClaude(env: Record<string, string> = {}): void {
  const mockPath = path.resolve(__dirname, '../../../tests/lib/mock-claude.js');
  writeMockBin(tmpDir, 'claude', `#!/bin/bash\nexec node "${mockPath}"`);
  Object.assign(process.env, env);
}

function makeRunner(): ClaudeRunner {
  const runner = new ClaudeRunner({ workspace: 'test', pidDir: tmpDir });
  runners.push(runner);
  return runner;
}

async function collectRun(runner: ClaudeRunner): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runner.run('hello', { cwd: '/tmp' })) {
    events.push(ev);
  }
  return events;
}

const SNIFF_LINE = "'claude' is not recognized as an internal or external command.";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-sniff-test-'));
  savedPath = prependPath(tmpDir);
});

afterEach(async () => {
  for (const r of [...runners]) {
    try {
      await r.dispose();
    } catch {
      /* ignore */
    }
  }
  runners.length = 0;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MOCK_')) delete process.env[key];
  }
  restorePath(savedPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ClaudeSession win32 command-not-found 双条件定性（§4.4）', () => {
  it('test_anchor_win32_sniff_hit_nonzero_exit_names_command_not_found', async () => {
    // 嗅探命中（stderr "is not recognized"）+ 非零退出 → 错误文案点名「命令未找到」。
    createMockClaude({ MOCK_SCENARIO: 'crash', MOCK_STDERR_NOISE: SNIFF_LINE });
    const runner = makeRunner();
    const events = await collectRun(runner);

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    const result = results[0] as { subtype?: string; errorMessage?: string };
    expect(result.subtype).toBe('error');
    expect(result.errorMessage).toContain('命令未找到');
    expect(result.errorMessage).toContain('is not recognized');
    // 定性日志探针（运维可 grep）。
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('command not found confirmed'),
    );
  });

  it('test_anchor_win32_sniff_hit_normal_turn_not_affected', async () => {
    // 防误杀：嗅探命中（agent 正常输出引用错误文本）但 turn 正常收尾 →
    // result success，不受嫌疑标记影响。
    createMockClaude({ MOCK_SCENARIO: 'plain', MOCK_STDERR_NOISE: SNIFF_LINE });
    const runner = makeRunner();
    const events = await collectRun(runner);

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    const result = results[0] as { subtype?: string; errorMessage?: string };
    expect(result.subtype).toBe('success');
    expect(result.errorMessage).toBeUndefined();
  });
});
