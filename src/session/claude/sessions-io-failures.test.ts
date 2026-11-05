/**
 * claude session reader 的行为测试：通过公开入口 isClaudeSessionActive /
 * readSessionContent 触发 stat 失败留痕与 tail 行映射，断言用户可见结果
 * （活跃判定、debug 文案、事件序列），而不是断言内部函数或 mock 调用次数。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isClaudeSessionActive, readSessionContent } from './sessions.js';
import { encodeClaudeProjectDir } from '../../../tests/lib/session-fixtures.js';
import { mockLogger } from '../../../tests/lib/logger-mock.js';

vi.mock('../../logger/index.js', async () =>
  (await import('../../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

const SESSION_ID = 'test-session-1234';
const CWD = '/tmp/proj';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-claude-io-test-'));
  mockLogger.debug.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写一份真实 jsonl：init 行带 cwd，供 projectDirForCwd + cwd 守卫定位。 */
function writeSession(lines: string[]): { projectsDir: string; filePath: string } {
  const encoded = encodeClaudeProjectDir(CWD);
  const dir = path.join(tmpDir, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const initLine = `{"type":"system","subtype":"init","session_id":"${SESSION_ID}","cwd":${JSON.stringify(CWD)},"model":"opus"}`;
  const filePath = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(filePath, [initLine, ...lines].join('\n') + '\n');
  return { projectsDir: tmpDir, filePath };
}

/** 只对目标 jsonl 的 statSync 注入错误，其余调用走真实实现（不破坏 cwd 守卫）。 */
function throwOnStat(target: string, code: string, message: string): void {
  const orig = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (p === target) throw Object.assign(new Error(message), { code });
    return (orig as (...a: unknown[]) => unknown).apply(fs, [p, ...rest]);
  }) as never);
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

describe('logStatFailure via isClaudeSessionActive', () => {
  it('non-ENOENT stat failure leaves a debug trace and reports the session inactive', () => {
    const { projectsDir, filePath } = writeSession([userLine('do thing')]);
    throwOnStat(filePath, 'EACCES', 'EACCES: permission denied');

    expect(isClaudeSessionActive(SESSION_ID, CWD, { projectsDir })).toBe(false);
    const debugs = mockLogger.debug.mock.calls.map((c) => String(c[0]));
    expect(debugs).toContain(
      `[claude-session-reader] stat ${filePath} failed: EACCES: permission denied`,
    );
  });

  it('ENOENT stat failure is silent (normal race, not an unreadable file)', () => {
    const { projectsDir, filePath } = writeSession([userLine('do thing')]);
    throwOnStat(filePath, 'ENOENT', 'ENOENT: no such file or directory');

    expect(isClaudeSessionActive(SESSION_ID, CWD, { projectsDir })).toBe(false);
    const debugs = mockLogger.debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugs).not.toContain('[claude-session-reader] stat ');
  });
});

describe('mapClaudeTailLine via readSessionContent', () => {
  it('expands text/thinking/tool_use blocks into ordered events and preserves timestamp', () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const assistantLine = JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '  hello  ' },
          { type: 'thinking', thinking: '  hmm  ' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });
    const { projectsDir } = writeSession([userLine('do thing'), assistantLine]);

    const result = readSessionContent(SESSION_ID, CWD, { projectsDir });
    expect(result.events.map((e) => e.type)).toEqual(['text', 'thinking', 'tool_use']);
    expect(result.events[0].content).toBe('hello');
    expect(result.events[1].content).toBe('hmm');
    expect(result.events[2].content).toContain('🔧 Bash');
    expect(result.events.every((e) => e.timestamp === timestamp)).toBe(true);
  });

  it('emits a placeholder event for a metadata-only tail line that has a role', () => {
    const timestamp = '2026-01-02T00:00:00.000Z';
    const metaLine = JSON.stringify({
      type: 'last-prompt',
      timestamp,
      message: { role: 'assistant' },
    });
    const { projectsDir } = writeSession([userLine('do thing'), metaLine]);

    const result = readSessionContent(SESSION_ID, CWD, { projectsDir });
    expect(result.events).toEqual([{ type: 'assistant', content: '(assistant event)', timestamp }]);
  });

  it('emits no events for a tail line without content blocks and without a role', () => {
    const metaLine = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 123,
    });
    const { projectsDir } = writeSession([userLine('do thing'), metaLine]);

    const result = readSessionContent(SESSION_ID, CWD, { projectsDir });
    expect(result.events).toEqual([]);
  });
});
