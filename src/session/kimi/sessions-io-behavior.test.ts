/**
 * kimi session reader 的行为测试：通过公开入口 listSessions /
 * readSessionContent 触发 mtime 回退、realpath 降级、JSONL 缓存与 I/O 错误
 * 分支，断言用户可见结果（会话列表、mtime、事件流、日志文案）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiSessionReader } from './sessions.js';
import { mockLogger } from '../../../tests/lib/logger-mock.js';

vi.mock('../../logger/index.js', async () =>
  (await import('../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

let tmpDir: string;
let kimiDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-kimi-io-test-'));
  kimiDir = path.join(tmpDir, '.kimi-code');
  fs.mkdirSync(kimiDir, { recursive: true });
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeWorkDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function addIndexEntry(sessionId: string, sessionDir: string, workDir: string): void {
  fs.appendFileSync(
    path.join(kimiDir, 'session_index.jsonl'),
    JSON.stringify({ sessionId, sessionDir, workDir }) + '\n',
  );
}

/** 真实会话目录：state.json（v1 workDir）+ 可选 wire.jsonl + index 条目。 */
function createSession(
  sessionId: string,
  workDir: string,
  opts: { wireLines?: string[]; withWire?: boolean } = {},
): string {
  const sessionDir = path.join(kimiDir, 'sessions', sessionId);
  const agentsDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workDir,
      title: 'Test Session',
      isCustomTitle: false,
    }),
  );
  const wirePath = path.join(agentsDir, 'wire.jsonl');
  if (opts.wireLines) {
    fs.writeFileSync(wirePath, opts.wireLines.join('\n') + '\n');
  } else if (opts.withWire !== false) {
    fs.writeFileSync(wirePath, '');
  }
  addIndexEntry(sessionId, sessionDir, workDir);
  return sessionDir;
}

function textLine(text: string): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'content.part', part: { type: 'text', text } },
    time: 1001,
  });
}

function ioError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
}

/** 只对指定路径注入错误，其余调用走真实实现（不破坏 cwd 守卫与 index 扫描）。
 *  statSync / realpathSync 共用单一实现，差异提到 method 参数。 */
function throwOnPath(
  method: 'statSync' | 'realpathSync',
  target: string,
  err: NodeJS.ErrnoException,
): void {
  const orig = fs[method];
  const impl = ((p: unknown, ...rest: unknown[]) => {
    if (p === target) throw err;
    return (orig as (...a: unknown[]) => unknown).apply(fs, [p, ...rest]);
  }) as never;
  if (method === 'statSync') {
    vi.spyOn(fs, 'statSync').mockImplementation(impl);
  } else {
    vi.spyOn(fs, 'realpathSync').mockImplementation(impl);
  }
}

describe('kimiSessionMtime via listSessions', () => {
  it('uses wire.jsonl mtime as the row mtime', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = createSession('sess-1', workDir, { wireLines: [textLine('first')] });
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    fs.utimesSync(wirePath, 1_600_000_000, 1_600_000_000);
    const expected = fs.statSync(wirePath).mtimeMs;

    const result = new KimiSessionReader(kimiDir).listSessions(workDir);
    expect(result.total).toBe(1);
    expect(result.sessions[0].sessionId).toBe('sess-1');
    expect(result.sessions[0].mtime).toBe(expected);
  });

  it('falls back to the session directory mtime when wire.jsonl is absent', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = createSession('sess-2', workDir, { withWire: false });
    fs.utimesSync(sessionDir, 1_600_000_100, 1_600_000_100);
    const expected = fs.statSync(sessionDir).mtimeMs;

    const result = new KimiSessionReader(kimiDir).listSessions(workDir);
    expect(result.total).toBe(1);
    expect(result.sessions[0].mtime).toBe(expected);
  });

  it('skips a session whose directory has disappeared (null mtime)', () => {
    const workDir = makeWorkDir('project-a');
    addIndexEntry('sess-gone', path.join(kimiDir, 'sessions', 'no-such-dir'), workDir);

    const result = new KimiSessionReader(kimiDir).listSessions(workDir);
    expect(result.total).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  it('warns and skips when the session dir stat fails with a non-ENOENT error', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = createSession('sess-3', workDir, { withWire: false });
    throwOnPath('statSync', sessionDir, ioError('EACCES', 'EACCES: permission denied'));

    const result = new KimiSessionReader(kimiDir).listSessions(workDir);
    expect(result.total).toBe(0);
    const warns = mockLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warns).toContain(
      `[kimi-session-reader] cannot stat ${sessionDir}: EACCES: permission denied`,
    );
  });
});

describe('logKimiRealpathFailure via listSessions', () => {
  it('keeps the session list and logs on a non-ENOENT realpath failure', () => {
    const workDir = makeWorkDir('project-a');
    createSession('sess-1', workDir, { wireLines: [textLine('hello')] });
    throwOnPath('realpathSync', workDir, ioError('EACCES', 'EACCES: permission denied'));

    const result = new KimiSessionReader(kimiDir).listSessions(workDir);
    expect(result.total).toBe(1);
    expect(result.sessions[0].sessionId).toBe('sess-1');
    const debugs = mockLogger.debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugs).toContain(
      `[kimi-session-reader] realpath ${workDir} failed, using the path as given: EACCES: permission denied`,
    );
  });

  it('is silent on ENOENT but still keeps the session list', () => {
    const workDir = makeWorkDir('project-a');
    createSession('sess-1', workDir, { wireLines: [textLine('hello')] });
    throwOnPath('realpathSync', workDir, ioError('ENOENT', 'ENOENT: no such file or directory'));

    const result = new KimiSessionReader(kimiDir).listSessions(workDir);
    expect(result.total).toBe(1);
    const debugs = mockLogger.debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugs).not.toContain('[kimi-session-reader] realpath ');
  });
});

describe('readJsonlLines via readSessionContent', () => {
  it('returns display events for a non-empty wire file', () => {
    const workDir = makeWorkDir('project-a');
    createSession('sess-1', workDir, { wireLines: [textLine('hello kimi')] });

    const result = new KimiSessionReader(kimiDir).readSessionContent('sess-1', workDir);
    expect(result.events.map((e) => e.content)).toContain('hello kimi');
  });

  it('returns no events for an empty wire file', () => {
    const workDir = makeWorkDir('project-a');
    createSession('sess-1', workDir, { wireLines: [] });

    const result = new KimiSessionReader(kimiDir).readSessionContent('sess-1', workDir);
    expect(result.events).toEqual([]);
  });

  it('re-reads the wire file when its mtime changes (cache invalidation)', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = createSession('sess-1', workDir, { wireLines: [textLine('first')] });
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const reader = new KimiSessionReader(kimiDir);

    expect(reader.readSessionContent('sess-1', workDir).events.map((e) => e.content)).toContain(
      'first',
    );
    fs.writeFileSync(wirePath, textLine('second') + '\n');
    fs.utimesSync(wirePath, 1_600_000_500, 1_600_000_500);

    const contents = reader.readSessionContent('sess-1', workDir).events.map((e) => e.content);
    expect(contents).toContain('second');
    expect(contents).not.toContain('first');
  });

  it('serves cached lines when content changes but the mtime is unchanged', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = createSession('sess-1', workDir, { wireLines: [textLine('first')] });
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    // 固定秒级 mtime：utimesSync 用数值秒，两次 statSync().mtimeMs 都是同一个
    // 整数，模拟「内容已改写但文件系统 mtime 粒度未变」的真实场景。
    const t = 1_600_000_000;
    fs.utimesSync(wirePath, t, t);
    const reader = new KimiSessionReader(kimiDir);

    expect(reader.readSessionContent('sess-1', workDir).events.map((e) => e.content)).toContain(
      'first',
    );
    fs.writeFileSync(wirePath, textLine('second') + '\n');
    fs.utimesSync(wirePath, t, t);

    const contents = reader.readSessionContent('sess-1', workDir).events.map((e) => e.content);
    expect(contents).toContain('first');
    expect(contents).not.toContain('second');
  });

  it('warns and returns empty content when the wire file stat fails with non-ENOENT', () => {
    const workDir = makeWorkDir('project-a');
    const sessionDir = createSession('sess-1', workDir, { wireLines: [textLine('hello')] });
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    throwOnPath('statSync', wirePath, ioError('EACCES', 'EACCES: permission denied'));

    const result = new KimiSessionReader(kimiDir).readSessionContent('sess-1', workDir);
    expect(result.events).toEqual([]);
    const warns = mockLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warns).toContain(
      `[kimi-session-reader] cannot read ${wirePath}: EACCES: permission denied`,
    );
  });
});
