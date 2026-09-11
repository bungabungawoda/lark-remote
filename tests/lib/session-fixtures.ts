/**
 * Shared test fixtures for session/JSONL fixtures.
 *
 * `encodedProjectDir` mirrors production `src/session/claude/sessions.ts`
 * `projectDirForCwd` (cwd → dirName, lossy N-to-N), but canonicalizes via
 * realpath first so the directory name matches what Claude actually writes
 * (`/private/var/folders/...` not `/var/folders/...`). The production function
 * is module-private; this replica is the test-side mirror and must be kept in
 * sync if the encoding ever changes.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 生产 `projectDirForCwd` 的编码部分（cwd → dirName，lossy N-to-N）。
 *
 * 与 `encodedProjectDir` 的唯一区别：不做 realpath 规范化。测试若已持有
 * 规范化路径、或刻意喂未经规范化的字面量 cwd（production 读到的 jsonl
 * `cwd` 字段就是那个字面量），用这份；否则用 `encodedProjectDir`。
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-').replace(/_/g, '-');
}

export function encodedProjectDir(cwd: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  return encodeClaudeProjectDir(canonical);
}

/** Write a fake Claude session jsonl under <projDir>/<sid>.jsonl with an init
 * line carrying the cwd so production code can locate the file. */
export function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const canonicalCwd = fs.realpathSync(cwd);
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${canonicalCwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}
