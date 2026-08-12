import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubRunner,
} from '../lib/bridge-stubs.js';
// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  // 重置 mock
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-input-test-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue.input isBusyFor blocking', () => {
  it('test_anchor_handleQueueInput_allows_editing_queued_task_when_workspace_busy', async () => {
    // Bug: handleQueueInput checks isBusyFor(workspace) and blocks editing
    // if the workspace is busy. But the task being edited is QUEUED (not
    // executing) — editing its message preview should work even when another
    // task is running in the same workspace.

    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner();
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: new SessionReaderRegistry(),
    });

    // Task 1: starts immediately, hangs (blocks the queue)
    let release1: () => void = () => {};
    const hang1 = new Promise<void>((resolve) => {
      release1 = resolve;
    });
    bridge.enqueue(
      tmpDir,
      async () => {
        await hang1;
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-1',
          messagePreview: 'task 1 running',
        },
      },
    );

    // Give task 1 time to start
    await new Promise((r) => setTimeout(r, 50));

    // Task 2: queued behind task 1 (gets a queue card)
    bridge.enqueue(
      tmpDir,
      async () => {
        /* quick */
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-2',
          messagePreview: 'original content',
        },
      },
    );

    // Wait for queue card to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Verify task 2 is in the queue
    const task = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(task).toBeDefined();

    // Spy on isBusyFor to simulate a busy workspace (another task running)
    vi.spyOn(bridge, 'isBusyFor').mockReturnValue(true);

    // Spy on updateMessagePreview to verify it gets called
    const updateSpy = vi.spyOn(bridge, 'updateMessagePreview');

    // Simulate submitting new content via queue.input
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };
    await router.handleCardAction(
      {
        cmd: 'queue.input',
        workspace: tmpDir,
        messageId: 'msg-2',
        inputValue: 'new edited content',
      },
      ctx,
    );

    // Bug: handleQueueInput returns early when isBusyFor returns true,
    // so updateMessagePreview is never called. But the task is QUEUED —
    // editing its message should work even when the workspace is busy.
    expect(updateSpy).toHaveBeenCalledWith(tmpDir, 'msg-2', 'new edited content');

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
