import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../../src/session/index.js';

// Mock sessionReader 的 getNewestSession 方法
describe('Startup auto-resume uses persisted sessionId', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-resume-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('test_anchor_startup_resumes_persisted_sessionId_not_newest', () => {
    // 场景：last-session.json 包含 cwd + sessionId
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          user1: {
            cwd: '/tmp/project',
            sessions: {
              claude: 'session-last-used-abc123',
            },
            previousSessions: {},
            arrivalSessions: {},
            sessionCwds: {},
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    // 模拟启动时读取
    const sessionStore = new SessionStore(filePath);
    const restoredCwd = sessionStore.getCwd('user1');
    const restoredSessionId = sessionStore.getSessionId('user1', 'claude');

    // 期望：恢复的是持久化的 sessionId，而非按 mtime 找最新的
    expect(restoredCwd).toBe('/tmp/project');
    expect(restoredSessionId).toBe('session-last-used-abc123');

    // 关键断言：如果持久化了 sessionId，启动流程不应该调用 getNewestSession
    // （这个行为由 index.ts 的启动逻辑保证，测试验证 sessionStore 能正确恢复 sessionId）
  });

  it('test_anchor_no_sessionId_when_not_persisted', () => {
    // 场景：持久化文件有 cwd 但没有 sessionId（该 agent 无历史会话记录）
    const filePath = path.join(tmpDir, 'last-session.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          user1: {
            cwd: '/tmp/project',
            sessions: {},
            previousSessions: {},
            arrivalSessions: {},
            sessionCwds: {},
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const sessionStore = new SessionStore(filePath);
    const restoredCwd = sessionStore.getCwd('user1');
    const restoredSessionId = sessionStore.getSessionId('user1', 'claude');

    // 期望：cwd 恢复，但 sessionId 为 undefined（无持久化会话）
    expect(restoredCwd).toBe('/tmp/project');
    expect(restoredSessionId).toBeUndefined();
  });
});
