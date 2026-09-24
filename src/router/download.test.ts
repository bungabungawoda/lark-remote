// /download <path>（别名 /d）：直接把本地文件发送到飞书。
// 覆盖 ~ 展开、相对路径基于 cwd、30MB 上限、目录/不存在路径的报错。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from '../router/index.js';
import { SessionStore } from '../session/index.js';
import type { AppConfig } from '../config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';
import { makeTempDir } from '../../tests/lib/temp-dir.js';
import { writeSizedFile } from '../../tests/lib/sized-file.js';

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

let tmpDir: string;
let router: CommandRouter;
let mockBridge: ReturnType<typeof createMockBridge>;
let filePath: string;

beforeEach(() => {
  tmpDir = makeTempDir('download-cmd-');
  filePath = path.join(tmpDir, 'report.pdf');
  fs.writeFileSync(filePath, 'pdf-bytes');

  const sessionStore = new SessionStore();
  sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tmpDir });
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
    configPath: path.join(tmpDir, 'config.yaml'),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
  });
});

function sentTexts(): string[] {
  const calls = (mockBridge.sendResult as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((c) => (c[0] as { text?: string }).text ?? '');
}

describe('/download', () => {
  it('test_anchor_download_absolute_path_sends_file', async () => {
    const result = await router.handle(`/download ${filePath}`, ctx);

    expect(mockBridge.sendFile).toHaveBeenCalledWith(filePath, expect.anything());
    // 文件本身就是回复，不再额外发文本
    expect(result).toBeNull();
    expect(sentTexts().every((t) => t === '')).toBe(true);
  });

  it('alias /d works', async () => {
    await router.handle(`/d ${filePath}`, ctx);
    expect(mockBridge.sendFile).toHaveBeenCalledWith(filePath, expect.anything());
  });

  it('relative path resolves against cwd', async () => {
    await router.handle('/download report.pdf', ctx);
    expect(mockBridge.sendFile).toHaveBeenCalledWith(filePath, expect.anything());
  });

  it('path with spaces is preserved', async () => {
    const spaced = path.join(tmpDir, 'my report v2.pdf');
    fs.writeFileSync(spaced, 'x');
    await router.handle(`/download ${spaced}`, ctx);
    expect(mockBridge.sendFile).toHaveBeenCalledWith(spaced, expect.anything());
  });

  it('expands ~ to the home directory (not found → error shows expanded path)', async () => {
    const name = '.lark-remote-download-test-nonexistent.bin';
    await router.handle(`/download ~/${name}`, ctx);
    expect(mockBridge.sendFile).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes(path.join(os.homedir(), name)))).toBe(true);
  });

  it('missing file → error text, no sendFile', async () => {
    const missing = path.join(tmpDir, 'nope.bin');
    await router.handle(`/download ${missing}`, ctx);
    expect(mockBridge.sendFile).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes('不存在'))).toBe(true);
  });

  it('directory → error text explains it is a directory', async () => {
    await router.handle(`/download ${tmpDir}`, ctx);
    expect(mockBridge.sendFile).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes('目录'))).toBe(true);
  });

  it('files larger than 30MB are rejected', async () => {
    const big = path.join(tmpDir, 'big.bin');
    writeSizedFile(big, 31 * 1024 * 1024);
    await router.handle(`/download ${big}`, ctx);
    expect(mockBridge.sendFile).not.toHaveBeenCalled();
    const text = sentTexts().find((t) => t.includes('30MB')) ?? '';
    expect(text).toContain('太大');
  });

  it('missing argument → usage hint', async () => {
    await router.handle('/download', ctx);
    expect(mockBridge.sendFile).not.toHaveBeenCalled();
    expect(sentTexts().some((t) => t.includes('用法'))).toBe(true);
  });
});
