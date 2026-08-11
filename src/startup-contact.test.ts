import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StartupContactStore, formatStartupHello, sendStartupHello } from './startup-contact.js';

vi.mock('./logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-startup-contact-'));
  storePath = path.join(tmpDir, 'startup-contact.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('StartupContactStore', () => {
  it('persists the latest chat id', () => {
    const store = new StartupContactStore(storePath);

    store.save({ chatId: 'chat-1', userId: 'user-1' });
    store.save({ chatId: 'chat-2', userId: 'user-2' });

    expect(new StartupContactStore(storePath).getContact()).toEqual({
      chatId: 'chat-2',
      userId: 'user-2',
    });
  });

  it('ignores corrupted data', () => {
    fs.writeFileSync(storePath, '{', 'utf-8');

    expect(new StartupContactStore(storePath).getContact()).toBeUndefined();
  });
});

describe('formatStartupHello', () => {
  it('includes startup time and process id', () => {
    const message = formatStartupHello(new Date('2026-06-22T12:34:56Z'), 12345);

    expect(message).toContain('lark-remote 已启动');
    expect(message).toContain('启动时间：');
    expect(message).toContain('2026');
    expect(message).toContain('进程号：12345');
  });

  it('shows dev tag when dev mode is enabled', () => {
    const message = formatStartupHello(new Date('2026-06-22T12:34:56Z'), 12345, true);

    expect(message).toContain('lark-remote 🔧 dev 已启动');
    expect(message).not.toContain('lark-remote 已启动');
  });

  it('hides dev tag when dev mode is disabled', () => {
    const message = formatStartupHello(new Date('2026-06-22T12:34:56Z'), 12345, false);

    expect(message).toContain('lark-remote 已启动');
    expect(message).not.toContain('🔧');
  });
});

describe('sendStartupHello', () => {
  it('does nothing before a chat id has been recorded', async () => {
    const sendWithRetry = vi.fn(async () => 'msg-id');

    await sendStartupHello({ sendWithRetry }, new StartupContactStore(storePath));

    expect(sendWithRetry).not.toHaveBeenCalled();
  });

  it('sends hello to the recorded chat', async () => {
    const sendWithRetry = vi.fn(async () => 'msg-id');
    const store = new StartupContactStore(storePath);
    store.save({ chatId: 'chat-1', userId: 'user-1' });

    await sendStartupHello({ sendWithRetry }, store);

    expect(sendWithRetry).toHaveBeenCalledWith('chat-1', {
      text: expect.stringContaining('lark-remote 已启动'),
    });
  });

  it('sends hello to the recorded user when chat id is unavailable', async () => {
    const sendWithRetry = vi.fn(async () => 'msg-id');
    const store = new StartupContactStore(storePath);
    store.save({ userId: 'user-1' });

    await sendStartupHello({ sendWithRetry }, store);

    expect(sendWithRetry).toHaveBeenCalledWith('user-1', {
      text: expect.stringContaining('lark-remote 已启动'),
    });
  });
});
