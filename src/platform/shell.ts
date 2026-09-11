/**
 * ShellBackend：把 `!` 命令与 kimi ACP terminal 的 shell 依赖收进 seam
 * （design.md §7.2）。
 *
 * - posix：`bash -c <command>`（与现状 BashProcessRunner 同语义）；
 * - win32：默认 Git Bash（`bash.exe -c <command>`），powershell / cmd 仅作为
 *   显式用户选择 §7.3；
 * - 首版不做命令翻译器：Git Bash 缺失时抛 {@link ShellUnavailableError}，
 *   由调用方转成明确错误卡（提示需要 Git Bash）。
 *
 * kimi ACP 的 terminal/create 固定 `bash -c`，因此 Git Bash 不是 `!` 的专属
 * 需求，而是 kimi agent 在 Windows 上可用的前置条件（§4.4）。
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { currentPlatform, isWin32 } from './select.js';
import { resolveExecutable, type ResolveOptions, type LaunchSpec } from './command.js';
import { spawnProcess } from './spawn.js';

export type ShellKind = 'bash' | 'powershell' | 'cmd';

export interface ShellBackend {
  readonly kind: ShellKind;
  /**
   * 执行 command。`options` 透传给底层 spawn（如 stdio/detached）；
   * win32 会强制附加 `windowsHide: true`，调用方无法覆盖。
   */
  spawn(command: string, opts: { cwd: string; options?: SpawnOptions }): ChildProcess;
}

/** shell 不可用（如 win32 上没装 Git Bash）：调用方应转成明确错误卡。 */
export class ShellUnavailableError extends Error {
  readonly kind: ShellKind;

  constructor(kind: ShellKind, message: string) {
    super(message);
    this.name = 'ShellUnavailableError';
    this.kind = kind;
  }
}

export type SpawnLike = (
  file: string,
  args: readonly string[],
  opts?: SpawnOptions,
) => ChildProcess;

export interface ShellBackendDeps {
  /** 平台注入（测试用）；默认当前宿主平台 */
  platform?: NodeJS.Platform;
  /** win32 下的后端选择：默认 bash（Git Bash） */
  kind?: ShellKind;
  /** spawn 注入（测试用）；默认 platform/spawn 的 cross-spawn 包装 */
  spawn?: SpawnLike;
  /** PATH 注入（测试 / 守护 env 用）；win32 解析 bash.exe 时透传 */
  pathEnv?: string;
  /** 命令解析注入（测试用）；默认 resolveExecutable */
  resolve?: (name: string, opts?: ResolveOptions) => LaunchSpec | null;
}

/** posix bash 后端：`bash -c <command>`。 */
export function createBashShellBackend(deps: ShellBackendDeps = {}): ShellBackend {
  const spawnFn = deps.spawn ?? spawnProcess;
  return {
    kind: 'bash',
    spawn(command, opts): ChildProcess {
      return spawnFn('bash', ['-c', command], { cwd: opts.cwd, ...opts.options });
    },
  };
}

/** win32 后端：默认 Git Bash，powershell/cmd 为显式用户选择。 */
export function createWin32ShellBackend(deps: ShellBackendDeps = {}): ShellBackend {
  const spawnFn = deps.spawn ?? spawnProcess;
  const kind = deps.kind ?? 'bash';

  if (kind === 'powershell') {
    return {
      kind,
      spawn(command, opts): ChildProcess {
        return spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          cwd: opts.cwd,
          ...opts.options,
          windowsHide: true,
        });
      },
    };
  }

  if (kind === 'cmd') {
    return {
      kind,
      spawn(command, opts): ChildProcess {
        return spawnFn('cmd.exe', ['/d', '/s', '/c', command], {
          cwd: opts.cwd,
          ...opts.options,
          windowsHide: true,
        });
      },
    };
  }

  return {
    kind: 'bash',
    spawn(command, opts): ChildProcess {
      const resolve = deps.resolve ?? resolveExecutable;
      const spec = resolve('bash', { platform: 'win32', pathEnv: deps.pathEnv });
      if (!spec) {
        throw new ShellUnavailableError(
          'bash',
          'Windows 上执行 bash 命令需要 Git Bash（未在 PATH 中找到 bash.exe）；' +
            '请安装 Git for Windows 后重试',
        );
      }
      // 执行语义由 cross-spawn 负责（垫片 cmd.exe 受控执行）；这里只保证
      // bash 存在性并给出明确的「需要 Git Bash」错误
      return spawnFn(spec.file, ['-c', command], {
        cwd: opts.cwd,
        ...opts.options,
        windowsHide: true,
      });
    },
  };
}

/** 平台分发的唯一入口：posix → bash，win32 → 默认 Git Bash。 */
export function createShellBackend(deps: ShellBackendDeps = {}): ShellBackend {
  const platform = deps.platform ?? currentPlatform;
  return isWin32(platform) ? createWin32ShellBackend(deps) : createBashShellBackend(deps);
}
