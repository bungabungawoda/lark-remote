import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isExecutableAvailable } from './probe.js';
import { clearResolveCache } from './command.js';

const tmpDirs: string[] = [];
function mkdtemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-probe-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  clearResolveCache();
});

describe('isExecutableAvailable (posix)', () => {
  it('true for an executable on PATH', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent'), 'x', { mode: 0o755 });
    expect(isExecutableAvailable('agent', { platform: 'linux', pathEnv: dir })).toBe(true);
  });

  it('false when missing or non-executable (X_OK)', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent'), 'x', { mode: 0o644 });
    expect(isExecutableAvailable('agent', { platform: 'linux', pathEnv: dir })).toBe(false);
    expect(isExecutableAvailable('missing', { platform: 'linux', pathEnv: dir })).toBe(false);
  });
});

describe('isExecutableAvailable (win32)', () => {
  it('true for .exe via PATHEXT lookup', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent.exe'), 'MZ');
    expect(isExecutableAvailable('agent', { platform: 'win32', pathEnv: dir })).toBe(true);
  });

  it('true even when only the shell fallback (.cmd shim) is launchable', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent.cmd'), 'garbage without any js reference');
    expect(isExecutableAvailable('agent', { platform: 'win32', pathEnv: dir })).toBe(true);
  });

  it('false when no PATHEXT candidate exists', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'agent'), 'no ext on win32');
    expect(isExecutableAvailable('agent', { platform: 'win32', pathEnv: dir })).toBe(false);
  });
});
