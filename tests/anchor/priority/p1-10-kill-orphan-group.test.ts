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
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeRunner } from '../../../src/runner/claude/index.js';
import { prependPath, restorePath, writeMockSource } from '../../lib/path-mock.js';
import { describePosix } from '../../lib/platform.js';
import { waitForOrThrow } from '../../lib/wait-for.js';

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

/**
 * ps 可用性探测：killOrphan 的身份校验（matchPidToBinary）依赖
 * `ps -p <pid> -o command=`。ps 被禁用的环境（沙箱 CI/受限容器）里校验恒返回
 * 'gone'，killOrphan 按设计 fail-closed 不杀任何进程——本锚点的
 * 「身份匹配 → 组杀」端到端路径无法执行，只能 skip（组杀语义在本环境由
 * p1-12-cleanup-on-exit-group 锚点覆盖，不依赖 ps）。
 */
const PS_AVAILABLE =
  spawnSync('ps', ['-p', String(process.pid), '-o', 'command='], { encoding: 'utf-8' }).status ===
  0;

describePosix('P1-10: killOrphan group kill on identity match', () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  const spawnedPids = new Set<number>();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-10-group-anchor-'));
    savedPath = prependPath(tmpDir);
  });

  afterEach(() => {
    restorePath(savedPath);
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

  it.skipIf(!PS_AVAILABLE)(
    'test_anchor_kill_orphan_kills_whole_group_when_identity_matches',
    async () => {
      const childPidFile = path.join(tmpDir, 'child.pid');
      // mock CLI 恒为 Node 启动器（path-mock 契约，见其文件头）：打印 init 后
      // 在**同一进程组**里起一个后台 sleep（不 detached → 继承 pgid），因此只有
      // 组杀 kill(-pid) 能连它一起收掉——正是本锚点要验的语义。启动器路径
      // `<tmp>/claude.mock.js` 含 "claude"，killOrphan 的 ps 身份校验
      // （`ps -o command=` 含 binary 名）可命中 → 走「身份匹配 → 组杀」路径。
      writeMockSource(
        tmpDir,
        'claude',
        `const { spawn } = require('node:child_process');
const fs = require('node:fs');
process.stdout.write(
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', cwd: '/tmp', model: 'm' }) + '\\n',
);
const child = spawn('sleep', ['300'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
      );

      const r1 = new ClaudeRunner({
        workspace: 'test',
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
      await waitForOrThrow(() => fs.existsSync(childPidFile), 3000);
      const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'));
      spawnedPids.add(childPid);

      // 模拟 bridge 重启：新 runner 实例做 killOrphan（身份匹配）
      const r2 = new ClaudeRunner({
        workspace: 'test',
        pidDir: tmpDir,
        stopGraceMs: 500,
      });
      r2.killOrphan();

      // 当前 bug：只杀组长，后台 sleep 300 存活 → waitFor 超时 → RED
      await waitForOrThrow(() => !isAlive(leaderPid) && !isAlive(childPid), 5000);
      expect(isAlive(leaderPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
      expect(fs.existsSync(pidFilePath)).toBe(false);

      await iter.return(undefined);
      spawnedPids.delete(leaderPid);
      spawnedPids.delete(childPid);
    },
  );
});
