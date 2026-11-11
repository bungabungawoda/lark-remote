/**
 * 跑一个 CLI 子命令并收集 stdout —— agent 配置探测（codex `debug models`、
 * pi `--list-models`）的共用实现。
 *
 * 必须经 platform/spawn（cross-spawn）而非裸 execFileSync：agent CLI 多为 npm
 * 全局安装的 .cmd 垫片，win32 上 execFileSync 不做 PATHEXT 解析 —— 裸名会被
 * 解析到无扩展名的 sh 脚本（给 Git Bash/WSL 用的那份），Windows 原生执行直接
 * 失败（bun 下 exit 1「系统找不到指定的路径」，node 下 ENOENT）；而
 * execFileSync('x.cmd') 又因 execFile 不经 shell 直接 EINVAL。cross-spawn 与
 * runner spawn 走同一垫片执行路径（posix 直通）。
 *
 * stderr 参与 pipe：失败信息带 stderr 片段，避免只留一句无诊断价值的
 * "Command failed"（历史教训：真因只存在于被丢弃的 stderr 里）。
 */
import { spawnProcess, spawnProcessSync } from './spawn.js';

/** 一次探测调用的边界：错误信息里的命令名、超时、输出上限。 */
export interface TextCommandLimits {
  /** 错误信息里的命令名，例如 'codex' / 'pi'。 */
  label: string;
  timeoutMs: number;
  maxBuffer: number;
}

/** stderr 进错误信息的截断长度：够定位原因，又不至于把日志冲爆。 */
const STDERR_TAIL = 200;

function exitError(limits: TextCommandLimits, code: number | string | null, stderr: string): Error {
  const tail = stderr.trim().slice(0, STDERR_TAIL);
  return new Error(`${limits.label} exited ${code}${tail ? `: ${tail}` : ''}`);
}

/**
 * 同步跑完一条命令，返回完整 stdout。
 *
 * @throws 命令起不来（spawn error）、非 0 退出、或超时；错误信息带 stderr 片段。
 */
export function runTextCommandSync(
  binary: string,
  args: readonly string[],
  limits: TextCommandLimits,
): string {
  const res = spawnProcessSync(binary, args, {
    encoding: 'utf-8',
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw exitError(limits, res.status, String(res.stderr ?? ''));
  return String(res.stdout ?? '');
}

/**
 * 异步跑完一条命令，流式收集 stdout。与同步路径同超时 / 输出上限；
 * stdout 超上限主动 kill（对齐 execFile maxBuffer 语义）。
 */
export function runTextCommandAsync(
  binary: string,
  args: readonly string[],
  limits: TextCommandLimits,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(new Error(`${limits.label} timed out after ${limits.timeoutMs}ms`));
      });
    }, limits.timeoutMs);
    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += String(chunk);
      if (stdout.length > limits.maxBuffer) {
        settle(() => {
          child.kill();
          reject(
            new Error(`${limits.label} stdout exceeded maxBuffer (${limits.maxBuffer} bytes)`),
          );
        });
      }
    });
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (err: Error) => settle(() => reject(err)));
    child.on('close', (code: number | null) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(exitError(limits, code, stderr));
        }
      });
    });
  });
}
