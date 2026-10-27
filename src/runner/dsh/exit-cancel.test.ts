import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../dsh/auth.js', () => ({
  DSH_COOKIE_LIFETIME_MS: 60 * 60 * 1000,
  mintDshBrowserCookie: () => 'test-cookie',
  readDshBrowserSecretSync: () => 'test-secret',
  resolveDshCredentialsFile: () => '/fake/credentials.yaml',
}));
vi.mock('../../platform/spawn.js', () => ({ spawnProcessSync: vi.fn() }));

import { isWin32 } from '../../platform/select.js';
import { spawnProcessSync } from '../../platform/spawn.js';
import { cancelSessionSync } from './exit-cancel.js';

const spawnMock = vi.mocked(spawnProcessSync);

function okResponse(stdout = '200'): SpawnSyncReturns<string | Buffer> {
  return { status: 0, stdout, stderr: '' } as unknown as SpawnSyncReturns<string | Buffer>;
}

/** 捕获到的临时目录；用例失败时 afterEach 兜底清理。 */
let capturedDir: string | undefined;

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  if (capturedDir) {
    fs.rmSync(capturedDir, { recursive: true, force: true });
    capturedDir = undefined;
  }
});

describe('cancelSessionSync', () => {
  beforeEach(() => {
    capturedDir = undefined;
  });

  it('writes the cookie into a random 0700 temp dir and removes it after curl', () => {
    let headerPath: string | undefined;
    let content: string | undefined;
    let fileMode: number | undefined;
    let dirMode: number | undefined;

    spawnMock.mockImplementation((_cmd, args) => {
      const headerArg = (args as readonly string[]).find((arg) => arg.startsWith('@'));
      if (headerArg) {
        headerPath = headerArg.slice(1);
        capturedDir = path.dirname(headerPath);
        content = fs.readFileSync(headerPath, 'utf-8');
        fileMode = fs.statSync(headerPath).mode & 0o777;
        dirMode = fs.statSync(capturedDir).mode & 0o777;
      }
      // 原始 cookie 不得出现在 argv（ps 对本机任意进程可见）。
      expect(args as readonly string[]).not.toContain('Cookie: test-cookie');
      return okResponse();
    });

    expect(cancelSessionSync({ baseUrl: 'http://127.0.0.1:3080', sessionId: 'sess-1' })).toBe(true);

    expect(headerPath).toBeDefined();
    expect(path.basename(capturedDir!)).toMatch(/^lark-remote-exit-cancel-/);
    // 不再是可预测的 `<pid>.hdr`：父目录随机后缀本身即不可预建。
    expect(capturedDir).not.toBe(os.tmpdir());
    expect(content).toBe('Cookie: test-cookie\n');
    if (!isWin32()) {
      // mkdtemp 目录 0700、文件 0600：同机其它用户无法进入或读取。
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }
    // finally 清理：curl 结束后目录与 cookie 文件都不复存在。
    expect(fs.existsSync(capturedDir!)).toBe(false);
    expect(fs.existsSync(headerPath!)).toBe(false);
  });

  it('falls back to argv only when the temp dir cannot be created', () => {
    vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const seen: string[] = [];
    spawnMock.mockImplementation((_cmd, args) => {
      seen.push(...(args as readonly string[]));
      return okResponse();
    });

    expect(cancelSessionSync({ baseUrl: 'http://127.0.0.1:3080', sessionId: 'sess-2' })).toBe(true);
    expect(seen).toContain('Cookie: test-cookie');
  });

  it('returns false when curl reports a non-200 status', () => {
    spawnMock.mockReturnValue(okResponse('500'));

    expect(cancelSessionSync({ baseUrl: 'http://127.0.0.1:3080', sessionId: 'sess-3' })).toBe(
      false,
    );
  });
});
