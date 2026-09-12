// Anchor test: file click should send file to Feishu
// File buttons use ls.file (directory buttons use ls.browse/ls.switch)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandRouter } from '../router/index.js';
import { SessionStore } from '../session/index.js';
import type { Bridge } from '../bridge/index.js';
import type { AppConfig } from '../config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';
import { expectNoV1ActionContainer } from '../../tests/lib/card-view.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 断言对象是 `JSON.stringify` 的结果，而 win32 路径的反斜杠在 JSON 里会被
 * 转义成 `\\` —— 直接 `toContain(homeDir)`（`C:\Users\x`）在 Windows 上永远
 * 不成立。这里统一取「JSON 字符串内部形态」再比较（POSIX 上是恒等变换）。
 */
const norm = (p: string): string => JSON.stringify(p).slice(1, -1);

describe('ls file action', () => {
  let router: CommandRouter;
  let sessionStore: SessionStore;
  let mockBridge: Bridge;
  let tempDir: string;
  let testFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-file-test-'));
    testFilePath = path.join(tempDir, 'test.txt');
    fs.writeFileSync(testFilePath, 'hello world');

    sessionStore = new SessionStore();
    sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tempDir });

    mockBridge = createMockBridge();

    const config: AppConfig = {
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'claude-sonnet-4-20250514',
        effort: 'medium',
        stopGraceMs: 5000,
      },
      // 2026-07-05: idle 已合并到 /config 卡片，router 构造时读取此字段
      idle: { watchdogMinutes: 15 },
      logging: { level: 'info' },
      defaultAgent: 'claude',
    };

    router = new CommandRouter({
      sessionStore,
      bridge: mockBridge,
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
      setConfig: vi.fn(),
      setIdleTimeout: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(undefined),
      interruptCurrentRun: vi.fn().mockResolvedValue(true),
    };

    const config: AppConfig = {
      feishu: { appId: 'test', appSecret: 'test' },
      claude: {
        model: 'claude-sonnet-4-20250514',
        effort: 'medium',
        stopGraceMs: 5000,
      },
      idle: { watchdogMinutes: 15 },
      logging: { level: 'info' },
      defaultAgent: 'claude',
    };

    router = new CommandRouter({
      sessionStore,
      bridge: mockBridge,
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
    expect(bodyText).toContain(norm(homeDir));
    // The header div should show homeDir as the listed directory
    const headerDiv = card.body.elements[0];
    const headerContent = JSON.stringify(headerDiv);
    expect(headerContent).toContain(norm(homeDir));
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
    expect(bodyText).toContain(norm(projectsDir));
    // The header div should show projectsDir as the listed directory
    const headerDiv = card.body.elements[0];
    const headerContent = JSON.stringify(headerDiv);
    expect(headerContent).toContain(norm(projectsDir));
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

// ---------------------------------------------------------------------------
// /ls <file>：列出文件本身（原先直接报 "Not a directory"，用户无法确认存在性
// 或下载该文件）。
// ---------------------------------------------------------------------------

describe('ls on a file path lists the file itself', () => {
  let router: CommandRouter;
  let sessionStore: SessionStore;
  let mockBridge: ReturnType<typeof createMockBridge>;
  let tempDir: string;
  let testFilePath: string;

  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-filecard-test-'));
    testFilePath = path.join(tempDir, 'lr.zip');
    fs.writeFileSync(testFilePath, 'zip-content');

    sessionStore = new SessionStore();
    sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tempDir });
    mockBridge = createMockBridge();

    const config: AppConfig = {
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-sonnet-4-20250514', effort: 'medium', stopGraceMs: 5000 },
      idle: { watchdogMinutes: 15 },
      logging: { level: 'info' },
      defaultAgent: 'claude',
    };

    router = new CommandRouter({
      sessionStore,
      bridge: mockBridge,
      config,
      configPath: '/tmp/config.yaml',
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });
  });

  it('test_anchor_ls_file_returns_card_not_not_a_directory', async () => {
    await router.handle(`/ls ${testFilePath}`, ctx);

    const sent = mockBridge.sendResult.mock.calls[0][0];
    // 不再是 "ls: xxx: Not a directory" 文本
    expect(sent.text).toBeUndefined();
    expect(sent.card).toBeDefined();

    const bodyText = JSON.stringify((sent.card as { body: object }).body);
    expect(bodyText).not.toContain('Not a directory');
    // 展示文件本身（完整路径 + 文件名）
    expect(bodyText).toContain(norm(testFilePath));
    expect(bodyText).toContain('lr.zip');
    // 200861 铁律 + CardKit 2.0 结构断言
    expect((sent.card as { schema?: string }).schema).toBe('2.0');
    expectNoV1ActionContainer(sent.card);
  });

  it('file card offers a download button (ls.file callback)', async () => {
    await router.handle(`/ls ${testFilePath}`, ctx);
    const bodyText = JSON.stringify(
      (mockBridge.sendResult.mock.calls[0][0].card as { body: object }).body,
    );
    // 下载按钮走既有 ls.file 回调，payload 携带该文件绝对路径
    expect(bodyText).toContain('ls.file');
    expect(bodyText).toContain(norm(testFilePath));
  });

  it('file card offers an 上级 button to browse the parent directory', async () => {
    await router.handle(`/ls ${testFilePath}`, ctx);
    const bodyText = JSON.stringify(
      (mockBridge.sendResult.mock.calls[0][0].card as { body: object }).body,
    );
    expect(bodyText).toContain('ls.browse');
    expect(bodyText).toContain(norm(tempDir));
  });

  it('relative file name resolves against cwd', async () => {
    await router.handle('/ls lr.zip', ctx);
    const sent = mockBridge.sendResult.mock.calls[0][0];
    expect(sent.card).toBeDefined();
    expect(JSON.stringify((sent.card as { body: object }).body)).toContain(norm(testFilePath));
  });

  it('missing path still reports No such file or directory', async () => {
    await router.handle('/ls /nonexistent/nope.bin', ctx);
    const sent = mockBridge.sendResult.mock.calls[0][0];
    expect(sent.text).toContain('No such file or directory');
  });
});
