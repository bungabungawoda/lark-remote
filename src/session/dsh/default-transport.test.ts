/**
 * DSH 默认同步传输（defaultSyncRequest / defaultSyncConnect）的
 * characterization 测试。
 *
 * 这两个模块级函数此前 0% 覆盖：现有 sessions.test.ts 全部注入
 * syncRequest/syncConnect 绕过 curl。这里 mock platform/spawn 的
 * spawnProcessSync，钉住请求装配、HTTP 状态码分流、错误文案与 cookie 解析。
 * 测试只做行为钉子，不改变任何实现；后续等价拆分后必须全绿。
 *
 * 测试禁止 spawn 真实 curl / 真实 API：spawnProcessSync 全部走 mock。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../platform/spawn.js', async () => ({
  ...(await vi.importActual('../../platform/spawn.js')),
  spawnProcessSync: vi.fn(),
}));

import { spawnProcessSync } from '../../platform/spawn.js';
import { currentPlatform, isWin32 } from '../../platform/select.js';
import { DshSessionReader } from './sessions.js';

const spawn = vi.mocked(spawnProcessSync);
const HOST = 'http://127.0.0.1:3080';
const NO_CREDENTIALS_FILE = '/nonexistent/lark-remote-test/.credentials.yaml';
const CWD = '/home/user/project';

type SpawnResult = ReturnType<typeof spawnProcessSync>;

function ok(stdout: string): SpawnResult {
  return { status: 0, stdout, stderr: '' } as unknown as SpawnResult;
}

function failed(res: Partial<SpawnResult>): SpawnResult {
  return res as unknown as SpawnResult;
}

/** 不注入 syncRequest → unary 走 defaultSyncRequest（curl）。 */
function readerWithoutTransport(): DshSessionReader {
  return new DshSessionReader({ host: HOST, credentialsFile: NO_CREDENTIALS_FILE });
}

beforeEach(() => {
  spawn.mockReset();
});

describe('defaultSyncRequest (characterization)', () => {
  it('成功：返回 result.value，curl 装配 method/args/write-out', () => {
    spawn.mockReturnValue(ok('{"result":{"ok":true,"value":{"items":[]}}}\n200'));
    expect(readerWithoutTransport().listSessions(CWD)).toEqual({ sessions: [], total: 0 });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawn.mock.calls[0]!;
    expect(command).toBe('curl');
    const a = args as string[];
    expect(a).toContain('-s');
    expect(a).toContain('-X');
    expect(a).toContain('POST');
    expect(a).toContain(`${HOST}/api/session/list`);
    expect(a).toContain('content-type: application/json');
    expect(a).toContain('--data');
    expect(a).toContain('--write-out');
    expect(a).toContain('\n%{http_code}');
    expect(opts).toMatchObject({ encoding: 'utf-8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    const body = JSON.parse(a[a.indexOf('--data') + 1]!);
    expect(body).toMatchObject({
      type: 'client-request',
      method: 'session/list',
      payload: { args: { _request: {} } },
    });
    expect(body.rpcId).toMatch(/^rpc-/);
  });

  it('cookie 存在时追加 -H Cookie header', () => {
    spawn.mockReturnValue(ok('{"result":{"ok":true,"value":{"items":[]}}}\n200'));
    const reader = new DshSessionReader({
      host: HOST,
      token: `${HOST}/?token=abc`,
      credentialsFile: NO_CREDENTIALS_FILE,
      syncConnect: () => 'dsh-auth=xyz',
    });
    reader.listSessions(CWD);
    const a = spawn.mock.calls[0]![1] as string[];
    expect(a).toContain('Cookie: dsh-auth=xyz');
  });

  it('无 HTTP 状态行时 bodyText = 原始 stdout', () => {
    spawn.mockReturnValue(ok('{"result":{"ok":true,"value":{"items":[]}}}'));
    expect(readerWithoutTransport().listSessions(CWD)).toEqual({ sessions: [], total: 0 });
  });

  it('spawn error：DSH <method> failed（取 error.message）', () => {
    spawn.mockReturnValue(
      failed({ status: 0, error: new Error('spawn ENOENT'), stdout: '', stderr: '' }),
    );
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(
      /DSH session\/list failed: spawn ENOENT/,
    );
  });

  it('非零退出无 error：用 stderr', () => {
    spawn.mockReturnValue(failed({ status: 7, stdout: '', stderr: 'curl: (7) connect refused' }));
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(
      /DSH session\/list failed: curl: \(7\) connect refused/,
    );
  });

  it('HTTP 401/403 抛 unauthorized（先于 JSON 解析）', () => {
    spawn.mockReturnValue(ok('ignored\n401'));
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(
      /DSH session\/list unauthorized \(HTTP 401\)/,
    );
    spawn.mockReturnValue(ok('ignored\n403'));
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(
      /DSH session\/list unauthorized \(HTTP 403\)/,
    );
  });

  it('非 JSON 响应抛 returned non-JSON', () => {
    spawn.mockReturnValue(ok('not json\n200'));
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(
      /DSH session\/list returned non-JSON:/,
    );
  });

  it('result.ok !== true 抛 error.message；缺少 message 时用兜底', () => {
    spawn.mockReturnValue(ok('{"result":{"ok":false,"error":{"message":"rpc denied"}}}\n200'));
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(/rpc denied/);
    spawn.mockReturnValue(ok('{"result":{"ok":false}}\n200'));
    expect(() => readerWithoutTransport().listSessions(CWD)).toThrow(/DSH session\/list failed/);
  });
});

describe('defaultSyncConnect (characterization)', () => {
  /** 注入 syncRequest 但故意不注入 syncConnect → 握手走 defaultSyncConnect。 */
  function readerWithDefaultConnect(syncRequest: (cookie?: string) => unknown): DshSessionReader {
    return new DshSessionReader({
      host: HOST,
      token: `${HOST}/?token=a b`,
      credentialsFile: NO_CREDENTIALS_FILE,
      syncRequest: (_b, _m, _p, cookie) => syncRequest(cookie),
    });
  }

  it('从 Set-Cookie 解析 name=value 并作为 unary cookie 传入', () => {
    spawn.mockReturnValue(
      ok('HTTP/1.1 200 OK\r\nSet-Cookie: dsh-auth=abc123; Path=/; HttpOnly\r\n\r\n'),
    );
    const cookies: Array<string | undefined> = [];
    const reader = readerWithDefaultConnect((cookie) => {
      cookies.push(cookie);
      return { items: [] };
    });
    expect(reader.listSessions(CWD)).toEqual({ sessions: [], total: 0 });
    expect(cookies).toEqual(['dsh-auth=abc123']);

    const [command, args] = spawn.mock.calls[0]!;
    expect(command).toBe('curl');
    const a = args as string[];
    expect(a).toContain('-sS');
    expect(a).toContain('-D');
    expect(a).toContain('-');
    expect(a).toContain('-o');
    expect(a).toContain('--max-time');
    expect(a).toContain('5');
    // `-o` 的丢弃目标是宿主空设备：posix 为 /dev/null，win32 为 NUL。
    const nullDevice = a[a.indexOf('-o') + 1];
    expect(nullDevice).toBe(isWin32(currentPlatform) ? 'NUL' : '/dev/null');
    expect(a.join(' ')).toContain('token=a%20b');
  });

  it('spawn error 抛 DSH auth failed', () => {
    spawn.mockReturnValue(
      failed({ status: 0, error: new Error('spawn ENOENT'), stdout: '', stderr: '' }),
    );
    const reader = readerWithDefaultConnect(() => ({ items: [] }));
    expect(() => reader.listSessions(CWD)).toThrow(/DSH auth failed: spawn ENOENT/);
  });

  it('无 Set-Cookie 抛 index handshake did not return a cookie', () => {
    spawn.mockReturnValue(ok('HTTP/1.1 200 OK\r\n\r\n'));
    const reader = readerWithDefaultConnect(() => ({ items: [] }));
    expect(() => reader.listSessions(CWD)).toThrow(/index handshake did not return a cookie/);
  });
});
