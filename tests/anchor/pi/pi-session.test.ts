/**
 * Merged anchor tests for pi session (stale db + mtime ordering)
 *
 * Source files (merged 2026-08-04, Phase 4):
 *   - pi-runner-spawning-base.test.ts (PiRunner removed 2026-08-18, RPC-only)
 *   - pi-session-stale-db.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PiSessionReader } from '../../../src/session/pi/index.js';

// ---------------------------------------------------------------------------
// PiSessionReader stale db
// ---------------------------------------------------------------------------

describe('Anchor: PiSessionReader 必须基于文件系统返回真正最新的会话', () => {
  let tmpDir: string;
  let piDir: string;
  let sessionsDir: string;
  const cwd = '/test/cwd/project';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stale-db-anchor-'));
    piDir = path.join(tmpDir, 'pi-agent');
    sessionsDir = path.join(piDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create the CORRECT encoded project directory that listSessionsByScan expects
    // Format: --<cwd-without-leading-/>-- (double dashes, no leading slash)
    const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
    const encodedProjectDir = path.join(sessionsDir, `--${encodedCwd}--`);
    fs.mkdirSync(encodedProjectDir, { recursive: true });

    // Create stale session-db.json with OLD timestamp (simulating the real bug)
    const staleDb = {
      version: 1,
      sessions: {
        'old-session-id-1': {
          sessionId: 'old-session-id-1',
          cwd: cwd,
          updatedAt: '2020-01-01T00:00:00.000Z', // Very old
          name: null,
          sessionPath: path.join(sessionsDir, '2020-01-01T00-00-00-000Z_old-session-id-1.jsonl'),
        },
        'old-session-id-2': {
          sessionId: 'old-session-id-2',
          cwd: cwd,
          updatedAt: '2020-06-01T00:00:00.000Z', // Old but newer than #1
          name: null,
          sessionPath: path.join(sessionsDir, '2020-06-01T00-00-00-000Z_old-session-id-2.jsonl'),
        },
      },
    };
    fs.writeFileSync(path.join(piDir, 'session-db.json'), JSON.stringify(staleDb), 'utf-8');
  });

  /**
   * Anchor Test: session-db.json 过时，新建的会话必须出现在 listSessions 结果中
   *
   * Bug 表现: PiSessionReader.listSessions 优先走 db 分支，当 db 非空时永远不触发
   * fallback 的 listSessionsByScan。导致磁盘上新建的会话(不在 db 中)完全不出现在结果里。
   *
   * 修复后: listSessions 应该基于文件系统 mtime 排序，db 只作为可选缓存(且可被实时文件"击穿")。
   */
  it('test_anchor_newest_session_not_in_db_must_appear_in_list', () => {
    // Create NEW session files on disk (simulate sessions created AFTER the stale db was written)
    // These sessions are NOT in session-db.json, but they should appear in listSessions
    const now = Date.now();
    const recentTimestamp = new Date(now - 60 * 1000).toISOString(); // 1 minute ago
    const oldTimestamp = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    // Use correct encoding: --<cwd-without-leading-/>--
    const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
    const encodedProjectDir = path.join(sessionsDir, `--${encodedCwd}--`);

    // Recent session (should be #1 after fix)
    const recentSessionPath = path.join(
      encodedProjectDir,
      `${recentTimestamp.replace(/[:.]/g, '-')}_recent-session-id.jsonl`,
    );
    fs.writeFileSync(
      recentSessionPath,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'recent-session-id',
        timestamp: recentTimestamp,
        cwd: cwd,
      }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'msg-1',
          timestamp: recentTimestamp,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Recent user message' }],
          },
        }) +
        '\n',
      'utf-8',
    );
    // Set explicit mtime to ensure it's the newest
    const recentMtime = (now - 60 * 1000) / 1000; // 1 minute ago
    fs.utimesSync(recentSessionPath, recentMtime, recentMtime);

    // Old session (simulates 1 day ago - should be below recent after fix)
    const oldSessionPath = path.join(
      encodedProjectDir,
      `${oldTimestamp.replace(/[:.]/g, '-')}_disk-old-session-id.jsonl`,
    );
    fs.writeFileSync(
      oldSessionPath,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'disk-old-session-id',
        timestamp: oldTimestamp,
        cwd: cwd,
      }) +
        '\n' +
        JSON.stringify({
          type: 'message',
          id: 'msg-2',
          timestamp: oldTimestamp,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Old user message from disk' }],
          },
        }) +
        '\n',
      'utf-8',
    );
    // Set explicit mtime to ensure it's older
    const oldMtime = (now - 24 * 60 * 60 * 1000) / 1000; // 1 day ago
    fs.utimesSync(oldSessionPath, oldMtime, oldMtime);

    // Now list sessions via PiSessionReader
    const reader = new PiSessionReader({ piDir });
    const result = reader.listSessions(cwd, { limit: 10 });

    // total 为磁盘上真实存在的会话数（stale db 条目无对应文件，被过滤）
    expect(result.total).toBe(2);

    // ASSERTION 1: The newest session from disk MUST appear in results
    // (This is the main bug: stale db excludes newest sessions)
    const recentFound = result.sessions.some((s) => s.sessionId === 'recent-session-id');
    expect(recentFound, 'Newest session (recent-session-id) must appear in listSessions').toBe(
      true,
    );

    // ASSERTION 2: Sessions should be sorted by actual mtime (disk), not by db updatedAt
    // If sorted correctly: recent-session-id should be FIRST (most recent)
    expect(result.sessions[0]?.sessionId).toBe('recent-session-id');

    // ASSERTION 3: The OLD db entries should either not appear (if filtered by cwd/mtime)
    // or appear AFTER the real recent disk sessions
    // With fix: stale db entries that don't have corresponding files should be filtered out
    expect(result.sessions.find((s) => s.sessionId === 'old-session-id-1')).toBeUndefined();
    expect(result.sessions.find((s) => s.sessionId === 'old-session-id-2')).toBeUndefined();
  });

  /**
   * Anchor Test: 验证排序是按 mtime 降序，而非按 db updatedAt
   */
  it('test_anchor_sessions_sorted_by_mtime_not_db_updatedAt', () => {
    const now = Date.now();
    // Use correct encoding: --<cwd-without-leading-/>--
    const encodedCwd = cwd.replace(/^\//, '').replace(/\//g, '-');
    const encodedProjectDir = path.join(sessionsDir, `--${encodedCwd}--`);

    // Create 3 sessions, writing them in REVERSE mtime order (oldest first)
    // This ensures the file mtime reflects the order: session-A (oldest mtime), session-B, session-C (newest mtime)
    // After fix: results should be sorted by mtime DESC, so session-C first.
    const sessionIds = ['session-oldest', 'session-middle', 'session-newest'];

    for (let i = 0; i < sessionIds.length; i++) {
      const sessionId = sessionIds[i];
      const ts = new Date(now - (3 - i) * 60 * 60 * 1000).toISOString(); // session-oldest: 5h ago, session-newest: 1h ago
      const sessionPath = path.join(
        encodedProjectDir,
        `${ts.replace(/[:.]/g, '-')}_${sessionId}.jsonl`,
      );
      fs.writeFileSync(
        sessionPath,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: sessionId,
          timestamp: ts,
          cwd: cwd,
        }) + '\n',
        'utf-8',
      );
      // Artificially set mtime to match our intended order (since write time may vary)
      const desiredMtime = now - (3 - i) * 60 * 60 * 1000;
      fs.utimesSync(sessionPath, desiredMtime / 1000, desiredMtime / 1000);
    }

    const reader = new PiSessionReader({ piDir });
    const result = reader.listSessions(cwd, { limit: 10 });

    // If sorted by mtime descending: session-newest (1h ago = most recent mtime) should be #0
    expect(result.sessions.length).toBeGreaterThanOrEqual(3);
    expect(result.total).toBe(3);
    expect(result.sessions[0]?.sessionId).toBe('session-newest'); // Most recent mtime
    expect(result.sessions[1]?.sessionId).toBe('session-middle');
    expect(result.sessions[2]?.sessionId).toBe('session-oldest');
  });
});
