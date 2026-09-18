#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { printAdvanceHelp, printHelp, printVersion } from './config/dir.js';

const entryUrl = new URL('./index.js', import.meta.url);
const entry = fileURLToPath(entryUrl);

/**
 * 最低支持的 Node 主版本。package.json engines 写的是 >=20，这里放宽一档到
 * 18 —— 守卫的目的是把「node 太老」变成一句人话，而不是把边界再收紧一次。
 */
const MIN_NODE_MAJOR = 18;

type RuntimeChoice = 'bun' | 'node';

/**
 * 纯信息类命令 + Node 版本守卫。
 *
 * 必须在 import 应用模块图之前执行。dist/cli.js 自身刻意不使用 ES2020+ 语法
 * （?? / ?. / ??=），这样它在 node 12 上也 **能被解析**；而 dist/index.js 是
 * ES2022，node<14 一加载就是 `SyntaxError: Unexpected token '?'`，堆栈全部落在
 * Node 内部、完全看不出是版本问题（实测：WSL 里的 lark-remote 报的就是这个）。
 *
 * @returns 已处理完时返回退出码（0/1），调用方应立即 `process.exit(code)`；
 *          返回 null 表示不是信息类命令、运行时也够新，继续正常启动。
 */
export function handlePreflight(
  args: string[],
  nodeVersion: string = process.versions.node,
): number | null {
  for (const arg of args) {
    if (arg === '-v' || arg === '--version' || arg === 'version') {
      printVersion();
      return 0;
    }
    if (arg === '-h' || arg === '--help' || arg === 'help') {
      printHelp();
      return 0;
    }
    if (arg === '--advance-help') {
      printAdvanceHelp();
      return 0;
    }
  }

  const major = parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isNaN(major) && major > 0 && major < MIN_NODE_MAJOR) {
    console.error(
      `lark-remote 需要 Node >= ${MIN_NODE_MAJOR}（当前 ${nodeVersion}）。\n` +
        '请升级 Node 后重试；若你在 WSL 里执行，注意 WSL 发行版的 node 与 Windows 侧的 node 是两套。',
    );
    return 1;
  }
  return null;
}

interface BunProbe {
  error: boolean;
  status: number | null;
}

/** Prefer bun unless we are already under bun or bun is not usable. */
export function decideRuntime(isBun: boolean, probe: BunProbe): RuntimeChoice {
  if (!isBun && !probe.error && probe.status === 0) return 'bun';
  return 'node';
}

/** Check whether `bun` is present and runs `--version` successfully. */
function probeBun(): BunProbe {
  try {
    const res = spawnSync('bun', ['--version'], { stdio: 'ignore', windowsHide: true });
    return { error: res.error !== undefined, status: res.status };
  } catch {
    return { error: true, status: null };
  }
}

interface ChildLike {
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface BootstrapDeps {
  entry: string;
  args: string[];
  isBun: boolean;
  probe: BunProbe;
  platform?: string;
  importEntry: () => Promise<unknown>;
  spawnBun: (entry: string, args: string[]) => ChildLike;
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  offSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  killSelf: (signal: NodeJS.Signals) => void;
  exit: (code: number) => void;
}

export async function bootstrap(deps: BootstrapDeps): Promise<void> {
  const {
    entry,
    args,
    isBun,
    probe,
    platform = process.platform,
    importEntry,
    spawnBun,
    onSignal,
    offSignal,
    killSelf,
    exit,
  } = deps;

  if (decideRuntime(isBun, probe) === 'node') {
    await importEntry();
    return;
  }

  const child = spawnBun(entry, args);
  const signals: NodeJS.Signals[] =
    platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forwarders = new Map<NodeJS.Signals, () => void>();
  for (const sig of signals) {
    const forwarder = () => child.kill(sig);
    forwarders.set(sig, forwarder);
    onSignal(sig, forwarder);
  }

  child.on('error', () => {
    for (const [sig, forwarder] of forwarders) offSignal(sig, forwarder);
    void importEntry().catch(() => exit(1));
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      for (const [sig, forwarder] of forwarders) offSignal(sig, forwarder);
      try {
        killSelf(signal);
      } catch {
        exit(1);
      }
    } else {
      // 不用 `??`：cli.js 是入口，必须在 node<14 上也能被解析（见 handlePreflight）。
      exit(typeof code === 'number' ? code : 1);
    }
  });
}

function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const candidates: string[] = [];
  try {
    candidates.push(fs.realpathSync(argv1));
  } catch {}
  candidates.push(path.resolve(argv1));
  return candidates.some((p) => pathToFileURL(p).href === import.meta.url);
}

function main(): void {
  const args = process.argv.slice(2);
  // 信息类命令 / 过旧运行时：在探测 bun、import 应用模块图之前先处理掉。
  const preflight = handlePreflight(args);
  if (preflight !== null) {
    process.exit(preflight);
  }

  const isBunFlag = (process as NodeJS.Process & { isBun?: boolean }).isBun;
  const deps: BootstrapDeps = {
    entry,
    args,
    isBun: isBunFlag === true,
    probe: probeBun(),
    importEntry: () => import(entryUrl.href),
    spawnBun: (e, a) => spawn('bun', [e, ...a], { stdio: 'inherit', windowsHide: true }),
    onSignal: (sig, handler) => process.on(sig, handler),
    offSignal: (sig, handler) => process.off(sig, handler),
    killSelf: (sig) => process.kill(process.pid, sig),
    exit: (code) => process.exit(code),
  };
  void bootstrap(deps).catch(() => process.exit(1));
}

if (isDirectEntry()) {
  main();
}
