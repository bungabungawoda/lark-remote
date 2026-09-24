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
import os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { tmpdir } = os;

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

/**
 * 本仓测试在 `os.tmpdir()` 下使用的专属前缀。
 *
 * 只放「grep 回仓确认过归属、别处不会用」的前缀 —— sweep 会按前缀直接删目录，
 * 前缀写宽了就会误伤。特别注意**不要**把 `lark-remote-inbound-` 放进来：
 * 那是 `src/connector/index.ts` 的**运行时**缓存目录，不是测试产物。
 */
export const OUR_TEMP_PREFIXES = [
  // router / 卡片类用例
  'paging-jump-',
  'download-cmd-',
  'ls-filecard-test-',
  'ls-tilde-test-',
  'ls-file-test-',
  // anchor 类用例
  'codex-card-test-',
  'codex-effort-',
  'codex-model-switch-test-',
  'codex-custom-model-',
  'codex-custom-home-',
  'codex-custom-catalog-home-',
  'pi-stale-db-anchor-',
  'bridge-clear-test-',
  'p1-1-anchor-',
  // runner / bridge 类用例
  'lark-kimi-runner-',
  'lark-runner-test-',
  'lark-codex-appserver-',
  'lark-codex-idle-timeout-',
  'lark-transport-',
  'lark-opencode-acp-',
  'lark-jsonrpc-client-',
  'lark-registry-test-',
  'lark-bridge-test-',
  'lark-pi-rpc-test-',
  'lark-bash-test-',
  'lark-cm-',
  // update 版本检查用例：cache 文件不再落到共享固定路径（win32 会解析成
  // 仓库外的 D:\tmp\，且兜底扫不到），改为 makeTempDir 独占目录
  'lark-remote-update-cache-',
  // 2026-09-22 收口「固定 POSIX 绝对路径当落盘位置」：这些位置的 production
  // 代码真会 mkdir/write（pidDir / Logger dir / configPath / workspacePath），
  // 原先写死 '/tmp/...' 在 win32 上落到仓库外的 D:\tmp\。守卫见
  // tests/misc/temp-dir-hygiene.test.ts 的「固定 POSIX 绝对路径」两条。
  'lark-spawning-runner-anchor-',
  'lark-r16-claude-base-',
  'lark-cmd-status-cwd-',
  'lark-restart-cmd-',
  'lark-p2-11-base-',
  'lark-p2-13-cause-',
  'lark-p2-16-stderr-',
  'lark-p2-19-logger-',
  // 2026-09-22 补漏：这三个前缀 09-21 收口时漏登记，兜底扫不到，
  // 导致 09-10/09-11 的残留一直留在 %TEMP%（测试文件本身已用 rmRf，非泄漏）。
  'lark-approval-integration-',
  'lark-reaction-anchor-',
  // 大文件用例：目录里躺 20-31 MiB 的稀疏文件，被强杀后最需要兜底
  'file-limit-test-',
] as const;

/**
 * 清扫本仓测试在 `os.tmpdir()` 下的残留。
 *
 * 定位是**兜底**：整轮 run 结束后调用一次（vitest globalTeardown），把
 * 「钩子没来得及跑」的残留清掉 —— 用例被强杀、超时、worker 崩溃时 afterEach
 * 不会执行。主动线是 `temp-dir.ts` 的 `makeTempDir()` + afterAll。
 *
 * `baselineMs` 必须是**本轮 run 启动的时刻**（globalSetup 里取），只删 mtime
 * 早于它的条目。没有这道门限就会误伤并行 worktree：本仓流程要求每个改动开
 * 独立 worktree，两个套件同时在跑是常态，A 的 teardown 会把 B 正在用的目录
 * 整片删掉。目录 mtime 在增删条目时会刷新，所以「本轮启动前就没再动过」本身就是
 * 一个可用的失活信号；仍留下的窗口是「比本轮更早启动、且至今仍在跑的套件」里
 * 那些早于基线、之后没再写入的在用目录 —— 要彻底消除得靠占用进程探活，代价不
 * 划算，这里不收口。
 *
 * 跨平台（macOS / Linux 走同一个 `os.tmpdir()`）；删除复用 `rmRf` 的
 * Windows EBUSY 重试，避免刚退出的子进程句柄把目录钉住。
 *
 * @returns 删除成功数与失败清单（失败只报告不抛，别让兜底本身把 run 弄红）
 */
export function sweepProjectTempDirs(baselineMs: number): {
  removed: number;
  failed: string[];
} {
  const tmpRoot = tmpdir();
  let removed = 0;
  const failed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return { removed, failed };
  }
  for (const name of entries) {
    if (!OUR_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = join(tmpRoot, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    // 基线之后动过的目录留给它自己的套件（见函数注释）
    if (stat.mtimeMs >= baselineMs) continue;
    try {
      rmRf(full);
      removed++;
    } catch {
      failed.push(full);
    }
  }
  return { removed, failed };
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
