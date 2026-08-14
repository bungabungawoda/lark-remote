/**
 * A6 anchor: 集成链路——bridge coordinator 过期 → runner.respondApproval →
 * client.respond 收到 cancel。
 *
 * ① 验证什么：ApprovalCoordinator 的过期回调通过 responder（bridge 中指向
 *    runner.respondApproval）把 { action: 'cancel' } 送达 codex app-server
 *    假服务端；同时 pushToCard 收到 approval_expired 事件；cancel 送达成功时
 *    不触发 interruptTurn。
 * ② 缺失/错误会导致什么：协调器只改内部状态（旧事故根因）时，server 收不到
 *    cancel 只能等 10 分钟兜底；responder 接线断开会留下无限等待。
 * ③ 依据：bug spec R1/R4——过期即通知 server，cancel 链路从 bridge 一直
 *    打通到 client（以 L2 bridge → runner → client seam 作为链路等价覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionReader } from '../../../src/runner/types.js';
import { ApprovalCoordinator } from '../../../src/bridge/approval-coordinator.js';
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

describe('anchor: approval expiry integration to server', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lark-approval-integration-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_anchor_approval_expiry_cancel_flows_to_server', async () => {
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

    const pushToCard = vi.fn().mockResolvedValue(undefined);
    const interruptTurn = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ApprovalCoordinator({
      runId: 'run-aaa-111',
      userId: 'user-1',
      chatId: 'chat-1',
      workspace: '/home/user/project',
      approvalTimeoutMs: 100,
      responder: async (requestId, response) => {
        await runner.respondApproval(requestId, response);
      },
      interruptTurn,
      pushToCard,
    });

    let requestedId: number | string | undefined;
    for await (const event of runner.run('do something', { cwd })) {
      if (event.type === 'approval_requested') {
        requestedId = event.requestId;
        coordinator.onRequested(event);
      }
    }

    expect(requestedId).toBe(1);
    await vi.waitFor(() => {
      expect(pushToCard).toHaveBeenCalledWith([{ type: 'approval_expired', requestId: 1 }]);
    });
    // cancel 送达成功，无需 interruptTurn 兜底。
    expect(interruptTurn).not.toHaveBeenCalled();

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
