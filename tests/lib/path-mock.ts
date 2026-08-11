/**
 * PATH-mock helpers for agent runner tests.
 *
 * Agent CLIs are hard-coded by name ('claude' / 'codex' / 'opencode' / 'pi' /
 * 'kimi') — the user-configurable `binary` option was removed from config and
 * runner constructors. Tests that need a mock CLI therefore place an
 * executable named exactly like the agent in a temp dir on PATH instead of
 * injecting a custom binary path.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Prepend `dir` to PATH so `spawn(name)` / `execFileSync(name)` resolve the
 * mock binary first. Returns the previous PATH value for `restorePath`.
 */
export function prependPath(dir: string): string | undefined {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${saved ? `:${saved}` : ''}`;
  return saved;
}

/** Restore PATH to the value captured by `prependPath`. */
export function restorePath(saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = saved;
  }
}

/**
 * Write an executable mock script named `name` inside `dir` (must already
 * exist) and return its absolute path. `content` is the full script body —
 * callers choose the shebang (bash mock vs node mock).
 */
export function writeMockBin(dir: string, name: string, content: string): string {
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, content, { mode: 0o755 });
  return binPath;
}
