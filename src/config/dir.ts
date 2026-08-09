import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = '.lark-remote';

let cachedConfigDir: string | null = null;

interface CliArgs {
  configDir?: string;
  settings?: string;
  help?: boolean;
  version?: boolean;
}

export function resolveConfigDir(configDirArg: string | undefined): string {
  if (configDirArg) {
    let p = configDirArg;
    if (p === '~') p = os.homedir();
    else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    return path.resolve(p);
  }
  return path.join(os.homedir(), DEFAULT_DIR);
}

export function getConfigDir(): string {
  if (!cachedConfigDir) {
    cachedConfigDir = path.join(os.homedir(), DEFAULT_DIR);
  }
  return cachedConfigDir;
}

export function setConfigDir(dir: string): void {
  cachedConfigDir = dir;
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): CliArgs {
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (arg === '-v' || arg === '--version') {
      result.version = true;
    } else if (arg === '--config-dir' && i + 1 < args.length) {
      // P1-20: peek, don't consume — when the next arg is itself a flag,
      // roll back so it continues parsing (previously --settings/--help
      // right after --config-dir were silently swallowed).
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        result.configDir = args[++i];
      }
    } else if (arg === '--settings' && i + 1 < args.length) {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        result.settings = args[++i];
      }
    }
  }

  return result;
}

/** Read the project version from package.json (single source of truth). */
export function getVersion(): string {
  const pkgPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'package.json',
  );
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/** Print version to stdout. */
export function printVersion(): void {
  process.stdout.write(`lark-remote ${getVersion()}\n`);
}

/** Print CLI help to stdout. */
export function printHelp(): void {
  const lines = [
    'lark-remote — 飞书私聊 ↔ 本地 Coding Agent CLI 桥接',
    '',
    'Usage:',
    '  lark-remote [options]',
    '',
    'Options:',
    '  --config-dir <path>   自定义配置目录（默认 ~/.lark-remote，可用于同机多实例）',
    '  --settings <path>     指定 Claude 配置文件路径',
    '  -h, --help            显示本帮助信息',
    '  -v, --version         显示版本号',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
