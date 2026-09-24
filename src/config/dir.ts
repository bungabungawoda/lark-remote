import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = '.lark-remote';

let cachedConfigDir: string | null = null;

interface CliArgs {
  configDir?: string;
  settings?: string;
  dev?: boolean;
  help?: boolean;
  version?: boolean;
  update?: boolean;
  advanceHelp?: boolean;
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
    if (arg === '-h' || arg === '--help' || arg === 'help') {
      result.help = true;
    } else if (arg === '-v' || arg === '--version' || arg === 'version') {
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
    } else if (arg === '--dev') {
      result.dev = true;
    } else if (arg === '--advance-help') {
      result.advanceHelp = true;
    } else if (arg === '--update' || arg === 'update') {
      // 裸子命令等价形式：`lark-remote update` 与 `--update` 同义。
      // 不识别时它会落到守护进程路径去抢单例锁，被正在运行的实例挡下
      // （"already running"），而 update 根本不是守护类命令。
      result.update = true;
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
  // 不用 `??`：本模块会被 dist/cli.js 静态引入，而 cli.js 必须在很旧的 Node
  // （实测 WSL v12）上也 **能解析** —— node<14 不认识 ??，会直接 SyntaxError。
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
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
    '  lark-remote [command] [options]',
    '',
    'Commands:',
    '  update                 等同 --update：升级到最新版本后退出（不被运行中的实例阻塞）',
    '  version                等同 --version',
    '  help                   等同 --help',
    '',
    'Options:',
    '  --config-dir <path>   自定义配置目录（默认 ~/.lark-remote，可用于同机多实例）',
    '  --settings <path>     指定 Claude 配置文件路径',
    '  --dev                 开发模式：标记从源码 bun src/index.ts 启动（看门狗据此选择拉起方式）',
    '  --update              升级到最新版本后退出（用于 cron/脚本自动化升级）',
    '  --advance-help        高级配置参考：config.yaml 全部高级字段的语义与改法（面向 coding agent）',
    '  -h, --help            显示本帮助信息',
    '  -v, --version         显示版本号',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Print advanced-config reference to stdout (CLI `--advance-help`).
 *
 * 目标读者是 coding agent（用户让 agent 代改 config.yaml）：披露所有
 * /config 卡片未暴露的 YAML 字段——名称、默认值、语义、改法。飞书侧
 * 等价命令为 /advancehelp（内容同源，卡片渲染）。
 */
export function printAdvanceHelp(): void {
  const configDir = resolveConfigDir(parseCliArgs().configDir);
  const configPath = configDir + '/config.yaml';
  const lines = [
    'lark-remote 高级配置参考（--advance-help）',
    '',
    '目标读者：coding agent。用户把本输出交给 agent，agent 据此代改配置。',
    '',
    '配置文件：' + configPath,
    '',
    '修改方式（三选一）：',
    '  1. 直接编辑上面的 config.yaml，改完由用户发送 /restart 生效',
    '  2. 用户发送 /config <key> <value> 文本直写（立盘即生效），',
    '     如 /config claude.approvalTimeoutMs 300000',
    '  3. 常用项走 /config 卡片交互（模型/审批档位/超时等已暴露，不在此列）',
    '',
    'Key 映射规则：pi./codex./opencode./kimi./dsh. 开头自动映射到 agents.<agent>.<字段>；',
    'claude. 开头在顶层；其余原样。',
    '',
    'Claude（顶层 claude.*）：',
    '  approvalTimeoutMs     (默认 300000)  审批请求超时(ms)，超时自动 cancel；0=立即过期；勿随意改短',
    '  idleTtlMinutes        (默认 30)      会话空闲回收(分钟)，turn 间无新消息超窗回收长驻进程；0=不回收',
    '  stopGraceMs           (默认 5000)    SIGTERM→SIGKILL 宽限(ms)，内部实现细节，勿改',
    '',
    'Codex（agents.codex.appServer.*）：',
    '  binary                (默认 codex)     codex 二进制路径',
    '  requestTimeoutMs      (默认 60000)     单次 RPC 请求超时(ms)，0=不超时',
    '  idleTtlMs             (默认 1800000)   连接空闲回收(ms)，0=不回收',
    '  turnIdleTimeoutMinutes(默认 30)        turn 无输出超时(分钟)，0=关闭（卡片也可改）',
    '',
    'Kimi（agents.kimi.acp.*）：',
    '  binary                (默认 kimi)      kimi 二进制路径',
    '  requestTimeoutMs      (默认 60000)     单次请求超时(ms)，0=不超时',
    '  idleTtlMs             (默认 1800000)   连接空闲回收(ms)，0=不回收',
    '  turnIdleTimeoutMinutes(默认 30)        turn 无输出超时(分钟)，0=关闭（卡片也可改）',
    '',
    'OpenCode（agents.opencode.acp.*）：',
    '  binary                (默认 opencode)  opencode 二进制路径',
    '  requestTimeoutMs      (默认 60000)     单次请求超时(ms)，0=不超时',
    '  idleTtlMs             (默认 1800000)   连接空闲回收(ms)，0=不回收',
    '  turnIdleTimeoutMinutes(默认 30)        turn 无输出超时(分钟)，0=关闭（卡片也可改）',
    '',
    'Pi：',
    '  agents.pi.tools       (默认 read,bash,edit,write,grep,find,ls) 逗号分隔工具白名单',
    '',
    '入站媒体（inboundMedia.*）：',
    '  enabled               (默认 true)              图片/文件落盘开关',
    '  dirName               (默认 .lark-remote-temp) 落盘目录名（位于当前 cwd 下）',
    '  maxFileSizeMb         (默认 100)               单文件上限(MiB)；飞书 >100MB 需分片，实际不可用更大值',
    '',
    '其他：',
    '  checkUpdateOnStartup  (默认 false)   启动时检查更新',
    '',
    '字段全集与校验规则见 Zod schema（src/config/index.ts，代码内唯一事实源）。',
    '直接改 YAML 后必须 /restart；/config 文本直写与卡片保存即时生效。',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}
