/**
 * Round 10 termination probes (plan §2.1/§2.2/§4.2): 5 reader 层边界。
 *
 * Each `test_probe_*` is an independent assumption; a fail here is a
 * candidate RED for the orchestrator to upgrade/drop.
 *
 * Focus areas:
 * - P10-8: TTL staleness 为 spec §2.2 设计内行为（list 走 5s 缓存），非缺陷，probe 已丢弃。
 * - P10-9: 5 个 reader 空目录（0 会话）下返回 { sessions: [], total: 0 }，
 *   任何 offset/limit 组合不抛异常。
 * - P10-10: 4 个可 fixture 的 reader（claude/pi/codex/kimi）在 5 会话
 *   fixture 下：limit=0、offset=total、offset=total-pageSize、limit 超大、
 *   负 offset（R9 裁决 reader 层统一 clamp 到 0）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClaudeSessionReader } from '../../src/session/claude/index.js';
import { CodexSessionReader } from '../../src/session/codex/index.js';
import { clearSessionIndexCache } from '../../src/session/codex/rollout-reader.js';
import { OpencodeSessionReader } from '../../src/session/opencode/index.js';
import { PiSessionReader } from '../../src/session/pi/index.js';
import { KimiSessionReader } from '../../src/session/kimi/index.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

function encodedProjectDir(cwd: string): string {
  return fs.realpathSync(cwd).replace(/\//g, '-').replace(/_/g, '-');
}

describe('Round 10 reader probes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'round10-reader-probes-'));
    clearSessionIndexCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_probe_readers_empty_dir_returns_zero_total', () => {
    // 假设：5 个 reader 在空目录/无二进制可用下都返回 { sessions: [], total: 0 }
    // 且不抛异常（任何 offset/limit 组合）。
    const cwd = fs.realpathSync(tmpDir);
    const claude = new ClaudeSessionReader({ projectsDir: path.join(tmpDir, 'claude-projects') });
    const codex = new CodexSessionReader({ codexHome: path.join(tmpDir, 'codex') });
    const pi = new PiSessionReader({ piDir: path.join(tmpDir, 'pi') });
    const opencode = new OpencodeSessionReader({
      binary: 'definitely-missing-opencode-binary',
      cacheTtlMs: 1,
    });
    const kimi = new KimiSessionReader(path.join(tmpDir, 'kimi'));

    for (const reader of [claude, codex, pi, opencode, kimi]) {
      for (const opts of [
        undefined,
        { limit: 0 },
        { limit: 20, offset: 0 },
        { limit: 20, offset: 25 },
        { limit: 20, offset: -3 },
      ]) {
        const result = reader.listSessions(cwd, opts as any);
        expect(result).toEqual({ sessions: [], total: 0 });
      }
    }
  });

  it('test_probe_readers_fixture_limit_zero_and_offset_bounds', () => {
    // 假设：5 会话 fixture 下，limit=0 → 空页但 total=5；offset=total → 空页；
    // offset=total-pageSize → 末页起点；limit 超大 → 全集；负 offset → 第一页
    // （R9 裁决：reader 层统一 offset<0 → 0，不静默空页）。
    const cwdPath = path.join(tmpDir, 'proj');
    fs.mkdirSync(cwdPath, { recursive: true });
    const cwd = fs.realpathSync(cwdPath);
    const baseTime = Date.parse('2026-07-01T00:00:00Z');
    const ids = ['a-0001', 'a-0002', 'a-0003', 'a-0004', 'a-0005'];

    // claude fixture: projectsDir/<encoded>/<id>.jsonl，mtime 随 i 递增。
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const claudeProj = path.join(projectsDir, encodedProjectDir(cwd));
    fs.mkdirSync(claudeProj, { recursive: true });
    ids.forEach((id, i) => {
      const p = path.join(claudeProj, `${id}.jsonl`);
      fs.writeFileSync(
        p,
        `{"type":"system","subtype":"init","session_id":"${id}","cwd":"${cwd}","model":"opus"}\n` +
          `{"type":"user","message":{"role":"user","content":"task ${i}"}}\n`,
      );
      const t = new Date(baseTime + i * 60_000);
      fs.utimesSync(p, t, t);
    });

    // codex fixture: sessions/YYYY/MM/DD/rollout-<id>.jsonl + session_meta。
    const codexHome = path.join(tmpDir, 'codex');
    const codexDay = path.join(codexHome, 'sessions', '2026', '07', '31');
    fs.mkdirSync(codexDay, { recursive: true });
    ids.forEach((id, i) => {
      const p = path.join(codexDay, `rollout-${id}.jsonl`);
      fs.writeFileSync(
        p,
        `{"type":"session_meta","payload":{"session_id":"${id}","cwd":"${cwd}","originator":"x"}}\n`,
        'utf-8',
      );
      const t = new Date(baseTime + i * 60_000);
      fs.utimesSync(p, t, t);
    });

    // pi fixture: sessions/<encoded>/<timestamp>_<uuid>.jsonl。
    const piDir = path.join(tmpDir, 'pi');
    const piEncoded = cwd.replace(/^\//, '').replace(/\//g, '-');
    const piSessions = path.join(piDir, 'sessions', `--${piEncoded}--`);
    fs.mkdirSync(piSessions, { recursive: true });
    ids.forEach((id, i) => {
      const mtime = new Date(baseTime + i * 60_000);
      const stamp = mtime.toISOString().replace(/[:.]/g, '-');
      const p = path.join(piSessions, `${stamp}_${id}.jsonl`);
      fs.writeFileSync(
        p,
        `{"type":"session","id":"${id}","cwd":"${cwd}","provider":"glm","modelId":"glm-5.2"}\n` +
          `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"task ${i}"}]}}\n`,
      );
      fs.utimesSync(p, mtime, mtime);
    });

    // kimi fixture: session_index.jsonl + 每个 sessionDir（mtime 随 i 递增）。
    const kimiDir = path.join(tmpDir, 'kimi');
    const lines: string[] = [];
    ids.forEach((id, i) => {
      const sessionDir = path.join(kimiDir, 'sessions', id);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ title: `task ${i}` }));
      const t = new Date(baseTime + i * 60_000);
      fs.utimesSync(sessionDir, t, t);
      lines.push(JSON.stringify({ sessionId: id, workDir: cwd, sessionDir }));
    });
    fs.writeFileSync(path.join(kimiDir, 'session_index.jsonl'), lines.join('\n') + '\n');

    const readers: Array<[string, unknown]> = [
      ['claude', new ClaudeSessionReader({ projectsDir })],
      ['codex', new CodexSessionReader({ codexHome })],
      ['pi', new PiSessionReader({ piDir })],
      ['kimi', new KimiSessionReader(kimiDir)],
    ];

    for (const [name, reader] of readers) {
      const r = reader as {
        listSessions(
          c: string,
          o?: { limit?: number; offset?: number },
        ): { sessions: Array<{ sessionId: string }>; total: number };
      };

      const all = r.listSessions(cwd, { limit: 1000 });
      expect(all.total, `${name} total`).toBe(5);
      expect(all.sessions, `${name} full page`).toHaveLength(5);

      const zero = r.listSessions(cwd, { limit: 0 });
      expect(zero.total, `${name} limit0 total`).toBe(5);
      expect(zero.sessions, `${name} limit0 page`).toHaveLength(0);

      const atTotal = r.listSessions(cwd, { limit: 2, offset: 5 });
      expect(atTotal.total, `${name} atTotal total`).toBe(5);
      expect(atTotal.sessions, `${name} atTotal page`).toHaveLength(0);

      const lastPage = r.listSessions(cwd, { limit: 2, offset: 4 });
      expect(lastPage.total, `${name} lastPage total`).toBe(5);
      expect(lastPage.sessions, `${name} lastPage page`).toHaveLength(1);
      expect(lastPage.sessions[0].sessionId, `${name} lastPage id`).toBe(ids[0]);

      const neg = r.listSessions(cwd, { limit: 20, offset: -1 });
      expect(neg.total, `${name} neg total`).toBe(5);
      expect(neg.sessions, `${name} neg page`).toHaveLength(5);
    }
  });
});
