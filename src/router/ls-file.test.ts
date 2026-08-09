// Anchor test: file click should send file to Feishu
// File buttons use ls.file (directory buttons use ls.browse/ls.switch)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandRouter } from '../router/index.js';
import { SessionStore, SessionReaderRegistry } from '../session/index.js';
import type { AgentSessionReader } from '../runner/index.js';
import type { Bridge } from '../bridge/index.js';
import type { AppConfig } from '../config/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Stub session reader for tests
const stubSessionReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({
    events: [],
    aiTitle: undefined,
    recap: undefined,
    displayTitle: undefined,
    usage: undefined,
    reason: 'not_found',
  }),
  isSessionActive: () => false,
};

function createStubSessionReaderRegistry(): SessionReaderRegistry {
  const registry = new SessionReaderRegistry();
  registry.register('claude', stubSessionReader);
  registry.register('codex', stubSessionReader);
  registry.register('opencode', stubSessionReader);
  registry.register('pi', stubSessionReader);
  registry.register('kimi', stubSessionReader);
  return registry;
}

type MockFn = ReturnType<typeof vi.fn>;

describe('ls file action', () => {
  let router: CommandRouter;
  let sessionStore: SessionStore;
  let mockBridge: {
    sendResult: MockFn;
    sendFile: MockFn;
    forwardToClaude: MockFn;
    isBusyFor: MockFn;
    reconnect: MockFn;
    setConfig: MockFn;
    setIdleTimeout: MockFn;
    enqueue: MockFn;
    interruptCurrentRun: MockFn;
  };
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-file-test-'));
    testFilePath = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFilePath, 'hello world');

    sessionStore = new SessionStore();
    sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tempDir });

    mockBridge = {
      sendResult: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      forwardToClaude: vi.fn(),
      isBusyFor: vi.fn().mockReturnValue(false),
      reconnect: vi.fn(),
      setConfig: vi.fn(),
      setIdleTimeout: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(undefined),
      interruptCurrentRun: vi.fn().mockResolvedValue(true),
    };

    const config: AppConfig = {
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        binary: 'claude',
        model: 'claude-sonnet-4-20250514',
        effort: 'medium',
        stopGraceMs: 5000,
      },
      // 2026-07-05: idle 已合并到 /config 卡片，router 构造时读取此字段
      idle: { watchdogMinutes: 15 },
      output: {
        showThinking: true,
        showToolUse: false,
        showToolResult: false,
      },
      logging: { level: 'info' },
      defaultAgent: 'claude',
    };

    router = new CommandRouter({
      sessionStore,
      bridge: mockBridge as unknown as Bridge,
      config,
      configPath: '/tmp/config.yaml',
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
  });

  it('should send file when clicking file button', async () => {
    // Simulate clicking file button in /ls card
    await router.handleCardAction(
      { cmd: 'ls.file', path: testFilePath },
      { userId: 'user1', chatId: 'chat1', messageId: 'msg1' },
    );

    // Should send file to Feishu, not return "路径无效"
    expect(mockBridge.sendFile).toHaveBeenCalledWith(testFilePath, expect.anything());
  });

  it('should reject file larger than 30MB', async () => {
    // Create a file larger than 30MB
    const bigFilePath = path.join(tempDir, 'big.txt');
    const largeBuffer = Buffer.alloc(31 * 1024 * 1024); // 31MB
    fs.writeFileSync(bigFilePath, largeBuffer);

    sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tempDir });

    await router.handleCardAction(
      { cmd: 'ls.file', path: bigFilePath },
      { userId: 'user1', chatId: 'chat1', messageId: 'msg1' },
    );

    expect(mockBridge.sendResult).toHaveBeenCalled();
    const result = mockBridge.sendResult.mock.calls[0][0];
    expect(result.text).toContain('30MB');
    expect(result.text).toContain('太大');
  });
});

describe('ls tilde expansion', () => {
  let router: CommandRouter;
  let sessionStore: SessionStore;
  let mockBridge: {
    sendResult: MockFn;
    sendFile: MockFn;
    forwardToClaude: MockFn;
    isBusyFor: MockFn;
    reconnect: MockFn;
    setConfig: MockFn;
    setIdleTimeout: MockFn;
    enqueue: MockFn;
    interruptCurrentRun: MockFn;
  };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-tilde-test-'));

    sessionStore = new SessionStore();
    sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tempDir });

    mockBridge = {
      sendResult: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      forwardToClaude: vi.fn(),
      isBusyFor: vi.fn().mockReturnValue(false),
      reconnect: vi.fn(),
      setConfig: vi.fn(),
      setIdleTimeout: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(undefined),
      interruptCurrentRun: vi.fn().mockResolvedValue(true),
    };

    const config: AppConfig = {
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        binary: 'claude',
        model: 'claude-sonnet-4-20250514',
        effort: 'medium',
        stopGraceMs: 5000,
      },
      idle: { watchdogMinutes: 15 },
      output: {
        showThinking: true,
        showToolUse: false,
        showToolResult: false,
      },
      logging: { level: 'info' },
      defaultAgent: 'claude',
    };

    router = new CommandRouter({
      sessionStore,
      bridge: mockBridge as unknown as Bridge,
      config,
      configPath: '/tmp/config.yaml',
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
  });

  it('test_anchor_ls_tilde_expands_to_home', async () => {
    // /ls ~ should list the home directory, not fallback to cwd
    await router.handle('/ls ~', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    // The card header or body should reference the home directory path,
    // not the cwd (tempDir). path.resolve does NOT expand ~,
    // so current code resolves to "<cwd>/~" which doesn't exist → falls back to cwd.
    const homeDir = os.homedir();
    expect(mockBridge.sendResult).toHaveBeenCalled();
    const sentCard = mockBridge.sendResult.mock.calls[0][0];
    const card = sentCard.card;
    expect(card).toBeDefined();
    // The card body first element shows the targetDir in backticks
    const bodyText = JSON.stringify(card.body.elements);
    expect(bodyText).toContain(homeDir);
    // The header div should show homeDir as the listed directory
    const headerDiv = card.body.elements[0];
    const headerContent = JSON.stringify(headerDiv);
    expect(headerContent).toContain(homeDir);
  });

  it('test_anchor_ls_tilde_with_subpath_expands_correctly', async () => {
    // /ls ~/projects should list home/projects directory
    const homeDir = os.homedir();
    const projectsDir = path.join(homeDir, 'projects');
    // Ensure ~/projects exists so the test is about tilde expansion, not missing dir
    fs.mkdirSync(projectsDir, { recursive: true });

    await router.handle('/ls ~/projects', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    expect(mockBridge.sendResult).toHaveBeenCalled();
    const sentCard = mockBridge.sendResult.mock.calls[0][0];
    const card = sentCard.card;
    expect(card).toBeDefined();
    const bodyText = JSON.stringify(card.body.elements);
    expect(bodyText).toContain(projectsDir);
    // The header div should show projectsDir as the listed directory
    const headerDiv = card.body.elements[0];
    const headerContent = JSON.stringify(headerDiv);
    expect(headerContent).toContain(projectsDir);
  });

  it('test_anchor_ls_invalid_path_returns_error_not_fallback', async () => {
    // /ls /nonexistent/path should return an error, not silently show cwd
    await router.handle('/ls /nonexistent/path/that/does/not/exist', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    // Current behavior: path.resolve succeeds but existsSync fails,
    // so it silently falls back to listing cwd.
    // Expected: should return an error indicating the path doesn't exist.
    expect(mockBridge.sendResult).toHaveBeenCalled();
    const sentCard = mockBridge.sendResult.mock.calls[0][0];
    const card = sentCard.card;
    if (card) {
      // If a card is returned, it must NOT show the cwd as if nothing happened
      const bodyText = JSON.stringify(card.body.elements);
      expect(bodyText).not.toContain(tempDir);
    } else {
      // If text is returned, it should mention the path is invalid
      const text = sentCard.text ?? '';
      expect(text).toMatch(/不存在|无效|No such|not found|invalid/i);
    }
  });
});
