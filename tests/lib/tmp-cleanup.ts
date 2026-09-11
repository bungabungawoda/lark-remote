/**
 * Windows 友好的临时目录清理。
 *
 * afterEach 直接 `rmSync(tmpDir, { recursive: true })` 在 Windows 上会踩
 * EBUSY/EPERM：runner 子进程（cmd.exe 垫片 → node mock server）的 cwd 就是
 * tmpDir 下的 workspace，用例结束后子进程可能仍未退出，目录被锁定；posix
 * 上不存在该竞态。策略：
 *   1. 短间隔重试，覆盖「进程正在退出、句柄即将释放」的正常延迟；
 *   2. 仍 EBUSY 时按命令行精准匹配 tmpDir 路径查找占用进程并 taskkill 树杀
 *      （mock server 的 argv 含 tmpDir 随机后缀，不会误伤无关进程），
 *      随后继续重试直到删除成功。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE']);
const MAX_ATTEMPTS = 100;
const RETRY_DELAY_MS = 100;
const KILL_AFTER_ATTEMPTS = 2;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 树杀命令行引用了 target 的进程（win32 only；posix 无此竞态不调用）。 */
function killHolders(target: string): void {
  if (process.platform !== 'win32') return;
  const needle = target.includes(' ') ? `'${target}'` : target;
  // 用 PS 原生 Stop-Process（受限环境里 taskkill.exe 不可见）；cmd 垫片的
  // node 子进程命令行同样含 tmpDir 路径，rmRf 循环的周期性重杀会覆盖到。
  // 排除 PS 自身（$PID）：-Command 参数里嵌着 needle，不排除会自杀断管道，
  // 目标进程反而杀不到。
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${needle}*' } | ` +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ],
    { stdio: 'ignore', timeout: 15_000, windowsHide: true },
  );
}

export function rmRf(target: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code)) throw err;
      if (
        attempt === KILL_AFTER_ATTEMPTS - 1 ||
        (attempt > KILL_AFTER_ATTEMPTS && attempt % 10 === 0)
      ) {
        killHolders(target);
        // Stop-Process 异步生效：留出进程退出时间，再进入重试
        sleepSync(800);
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}
