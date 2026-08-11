import { describe, it, expect, vi } from 'vitest';
import { CommandRouter } from './index.js';
import { SessionStore, SessionReaderRegistry } from '../session/index.js';
import type { AgentSessionReader } from '../runner/index.js';
import type { Bridge } from '../bridge/index.js';
import type { AppConfig } from '../config/index.js';
import { MAX_FILE_UPLOAD_SIZE } from '../connector/file-limits.js';
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

describe('file upload size limit: 30MB', () => {
  it('MAX_FILE_UPLOAD_SIZE constant equals 30MB', () => {
    expect(MAX_FILE_UPLOAD_SIZE).toBe(30 * 1024 * 1024);
  });

  it('router cardLsFile rejects files > 30MB with 30MB in message', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-limit-test-'));
    // 31MB file (> 30MB limit)
    const bigFilePath = path.join(tempDir, 'big-31mb.txt');
    fs.writeFileSync(bigFilePath, Buffer.alloc(31 * 1024 * 1024));

    const sessionStore = new SessionStore();
    sessionStore.set('user1', {
      sessions: new Map(),
      previousSessions: new Map(),
      arrivalSessions: new Map(),
      sessionCwds: new Map(),
      cwd: tempDir,
    });

    const mockBridge = {
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

    const router = new CommandRouter({
      sessionStore,
      bridge: mockBridge as unknown as Bridge,
      config,
      configPath: '/tmp/config.yaml',
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    await router.handleCardAction(
      { cmd: 'ls.file', path: bigFilePath },
      { userId: 'user1', chatId: 'chat1', messageId: 'msg1' },
    );

    expect(mockBridge.sendResult).toHaveBeenCalled();
    const result = mockBridge.sendResult.mock.calls[0][0];
    expect(result.text).toContain('30MB');
    expect(result.text).toContain('太大');
    // Should NOT contain old "10MB" limit
    expect(result.text).not.toContain('10MB');

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('router cardLsFile accepts files between 10MB and 30MB', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-limit-test-'));
    // 20MB file (between old 10MB and new 30MB limit)
    const midFilePath = path.join(tempDir, 'mid-20mb.txt');
    fs.writeFileSync(midFilePath, Buffer.alloc(20 * 1024 * 1024));

    const sessionStore = new SessionStore();
    sessionStore.set('user1', {
      sessions: new Map(),
      previousSessions: new Map(),
      arrivalSessions: new Map(),
      sessionCwds: new Map(),
      cwd: tempDir,
    });

    const mockBridge = {
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

    const router = new CommandRouter({
      sessionStore,
      bridge: mockBridge as unknown as Bridge,
      config,
      configPath: '/tmp/config.yaml',
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    await router.handleCardAction(
      { cmd: 'ls.file', path: midFilePath },
      { userId: 'user1', chatId: 'chat1', messageId: 'msg1' },
    );

    // Should NOT reject — sendFile should be called
    expect(mockBridge.sendFile).toHaveBeenCalledWith(midFilePath, expect.anything());
    // sendResult should NOT have been called with a "too large" message
    const sizeRejectCalls = mockBridge.sendResult.mock.calls.filter((call: any[]) =>
      call[0]?.text?.includes('太大'),
    );
    expect(sizeRejectCalls).toHaveLength(0);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('connector sendFile rejects files > 30MB with 30MB in error', async () => {
    const { FeishuConnector } = await import('../connector/index.js');

    const connector = new FeishuConnector({
      feishu: { appId: 'app-id', appSecret: 'app-secret' },
    } as AppConfig);

    // Mock channel
    (connector as unknown as { channel: unknown }).channel = {
      send: vi.fn().mockResolvedValue({ messageId: 'msg-id' }),
      on: vi.fn(),
    } as any;

    const tmpDir = os.tmpdir();
    const largeFile = path.join(tmpDir, 'test-31mb-' + Date.now() + '.txt');
    fs.writeFileSync(largeFile, Buffer.alloc(31 * 1024 * 1024));

    try {
      await expect(connector.sendFile('chat-id', largeFile)).rejects.toThrow(/30\s*MB/i);
    } finally {
      fs.unlinkSync(largeFile);
    }
  });

  it('router source uses shared MAX_FILE_UPLOAD_SIZE from connector/file-limits', () => {
    const routerSource = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8');
    expect(routerSource).toContain("from '../connector/file-limits.js'");
    expect(routerSource).toContain('MAX_FILE_UPLOAD_SIZE');
    // Should NOT have a local MAX_SIZE for file uploads
    expect(routerSource).not.toMatch(/const MAX_SIZE = \d+ \* 1024 \* 1024/);
  });

  it('connector source uses shared MAX_FILE_UPLOAD_SIZE from file-limits', () => {
    const connectorSource = fs.readFileSync(
      path.resolve(__dirname, '../connector/index.ts'),
      'utf-8',
    );
    expect(connectorSource).toContain("from './file-limits.js'");
    expect(connectorSource).toContain('MAX_FILE_UPLOAD_SIZE');
    // Should NOT have a local MAX_FILE_SIZE
    expect(connectorSource).not.toMatch(/const MAX_FILE_SIZE = \d+ \* 1024 \* 1024/);
  });
});
