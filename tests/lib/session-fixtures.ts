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

export function encodedProjectDir(cwd: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  return canonical.replace(/\//g, '-').replace(/_/g, '-');
}

/** Write a fake Claude session jsonl under <projDir>/<sid>.jsonl with an init
 * line carrying the cwd so production code can locate the file. */
export function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  const canonicalCwd = fs.realpathSync(cwd);
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${canonicalCwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}
