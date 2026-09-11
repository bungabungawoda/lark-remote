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
import { spawn } from 'node:child_process';
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
}

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

/** 取命令行 token 的「去掉扩展名的 basename」，用于与期望二进制名比较。 */
function tokenBinaryName(token: string, platform: NodeJS.Platform): string {
  let text = token.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  // CIM 的 CommandLine 用 Windows 分隔符；posix 用 unix 分隔符
  const p = isWin32(platform) ? path.win32 : path.posix;
  const base = p.basename(text);
  const ext = p.extname(base);
  const name = ext ? base.slice(0, -ext.length) : base;
  return caseInsensitive(platform) ? name.toLowerCase() : name;
}

/**
 * 命令行与期望二进制是否属于同一程序。收紧规则（review 2026-09-05）：
 * 1. 首 token（可执行位）匹配——`/usr/local/bin/claude --verbose` 匹配 claude；
 * 2. 或后续 token 是**带路径分隔符的脚本路径**且 basename 匹配——
 *    `node /home/user/.local/bin/claude` 匹配 claude。
 * 任意位置裸参数不再参与匹配：`bash claude`（脚本恰好叫 claude）、
 * `grep claude foo.log` 这类不再假阳性（killOrphan 场景会误杀无辜进程）。
 */
function commandLineMatches(commandLine: string, want: string, platform: NodeJS.Platform): boolean {
  const tokens = tokenizeCommandLine(commandLine);
  const first = tokens[0];
  if (first !== undefined && tokenBinaryName(first, platform) === want) return true;
  return tokens
    .slice(1)
    .some((token) => /[/\\]/.test(token) && tokenBinaryName(token, platform) === want);
}

/**
 * pid 身份验证：进程存活且命令行确实属于期望二进制（+ CreationDate 一致）才 true。
 *
 * 用于 killOrphan 与实例锁陈旧判定——只有这里返回 true 才允许动手。
 */
export async function verifyPidIdentity(
  pid: number,
  opts: VerifyPidIdentityOptions,
): Promise<boolean> {
  const platform = opts.platform ?? currentPlatform;
  const identity = await queryProcessIdentity(pid, opts);
  if (!identity) return false;
  const want = caseInsensitive(platform) ? opts.expectedBinary.toLowerCase() : opts.expectedBinary;
  if (!commandLineMatches(identity.commandLine, want, platform)) return false;
  // CreationDate 仅在 pid 文件带了第三行时才比对（旧文件缺字段 → 退化为命令行匹配）
  const expected = opts.expectedCreationDate?.trim();
  if (expected) return identity.creationDate === expected;
  return true;
}
