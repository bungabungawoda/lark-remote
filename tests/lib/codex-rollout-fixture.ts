import fs from 'node:fs';
import path from 'node:path';

/**
 * 共享 fixture：codex rollout 文件 + session_meta 行
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

/** 把若干 JSONL 行写到指定目录下的文件，并可按需钉住 mtime（毫秒）。 */
export function writeRolloutLines(
  dayDir: string,
  fileName: string,
  lines: string[],
  mtimeMs?: number,
): string {
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, fileName);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  if (mtimeMs !== undefined) fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

/**
 * 写一个只有 session_meta 首行的最小 rollout（`rollout-<sessionId>.jsonl`），
 * 并把 mtime 钉到 mtimeMs。列表/最新会话类锚点共用。
 */
export function writeMinimalRollout(
  dayDir: string,
  sessionId: string,
  cwd: string,
  mtimeMs: number,
): string {
  return writeRolloutLines(
    dayDir,
    `rollout-${sessionId}.jsonl`,
    [metaLine(sessionId, cwd, { originator: 'x' })],
    mtimeMs,
  );
}
