/**
 * PATH-mock helpers for agent runner tests.
 *
 * Agent CLIs are hard-coded by name ('claude' / 'codex' / 'opencode' / 'pi' /
 * 'kimi') — the user-configurable `binary` option was removed from config and
 * runner constructors. Tests that need a mock CLI therefore place an
 * executable named exactly like the agent in a temp dir on PATH instead of
 * injecting a custom binary path.
 *
 * Fixtures are **platform-neutral by construction** (prefer Node launchers over
 * sh wrappers, minimizing the platform-gated surface): a mock
 * agent is always a Node launcher, never a POSIX shell script.
 *   - posix: writes `<name>` — a `#!/bin/sh` wrapper that `exec`s node on the
 *     entry, so the direct child is node itself (pid identity preserved);
 *   - win32: Windows can neither execute an extensionless script nor resolve a
 *     bare name to a `.js`, but it *does* resolve `name` → `name.cmd` through
 *     PATHEXT — the exact shape npm installs agent CLIs with, and what
 *     `platform/spawn.ts` (cross-spawn) is built to launch. So we write a
 *     `<name>.cmd` shim instead, and `spawn(name)` finds it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { currentPlatform, isWin32 } from '../../src/platform/select.js';

/**
 * Prepend `dir` to PATH so `spawn(name)` / `execFileSync(name)` resolve the
 * mock binary first. Returns the previous PATH value for `restorePath`.
 *
 * The separator must follow the host (`;` on Windows, `:` elsewhere): a
 * hard-coded `:` silently corrupts PATH on Windows, so the mock dir is never
 * searched and the *real* agent CLI on PATH gets spawned instead.
 */
export function prependPath(dir: string): string | undefined {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${saved ? `${path.delimiter}${saved}` : ''}`;
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
 * Write the launcher for `name` inside `dir` (must already exist), pointing at
 * the Node entry file `entry`. Returns `<dir>/<name>` — the specifier that
 * `spawn(name)` resolves on both platforms.
 */
export function writeMockBin(dir: string, name: string, entry: string): string {
  const resolved = path.resolve(entry);
  if (isWin32(currentPlatform)) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nnode "${resolved}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec node "${resolved}" "$@"\n`, {
      mode: 0o755,
    });
  }
  return path.join(dir, name);
}

/**
 * Write a mock agent named `name` whose body is the inline Node source
 * `source`: the source lands in `<name>.mock.js` and `writeMockBin` points the
 * platform-correct launcher at it. Returns `<dir>/<name>`.
 */
export function writeMockSource(dir: string, name: string, source: string): string {
  const entry = path.join(dir, `${name}.mock.js`);
  fs.writeFileSync(entry, source, 'utf-8');
  return writeMockBin(dir, name, entry);
}
