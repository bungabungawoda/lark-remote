/**
 * Anchor Test: P1-9 — codex pid 文件必须 workspace-scoped，并发 run 不互杀
 *
 * ① 验证什么行为：
 *   CodexExecRunner({ workspace: 'wsA' }) 的 pid 文件必须是
 *   `<pidDir>/codex-wsA.pid`（带 workspace 后缀）；两个 workspace 并发 codex run
 *   时，后创建 runner 的 killOrphan() 只能看自己的 pid 文件，不得杀掉先启动 run
 *   的进程。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前实现 CodexExecRunner 连 workspace 选项都没有，pid 文件全局共享为
 *   `<pidDir>/codex.pid`。bridge 队列按 workspace 独立，workspace B 的
 *   getRunner(B) → killOrphan() 读到 workspace A 的 codex.pid=pidA 后直接
 *   SIGTERM，把 A 正在运行的进程杀掉（A 侧用户看到 "killed by signal SIGTERM"，
 *   无任何 A 侧操作）；A 的 run() finally 还会 unlink 掉 B 的追踪文件，B 崩溃后
 *   killOrphan 再也找不到残留进程。
 *
 * ③ 依据：review.md §P1-9「codex/opencode/pi/kimi 的 pid 文件跨 workspace 冲突：
 *   并发 run 互相误杀」，原失败用例为两个 workspace 并发 codex run 时后启动的
 *   killOrphan 不得杀掉先启动的 run；修复建议①给 CodexExecRunnerOptions 增加
 *   workspace 字段并透传给 super()。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexExecRunner } from '../../../src/runner/codex/index.js';

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

const mockSessionReader = {
  listSessions: vi.fn().mockReturnValue({ sessions: [], total: 0 }),
  getNewestSession: vi.fn().mockReturnValue(null),
  readSessionContent: vi.fn().mockReturnValue({ events: [] }),
  isSessionActive: vi.fn().mockReturnValue(false),
};

/** Processes spawned by this test file, force-killed in afterEach to avoid leaks. */
const spawnedPids = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('P1-9: codex pid file workspace scoping', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-9-codex-anchor-'));
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

  function createMockCodex(script: string): string {
    const scriptPath = path.join(tmpDir, 'mock-codex');
    fs.writeFileSync(
      scriptPath,
      `#!/bin/bash\n# Read stdin (prompt), then execute script\nread -r _PROMPT\n${script}`,
      'utf-8',
    );
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it('test_anchor_codex_pid_file_workspace_scoped_and_kill_orphan_does_not_kill_sibling_run', async () => {
    const mockCodex = createMockCodex(`
      echo '{"type":"thread.started","thread_id":"t1","cwd":"/tmp","model":"m"}'
      exec sleep 60
    `);

    const r1 = new CodexExecRunner({
      binary: mockCodex,
      pidDir: tmpDir,
      workspace: 'wsA',
      sessionReader: mockSessionReader,
    });
    const iter1 = r1.run('hello', { cwd: '/tmp' });
    const first1 = await iter1.next();
    // run() 在 spawn 成功后、迭代 stdout 前同步写 pid 文件；拿到第一个事件时文件必已在盘上
    expect(first1.done).toBe(false);

    const pidFileA = path.join(tmpDir, 'codex-wsA.pid');
    const sharedPidFile = path.join(tmpDir, 'codex.pid');
    expect(fs.existsSync(pidFileA)).toBe(true); // 当前 bug：只有 codex.pid，无 workspace 后缀
    expect(fs.existsSync(sharedPidFile)).toBe(false);
    const pidA = Number(fs.readFileSync(pidFileA, 'utf-8'));
    expect(pidA).toBeGreaterThan(0);
    spawnedPids.add(pidA);

    // workspace B 的 runner 创建路径（bridge getRunner 的 killOrphan 行为）
    const r2 = new CodexExecRunner({
      binary: mockCodex,
      pidDir: tmpDir,
      workspace: 'wsB',
      sessionReader: mockSessionReader,
    });
    r2.killOrphan();

    // 当前 bug：r2 读到共享 codex.pid=pidA 直接 SIGTERM → 这里 throw → RED
    expect(() => process.kill(pidA, 0)).not.toThrow();

    await r1.stop({ immediate: true });
    await iter1.return(undefined);
    spawnedPids.delete(pidA);
    // SIGKILL 后子进程可能短暂处于 zombie 态（kill(pid,0) 仍成功），轮询等真实回收
    await waitFor(() => !isAlive(pidA));
  });
});
