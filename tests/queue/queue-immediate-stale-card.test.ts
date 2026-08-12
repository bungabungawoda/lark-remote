import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { _Runner } from '../../src/runner/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubRunner,
} from '../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-imm-test-'));
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

describe('queue.immediate stale card', () => {
  it('test_anchor_handleQueueImmediate_updates_cancelled_cards_for_removed_tasks', async () => {
    // Bug: handleQueueImmediate removes tasks before the target from the queue
    // via removeFromQueue, but does NOT call updateQueueCardToCancelled for
    // those removed tasks. Their queue cards remain showing "⏳ 消息排队中"
    // instead of being updated to "❌ 已撤销".

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

    // Spy on updateQueueCardToCancelled to track calls
    const cancelSpy = vi.spyOn(bridge, 'updateQueueCardToCancelled');

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
          messagePreview: 'task 2 queued',
        },
      },
    );

    // Task 3: queued behind task 1 and 2 (gets a queue card) — this is the target
    bridge.enqueue(
      tmpDir,
      async () => {
        /* quick */
      },
      {
        taskMeta: {
          userId: 'u1',
          chatId: 'c1',
          messageId: 'msg-3',
          messagePreview: 'task 3 queued',
        },
      },
    );

    // Wait for queue cards to be sent
    await new Promise((r) => setTimeout(r, 100));

    // Verify both task 2 and task 3 are in the queue
    const tasks = bridge.getQueuedTasks(tmpDir);
    expect(tasks.find((t) => t.messageId === 'msg-2')).toBeDefined();
    expect(tasks.find((t) => t.messageId === 'msg-3')).toBeDefined();

    // Simulate clicking "立即执行" on task 3's queue card
    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-3' };
    await router.handleCardAction(
      { cmd: 'queue.immediate', workspace: tmpDir, messageId: 'msg-3' },
      ctx,
    );

    // Bug: handleQueueImmediate removes task 2 from the queue but does NOT
    // call updateQueueCardToCancelled for it. Task 2's queue card remains
    // showing "⏳ 消息排队中" instead of being updated to "❌ 已撤销".
    expect(cancelSpy).toHaveBeenCalledWith(tmpDir, 'msg-2');

    // Cleanup
    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
