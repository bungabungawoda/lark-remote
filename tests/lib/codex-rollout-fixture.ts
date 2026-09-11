import fs from 'node:fs';
import path from 'node:path';

/**
 * W3.7 共享 fixture：codex rollout 文件 + session_meta 行
 * （原 src/session/codex/sessions.test.ts 与 rollout-reader-summary.test.ts
 * 各持逐字同构副本；rollout-reader.test.ts 的 createRolloutFile 是另一形态
 * ——平铺 tmpDir、无日期目录——刻意不并入）。
 */

/** Create a rollout file in the standard YYYY/MM/DD directory structure. */
export function createRollout(
  tmpDir: string,
  filename: string,
  content: string,
  datePath = '2026/07/13',
): string {
  const dir = path.join(tmpDir, 'sessions', ...datePath.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Build a minimal session_meta JSONL line. */
export function metaLine(
  sessionId: string,
  cwd = '/tmp',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { session_id: sessionId, cwd, originator: 'test', ...extra },
    timestamp: '2026-07-13T10:00:00.000Z',
  });
}
