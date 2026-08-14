/**
 * A3 anchor: 审批过期后点击按钮必须给用户明确 error toast。
 *
 * ① 验证什么：approval.respond 卡片动作在 bridge 侧因审批已过期（submit 抛
 *    「no longer pending (state=expired)」）失败时，router 返回
 *    { toast: { type: 'error', content: 含「过期」 } }，点击者立即看到明确反馈。
 * ② 缺失/错误会导致什么：当前 handleApprovalAction 无 try/catch，handleApprovalRespond
 *    的异常直接向上抛——无 toast、无日志、SDK 回调失败，用户以为点了允许却毫无反应，
 *    只能等到 10 分钟 turn 超时（2026-08-12 实录）。
 * ③ 依据：bug spec 验收标准 C——「过期后点击审批按钮，用户收到明确 error toast，
 *    不静默不误导」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../lib/bridge-stubs.js';

describe('anchor: approval expiry user feedback', () => {
  let tmpDir: string;
  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-approval-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRouter(bridge: ReturnType<typeof createMockBridge>) {
    const sessionStore = new SessionStore();
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
    return { router };
  }

  it('test_anchor_approval_respond_expired_returns_error_toast', async () => {
    const handleApprovalRespond = vi
      .fn()
      .mockRejectedValue(new Error('Approval request 1 is no longer pending (state=expired)'));
    const { router } = createRouter(createMockBridge({ handleApprovalRespond }));

    const resp = await router.handleCardAction(
      {
        cmd: 'approval.respond',
        runId: 'run-approval-1',
        requestId: 1,
        decision: 'accept',
        nonce: 'nonce-1',
      },
      ctx,
    );

    expect(resp).toEqual({
      toast: { type: 'error', content: expect.stringContaining('过期') },
    });
  });
});
