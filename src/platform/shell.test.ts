import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createMockProc } from '../../tests/lib/mock-process.js';

// 不真起 shell：全部断言基于 spawn 入参与解析结果
vi.mock('./spawn.js', () => ({ spawnProcess: vi.fn() }));

import { spawnProcess } from './spawn.js';
import {
  createShellBackend,
  createBashShellBackend,
  createWin32ShellBackend,
  ShellUnavailableError,
} from './shell.js';
import { clearResolveCache } from './command.js';

const mockSpawn = vi.mocked(spawnProcess);

const tmpDirs: string[] = [];
function mkdtemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-shell-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(createMockProc({ pid: 4242 }));
  clearResolveCache();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  clearResolveCache();
});

/** 取出第一次 spawn 调用的 (file, args, options)。 */
function spawnCall(): { file: string; args: string[]; opts: Record<string, unknown> } {
  const call = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
  expect(call).toBeDefined();
  return { file: call[0], args: call[1], opts: call[2] ?? {} };
}

describe('posix bash 后端', () => {
  it('spawn("bash", ["-c", command], { cwd }) —— 与现状 BashProcessRunner 同语义', () => {
    const backend = createBashShellBackend();
    const proc: ChildProcess = backend.spawn('ls -la', { cwd: '/home/user/project' });
    expect(proc).toBeDefined();
    expect(spawnCall()).toEqual({
      file: 'bash',
      args: ['-c', 'ls -la'],
      opts: { cwd: '/home/user/project' },
    });
  });

  it('options 透传给底层 spawn（stdio/detached 等）', () => {
    const backend = createBashShellBackend();
    backend.spawn('ls', {
      cwd: '/tmp',
      options: { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    });
    expect(spawnCall().opts).toEqual({
      cwd: '/tmp',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  });

  it('spawnArgv 原样透传 argv、cwd 与 options，不拼 shell 字符串', () => {
    const backend = createBashShellBackend();
    backend.spawnArgv('node', ['script.js', '--message', 'hello world'], {
      cwd: '/home/user/project',
      options: { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    });
    expect(spawnCall()).toEqual({
      file: 'node',
      args: ['script.js', '--message', 'hello world'],
      opts: {
        cwd: '/home/user/project',
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    });
  });
});

describe('win32 shell 后端', () => {
  it('默认 Git Bash：解析 bash.exe 后执行 "-c"', () => {
    const dir = mkdtemp();
    const bashExe = path.join(dir, 'bash.exe');
    fs.writeFileSync(bashExe, 'MZ');

    const backend = createWin32ShellBackend({ pathEnv: dir });
    backend.spawn('ls -la', { cwd: 'C:\\Users\\user\\project' });

    const { file, args, opts } = spawnCall();
    expect(file).toBe(bashExe);
    expect(args).toEqual(['-c', 'ls -la']);
    expect(opts.cwd).toBe('C:\\Users\\user\\project');
    // 关键：避免 detached 子进程在桌面闪控制台窗口
    expect(opts.windowsHide).toBe(true);
  });

  it('找不到 bash.exe → 抛 ShellUnavailableError（提示需要 Git Bash）', () => {
    const dir = mkdtemp();
    const backend = createWin32ShellBackend({ pathEnv: dir });
    expect(() => backend.spawn('ls', { cwd: 'C:\\tmp' })).toThrow(ShellUnavailableError);
    expect(() => backend.spawn('ls', { cwd: 'C:\\tmp' })).toThrow(/Git Bash/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('显式选择 powershell', () => {
    const backend = createWin32ShellBackend({ kind: 'powershell' });
    backend.spawn('Get-ChildItem', { cwd: 'C:\\tmp' });
    const { file, args } = spawnCall();
    expect(file.toLowerCase()).toMatch(/^powershell(\.exe)?$/);
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem']);
  });

  it('显式选择 cmd', () => {
    const backend = createWin32ShellBackend({ kind: 'cmd' });
    backend.spawn('dir', { cwd: 'C:\\tmp' });
    expect(spawnCall()).toMatchObject({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'dir'] });
  });

  it('options 透传（detached/stdio），且 windowsHide 不可被调用方覆盖', () => {
    const backend = createWin32ShellBackend({ kind: 'cmd' });
    backend.spawn('dir', { cwd: 'C:\\tmp', options: { detached: true, windowsHide: false } });
    const { opts } = spawnCall();
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
  });

  it('spawnArgv 的非 shell 命令原样交给 cross-spawn，并强制 windowsHide', () => {
    const backend = createWin32ShellBackend();
    backend.spawnArgv('C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log("ok")'], {
      cwd: 'C:\\Users\\user\\project',
      options: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
    });
    expect(spawnCall()).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['-e', 'console.log("ok")'],
      opts: {
        cwd: 'C:\\Users\\user\\project',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    });
  });

  it.each([
    ['bash', ['-lc', 'echo hi']],
    ['C:\\Program Files\\Git\\bin\\bash.exe', ['-lc', 'echo hi']],
    ['SH.exe', ['-c', 'pwd']],
    ['zsh', ['-c', 'pwd']],
    ['dash', ['-c', 'pwd']],
  ])('spawnArgv 将 shell 名 %s 解析到 Git Bash，且不改写 argv', (file, args) => {
    const dir = mkdtemp();
    const bashExe = path.join(dir, 'bash.exe');
    fs.writeFileSync(bashExe, 'MZ');
    const backend = createWin32ShellBackend({ pathEnv: dir });

    backend.spawnArgv(file, args, { cwd: 'C:\\project' });

    expect(spawnCall()).toEqual({
      file: bashExe,
      args,
      opts: { cwd: 'C:\\project', windowsHide: true },
    });
  });

  it('spawnArgv 找不到 Git Bash 时抛 ShellUnavailableError，不泛化执行原命令', () => {
    const dir = mkdtemp();
    const backend = createWin32ShellBackend({ pathEnv: dir });
    expect(() => backend.spawnArgv('bash', ['-lc', 'pwd'], { cwd: 'C:\\project' })).toThrow(
      ShellUnavailableError,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('createShellBackend — 平台分发', () => {
  // spawn 行为已在上方 posix/win32 后端 describe 覆盖，分发层只钉 kind。
  it('未注入 platform 时取当前宿主并选择对应后端', () => {
    expect(createShellBackend().kind).toBe('bash');
  });

  it('posix → bash 后端', () => {
    expect(createShellBackend({ platform: 'linux' }).kind).toBe('bash');
  });

  it('win32 → 默认 Git Bash 后端', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'bash.exe'), 'MZ');
    expect(createShellBackend({ platform: 'win32', pathEnv: dir }).kind).toBe('bash');
  });
});
