/**
 * Anchor Test: P1-10/P1-12 — killOrphan 身份匹配时杀整个进程组
 *
 * ① 验证什么行为：
 *   当 pid 文件里的 pid 身份与 runner.binary 匹配时，killOrphan() 必须杀整个
 *   进程组（负 pid SIGTERM，与 ProcessStopper 对齐）——agent 自己启动的后台
 *   子进程（如工具调用起的 `sleep 300 &`）不能成为孤儿存活。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前 killOrphan 只 `process.kill(pid, 'SIGTERM')` 杀组长：spawn 用
 *   detached:true，agent 是进程组组长，组长死后组内子进程被 reparent 继续运行
 *   （review §P1-10「它只杀单 pid 不杀进程组……即使杀对了，agent 的子进程仍
 *   孤儿化，与 ProcessStopper 的 kill(-pid) 语义自相矛盾」；同 §P1-12）。
 *
 * ③ 依据：review.md §P1-10 修复建议「杀进程用 process.kill(-pid, 'SIGTERM')
 *   杀整个组（与 ProcessStopper 对齐）」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from '../../../src/runner/claude/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P1-10: killOrphan group kill on identity match', () => {
  let tmpDir: string;
  const spawnedPids = new Set<number>();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-10-group-anchor-'));
  });

  afterEach(() => {
    for (const pid of spawnedPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
    spawnedPids.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_kill_orphan_kills_whole_group_when_identity_matches', async () => {
    const childPidFile = path.join(tmpDir, 'child.pid');
    const mockBin = path.join(tmpDir, 'mock-claude');
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"m"}'
sleep 300 &
echo $! > "${childPidFile}"
# 前台 sleep 保持 bash 身份（ps command 含 mockBin 路径，身份校验可命中）
sleep 300
`,
      { mode: 0o755 },
    );

    const r1 = new ClaudeRunner({
      workspace: 'test',
      binary: mockBin,
      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    const iter = r1.run('hello', { cwd: '/tmp' });
    const first = await iter.next();
    expect(first.done).toBe(false);

    const pidFilePath = path.join(tmpDir, 'claude-test.pid');
    const leaderPid = Number(fs.readFileSync(pidFilePath, 'utf-8'));
    expect(leaderPid).toBeGreaterThan(0);
    spawnedPids.add(leaderPid);
    await waitFor(() => fs.existsSync(childPidFile), 3000);
    const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'));
    spawnedPids.add(childPid);

    // 模拟 bridge 重启：新 runner 实例做 killOrphan（身份匹配）
    const r2 = new ClaudeRunner({
      workspace: 'test',
      binary: mockBin,
      pidDir: tmpDir,
      stopGraceMs: 500,
    });
    r2.killOrphan();

    // 当前 bug：只杀组长，后台 sleep 300 存活 → waitFor 超时 → RED
    await waitFor(() => !isAlive(leaderPid) && !isAlive(childPid), 5000);
    expect(isAlive(leaderPid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    expect(fs.existsSync(pidFilePath)).toBe(false);

    await iter.return(undefined);
    spawnedPids.delete(leaderPid);
    spawnedPids.delete(childPid);
  });
});
