/**
 * Anchor Test: P1-9 — opencode pid 文件必须 workspace-scoped
 *
 * ① 验证什么行为：
 *   OpencodeExecRunner({ workspace: 'wsX' }) 的 pid 文件路径必须是
 *   `<pidDir>/opencode-wsX.pid`（带 workspace 后缀），而不是全局共享的
 *   `<pidDir>/opencode.pid`。
 *
 * ② 缺失/错误会导致什么问题：
 *   当前 OpencodeExecRunner 连 workspace 选项都没有（构造不传给 super），
 *   与 codex 同根：所有 workspace 共享 opencode.pid。bridge 队列按 workspace
 *   独立，两个 workspace 的 opencode run 并发时，后启动 runner 的 killOrphan
 *   读到先启动 run 的 pid 直接 SIGTERM 误杀（review §P1-9 前因后果 2）。
 *
 * ③ 依据：review.md §P1-9「codex/opencode/pi/kimi 的 pid 文件跨 workspace
 *   冲突」修复建议①：给 OpencodeExecRunnerOptions 增加 workspace 字段并透传
 *   给 super()。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OpencodeExecRunner } from '../../../src/runner/opencode/index.js';

describe('P1-9: opencode pid file workspace scoping', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_anchor_opencode_pid_file_workspace_scoped', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-9-opencode-anchor-'));
    const runner = new OpencodeExecRunner({
      pidDir: tmpDir,
      workspace: 'wsX',
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });

    const pidFilePath = (runner as unknown as { pidFilePath: string }).pidFilePath;
    // 当前 bug：pidFilePath = <pidDir>/opencode.pid（无 workspace 后缀）→ RED
    expect(pidFilePath).toBe(path.join(tmpDir, 'opencode-wsX.pid'));
  });
});
