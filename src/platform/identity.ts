/**
 * pid 身份验证（design.md §3.4 / §3.5）。
 *
 * POSIX 现状用 `ps -o command=` 读命令行，Windows 没有 ps，等价物是 CIM：
 * PowerShell `Get-CimInstance Win32_Process` 取 CommandLine，并额外取
 * CreationDate 做 pid 复用加固（Windows pid 复用快）。
 *
 * 纪律：
 * - 只在查询失败/身份不匹配时返回 null / false，绝不抛给调用方——调用方
 *   （killOrphan、实例锁陈旧判定）一律「只有身份匹配才动手」；
 * - win32 每次查询要拉起 PowerShell（冷启动约 1s），批量扫 pid 文件的场景
 *   （killOrphan）应按需调用，真机矩阵（M0）需实测整体耗时；
 * - platform 显式注入，win32 语义可在任意宿主上单测。
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { currentPlatform, isWin32 } from './select.js';

/** 进程身份快照。creationDate 仅 win32（CIM CreationDate，DMTF 时间串）。 */
export interface ProcessIdentity {
  commandLine: string;
  creationDate?: string;
}

export interface QueryIdentityOptions {
  /** 平台注入（测试用）；默认当前宿主平台 */
  platform?: NodeJS.Platform;
  /** 查询超时（毫秒），超时杀掉查询进程并返回 null */
  timeoutMs?: number;
}

export interface VerifyPidIdentityOptions extends QueryIdentityOptions {
  /** 期望的二进制名（basename，如 'claude'/'node'）；win32/darwin 大小写不敏感 */
  expectedBinary: string;
  /** pid 文件记录的 CreationDate；旧文件缺省该字段则退化为仅命令行匹配 */
  expectedCreationDate?: string;
  /** 匹配强度；默认 'executable'（见 {@link IdentityMatchMode}） */
  matchMode?: IdentityMatchMode;
}

/**
 * 匹配强度。两个调用方观测到的进程形态**不同**，因此不能共用一档强度：
 *
 * - `'executable'`（默认）：命令行的可执行位就是该名字——首 token 的 basename，
 *   或带路径分隔符的 token 的 basename 去扩展名后相等。用于「记录值本身就是
 *   可执行名」的调用方（`InstanceLock` 记 `binaryName(process.execPath)`）。
 *   这里**不能放松**：把它放松成路径段匹配，一个 `node-18` 形态的无关进程就会被
 *   判成「锁还在」，新实例再也起不来。
 *
 * - `'agent-invocation'`：agent CLI 普遍以 **解释器调用脚本** 的形态存在
 *   （npm/pnpm/bun 全局装的 `bin` 是 `#!/usr/bin/env node` 脚本），ps 看到的是
 *   `node <安装路径>/.../cli.js`，agent 名只出现在**路径段**里：
 *     - `pi`   → `node ~/.nvm/…/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`
 *     - `dsh`  → `node ~/.nvm/…/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`
 *     - `codex`→ `node ~/.nvm/…/lib/node_modules/@openai/codex/bin/codex.js`（basename 恰好命中）
 *   在 `'executable'` 之上，再接受「带路径分隔符的 token 的某个路径段等于
 *   expectedBinary，或以 expectedBinary + 非字母数字字符开头」。用于 killOrphan
 *   （记录的是二进制名，观测到的是解释器调用）。
 *
 *   两条纪律仍保留：裸参数不参与匹配（`bash claude`、`grep claude foo.log` 仍然
 *   不匹配），非首 token 必须含路径分隔符。代价是「段前缀」比精确相等松一点
 *   （`node /x/pi-data/y.js` 会被判成 pi）——比旧的 `out.includes(needle)` 子串匹配
 *   严格，且换取的是 pi/dsh 这类 agent 的孤儿真的能被回收。
 *
 * 未被使用的一档强度等于死代码：加档必须同时有生产调用方与用例。
 */
export type IdentityMatchMode = 'executable' | 'agent-invocation';

const DEFAULT_TIMEOUT_MS = 3000;

interface CollectResult {
  code: number | null;
  stdout: string;
}

/** 拉起一次性查询进程并收全 stdout；超时/拉起失败/进程报错一律 null。 */
function collect(file: string, args: string[], timeoutMs: number): Promise<CollectResult | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      // stderr 用 ignore：查询进程的错误输出我们不需要，pipe 而不消费在极端
      // 情况下（管道缓冲满）会阻塞子进程，把一次性查询拖成挂起。
      // windowsHide：避免查询进程在桌面闪控制台窗口
      proc = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (result: CollectResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.on('error', () => finish(null));
    proc.on('exit', (code) => finish({ code, stdout }));
    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

/** 解析 CIM 输出（ConvertTo-Json 形态）：单对象或数组，取首条。 */
function parseCimIdentity(stdout: string): ProcessIdentity | null {
  const text = stdout.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== 'object') return null;
  const record = first as { CommandLine?: unknown; CreationDate?: unknown };
  // 权限不足时 CIM 会给出 null 字段：命令行拿不到就没有身份可言
  const commandLine = typeof record.CommandLine === 'string' ? record.CommandLine.trim() : '';
  if (!commandLine) return null;
  const rawDate = typeof record.CreationDate === 'string' ? record.CreationDate.trim() : '';
  return rawDate ? { commandLine, creationDate: rawDate } : { commandLine };
}

/**
 * 查询进程身份；进程不存在或查询失败返回 null。
 */
export async function queryProcessIdentity(
  pid: number,
  opts?: QueryIdentityOptions,
): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = opts?.platform ?? currentPlatform;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (isWin32(platform)) {
    const result = await collect(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" ` +
          // -Compress：单行输出，避免 PowerShell 按控制台宽度换行给解析添变数
          '| Select-Object -Property CommandLine,CreationDate | ConvertTo-Json -Compress',
      ],
      timeoutMs,
    );
    return result ? parseCimIdentity(result.stdout) : null;
  }
  const result = await collect('ps', ['-o', 'command=', '-p', String(pid)], timeoutMs);
  if (!result || result.code !== 0) return null;
  const commandLine = result.stdout.split('\n')[0]?.trim() ?? '';
  return commandLine ? { commandLine } : null;
}

function caseInsensitive(platform: NodeJS.Platform): boolean {
  // 与 PathKit.samePath 同口径：win32/darwin 大小写不敏感，linux 严格
  return isWin32(platform) || platform === 'darwin';
}

/**
 * 引号感知的命令行 tokenizer：双引号段不按空白拆分。CIM 的 CommandLine 里
 * "C:\Program Files\nodejs\node.exe" 这类含空格路径必须整段保留，朴素
 * split(/\s+/) 会切碎 token 导致身份假阴性。
 */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasContent = false;
  let inQuotes = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      // 空引号段也是 token 内容（"" x 与 x 不同），与 cmd 的近似语义一致
      hasContent = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (hasContent) tokens.push(current);
      current = '';
      hasContent = false;
    } else {
      current += ch;
      hasContent = true;
    }
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

/**
 * 取命令行 token 的「去掉扩展名的 basename」，用于与期望二进制名比较。
 *
 * 导出是给「自己记录进程名」的调用方（InstanceLock 写锁文件）复用同一口径：
 * 记录值与比较口径若各写一份，锁会永远判「名字不符 → 陈旧」，自造一次新的
 * half-migration。win32 上 `.cmd` 垫片（`node_modules/.bin/claude.cmd`）也靠
 * 这里的去扩展名把 `claude.cmd` 归一成 `claude`。
 */
export function binaryName(token: string, platform: NodeJS.Platform = currentPlatform): string {
  let text = token.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  // CIM 的 CommandLine 用 Windows 分隔符；posix 用 unix 分隔符
  const p = isWin32(platform) ? path.win32 : path.posix;
  const name = stripExtension(p.basename(text));
  return caseInsensitive(platform) ? name.toLowerCase() : name;
}

/**
 * 命令行与期望二进制是否属于同一程序（review 2026-09-05 收紧 + 2026-09-20 分档）。
 *
 * 1. 可执行位匹配：首 token 的 basename 相等——`/usr/local/bin/claude --verbose`
 *    匹配 claude；native 单文件 CLI（claude 的 `bin/claude.exe`）也走这条；
 * 2. 或后续 token 是**带路径分隔符的脚本路径**且 basename（去扩展名）相等——
 *    `node /home/user/.local/bin/claude`、`…/@openai/codex/bin/codex.js` 匹配；
 * 3. 仅 `'agent-invocation'` 档再放开到**路径段**：某个路径段等于 expectedBinary，
 *    或以 expectedBinary + 非字母数字字符开头。这是为了 `node …/pi-coding-agent/…/cli.js`
 *    这类「名字只在目录里」的安装形态（见 IdentityMatchMode）。
 *
 * 任意位置裸参数不参与匹配：`bash claude`（脚本恰好叫 claude）、`grep claude foo.log`
 * 这类不再假阳性（killOrphan 场景会误杀无辜进程）。
 */
function commandLineMatches(
  commandLine: string,
  want: string,
  platform: NodeJS.Platform,
  mode: IdentityMatchMode,
): boolean {
  const tokens = tokenizeCommandLine(commandLine);
  const first = tokens[0];
  if (first !== undefined && binaryName(first, platform) === want) return true;
  return tokens.slice(1).some((token) => {
    // 非首 token 必须像「路径」才参与：把裸参数（`bash claude`）排除在外
    if (!/[/\\]/.test(token)) return false;
    if (binaryName(token, platform) === want) return true;
    if (mode !== 'agent-invocation') return false;
    return token.split(/[/\\]/).some((segment, index, all) => {
      // 末段是文件名：与 binaryName 同口径去扩展名；中间段是目录名，保留原样
      const name = index === all.length - 1 ? stripExtension(segment) : segment;
      const normalized = caseInsensitive(platform) ? name.toLowerCase() : name;
      if (normalized === want) return true;
      if (!normalized.startsWith(want)) return false;
      // `pi-coding-agent` / `claude.mock.js` 命中；`claudette` / `claudeAgent` 不命中。
      // 判定分隔符必须同时覆盖大小写字母（linux 档不归一大小写，`claudeX` 的 X
      // 是字母而不是分隔符）。
      const next = normalized[want.length];
      return next !== undefined && !/[a-zA-Z0-9]/.test(next);
    });
  });
}

/** 去掉最后一个扩展名（`claude.mock.js` → `claude.mock`）。与 binaryName 的口径一致。 */
function stripExtension(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 身份判定三态。`unknown`（查询失败/进程已消失）与 `mismatch`（身份不符）必须
 * 分开：两个调用方对它们的处置**方向相反**——
 *   - killOrphan：两者都不杀（fail-closed，宁可留孤儿也不误杀无辜进程）；
 *   - InstanceLock：`unknown` 退回纯存活探测（不 clobber 无法证伪的锁），
 *     只有 `mismatch` 才判陈旧并接管。
 * 布尔接口无法同时表达这两种语义，因此这里（async + sync 两个 verdict 入口）是
 * 唯一判定源。
 */
export type IdentityVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * 身份快照 → 判定。async/sync 两条取快照的路径共用这一处比较逻辑：口径若各写
 * 一份，迟早会因为「只在一个路径上收紧规则」而分裂成两种身份语义。
 */
function decideIdentity(
  identity: ProcessIdentity,
  opts: VerifyPidIdentityOptions,
  platform: NodeJS.Platform,
): IdentityVerdict {
  const want = caseInsensitive(platform) ? opts.expectedBinary.toLowerCase() : opts.expectedBinary;
  const mode = opts.matchMode ?? 'executable';
  if (!commandLineMatches(identity.commandLine, want, platform, mode)) return 'mismatch';
  // CreationDate 仅在 pid 文件带了第三行时才比对（旧文件缺字段 → 退化为命令行匹配）
  const expected = opts.expectedCreationDate?.trim();
  if (expected && identity.creationDate !== expected) return 'mismatch';
  return 'match';
}

export async function verifyPidIdentityVerdict(
  pid: number,
  opts: VerifyPidIdentityOptions,
): Promise<IdentityVerdict> {
  const platform = opts.platform ?? currentPlatform;
  const identity = await queryProcessIdentity(pid, opts);
  if (!identity) return 'unknown';
  return decideIdentity(identity, opts, platform);
}

/**
 * 同步版判定，给无法 await 的调用方（`SpawningRunner.killOrphan`——Bridge.getRunner
 * 是同步方法，异步化会级联整个 runner 接口）。
 *
 * posix 用 `execFileSync('ps', ...)`，与 `queryProcessIdentity` 的 posix 分支是
 * 同一条命令、同一个超时；win32 **恒返回 `unknown`**——CIM 必须经 PowerShell
 * 收 stdout，没有同步形态。`unknown` 在 killOrphan 的 fail-closed 语义下就是
 * 「不杀 + 清陈旧 pid 文件」，与异步路径一致，因此不是能力缺失而是正确的降级。
 *
 * 严禁在这里退回「跳过身份校验直接 kill(pid, 0)」的旧行为：那正是本次迁移
 * 要堵的洞（pid 被系统回收给无关进程时会误杀）。
 */
export function verifyPidIdentityVerdictSync(
  pid: number,
  opts: VerifyPidIdentityOptions,
): IdentityVerdict {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  const platform = opts.platform ?? currentPlatform;
  if (isWin32(platform)) return 'unknown';

  let stdout: string;
  try {
    stdout = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    // 进程不存在 / ps 不可用 / 超时：查不到身份 → unknown（不杀）
    return 'unknown';
  }
  const commandLine = stdout.split('\n')[0]?.trim() ?? '';
  if (!commandLine) return 'unknown';
  return decideIdentity({ commandLine }, opts, platform);
}
