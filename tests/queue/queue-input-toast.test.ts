import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../src/bridge/index.js';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Runner } from '../../src/runner/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubRunner,
  createStubConnector,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-queue-input-toast-'));
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

describe('queue.input returns toast instead of sending message', () => {
  it('test_anchor_queue_input_returns_success_toast', async () => {
    // Bug: 编辑排队消息提交后，handleQueueInput 调 sendResult({ text: '✅ 消息已更新' })
    // 发了一条正文消息，冗余。应改为返回 CardActionResponse toast，由 SDK 作为飞书
    // 回调响应给点击用户即时反馈，不再发送正文。
    // 链路：connector cardAction listener return + index.ts return + router return toast。

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

    // Enqueue a task so there's a queued message to edit
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
        taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-1', messagePreview: 'task 1' },
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    bridge.enqueue(tmpDir, async () => {}, {
      taskMeta: { userId: 'u1', chatId: 'c1', messageId: 'msg-2', messagePreview: 'original' },
    });
    await new Promise((r) => setTimeout(r, 100));

    const ctx = { userId: 'u1', chatId: 'c1', messageId: 'msg-card-2' };

    // Submit edited content via queue.input
    const result = await router.handleCardAction(
      { cmd: 'queue.input', workspace: tmpDir, messageId: 'msg-2', inputValue: 'edited message' },
      ctx,
    );

    // Assert: returns a CardActionResponse with a success toast AND an
    // in-place card update (card.data) so Feishu renders the updated queue
    // card and closes the edit form. A toast-only response leaves the card
    // stuck in edit state (Feishu keeps the pre-click card when the callback
    // response has no `card` field).
    expect(result).toMatchObject({ toast: { type: 'success', content: '消息已更新' } });
    expect(result).toMatchObject({ card: { type: 'raw' } });
    expect((result as { card?: { data?: { schema?: string } } }).card?.data?.schema).toBe('2.0');

    // Assert: did NOT send a separate "✅ 消息已更新" text message
    const sentTexts = connector._sent
      .map((s) => (s.input as { text?: string } | undefined)?.text)
      .filter((t): t is string => typeof t === 'string');
    expect(sentTexts).not.toContain('✅ 消息已更新');

    release1();
    await new Promise((r) => setTimeout(r, 100));
  });
});
