/**
 * A5 anchor: runner.respondApproval(requestId, { action: 'cancel' }) 链路锁定。
 *
 * ① 验证什么：对 command 审批发送 cancel 时，runner 向 client 发送
 *    JSON-RPC 响应 { result: { decision: 'cancel' } }，并清理 pendingApprovals
 *    （同一 requestId 再次响应不得重复发送）。
 * ② 缺失/错误会导致什么：过期闭环依赖该链路把「停止等待」语义送达 server；
 *    若 cancel 被翻译错或 pending 未清理，server 会继续等待（10 分钟兜底）或
 *    收到重复/错误响应。
 * ③ 依据：bug spec R4——「respondApproval(requestId, { action: 'cancel' })
 *    向 client 发送 { decision: 'cancel' } 并清理 pendingApprovals
 *    （该逻辑已存在，需测试锁定防回归）」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionReader } from '../../../src/runner/types.js';
import { CodexAppServerRunner } from '../../../src/runner/codex/app-server/runner.js';

const FAKE_SERVER = join(process.cwd(), 'tests', 'fake-app-server', 'server.mjs');
const FIXTURES = join(process.cwd(), 'tests', 'fake-app-server', 'fixtures');

function makeSessionReader(): AgentSessionReader {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [] }),
    isSessionActive: () => false,
  };
}

describe('anchor: approval cancel response chain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-approval-cancel-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_approval_cancel_sends_decision_cancel_and_clears_pending', async () => {
    const requestLog = join(tmpDir, 'requests.jsonl');
    const cwd = join(tmpDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const wrapper = join(tmpDir, 'fake-server.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexport FAKE_SERVER_LOG="${requestLog}"\nexec "${process.execPath}" "${FAKE_SERVER}" "${join(FIXTURES, 'command-approval.json')}"\n`,
    );
    chmodSync(wrapper, 0o755);
    const runner = new CodexAppServerRunner({
      kind: 'codex',
      sessionReader: makeSessionReader(),
      binary: wrapper,
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });

    let requestedId: number | string | undefined;
    for await (const event of runner.run('do something', { cwd })) {
      if (event.type === 'approval_requested') {
        requestedId = event.requestId;
        await runner.respondApproval(event.requestId, { action: 'cancel' });
      }
    }

    expect(requestedId).toBe(1);

    // pendingApprovals 已清理：同一 requestId 再次响应不得重复发送。
    await runner.respondApproval(requestedId, { action: 'cancel' });

    const responses = readFileSync(requestLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.response && entry.response.id === 1);
    expect(responses).toHaveLength(1);
    expect(responses[0].response.result).toEqual({ decision: 'cancel' });

    await runner.dispose();
  });
});
