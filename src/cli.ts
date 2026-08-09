#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entryUrl = new URL('./index.js', import.meta.url);
const entry = fileURLToPath(entryUrl);

type RuntimeChoice = 'bun' | 'node';

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
    const res = spawnSync('bun', ['--version'], { stdio: 'ignore' });
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
      exit(code ?? 1);
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
  const deps: BootstrapDeps = {
    entry,
    args: process.argv.slice(2),
    isBun: (process as NodeJS.Process & { isBun?: boolean }).isBun ?? false,
    probe: probeBun(),
    importEntry: () => import(entryUrl.href),
    spawnBun: (e, a) => spawn('bun', [e, ...a], { stdio: 'inherit' }),
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
