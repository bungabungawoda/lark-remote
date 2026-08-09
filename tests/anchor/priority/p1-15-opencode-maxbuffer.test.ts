import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OpencodeSessionReader } from '../../../src/session/opencode/sessions.js';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

describe('P1-15 opencode session list maxBuffer', () => {
  afterEach(() => {
    mockLogger.warn.mockReset();
  });

  it('test_anchor_opencode_session_list_over_1MiB_not_silently_emptied', async () => {
    // ① 验证什么行为：session list 输出超过 execFileSync 默认 maxBuffer（1MiB）
    //    时，reader 必须正常解析并返回 session（而非静默吞空）；「真空」与
    //    「输出太大失败」必须可区分。
    // ② 缺失/错误会导致什么：execFileSync 未设 maxBuffer → stdout >1MiB 抛
    //    ENOBUFS → catch 返回 [] → 用户看到「当前目录没有 session 记录」、
    //    isSessionActive 恒 false —— 失败静默且与「真的没有 session」不可区分。
    // ③ 依据：review.md §P1-15「maxBuffer 截断：execFileSync 未设 maxBuffer，
    //    默认 1MiB…stdout > 1MiB → 抛 ENOBUFS…fetchSessionList 返回 []…修复
    //    建议：两处 execFileSync 加 maxBuffer: 64 * 1024 * 1024」。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-15-opencode-'));
    try {
      // Mock opencode binary: prints a valid session-list JSON array >1MiB.
      // Entries must carry directory === process.cwd() (the reader passes its
      // realpath cwd to execFileSync) so listSessions' directory filter keeps them.
      const script = path.join(tmpDir, 'mock-opencode');
      fs.writeFileSync(
        script,
        `#!/usr/bin/env node
const cwd = process.cwd();
const entries = [];
for (let i = 0; i < 30000; i++) {
  entries.push({
    id: 's' + i,
    title: 't' + i,
    updated: 1000 + i,
    created: 0,
    projectId: 'p',
    directory: cwd,
  });
}
process.stdout.write(JSON.stringify(entries));
`,
      );
      fs.chmodSync(script, 0o755);

      const reader = new OpencodeSessionReader({ binary: script });
      const result = reader.listSessions(tmpDir);

      expect(result.total).toBeGreaterThan(0);
      // Newest (largest updated) sorts first.
      expect(result.sessions[0]?.sessionId).toBe('s29999');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
