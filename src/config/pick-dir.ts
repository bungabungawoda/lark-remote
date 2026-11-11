/**
 * 启动时交互选择配置目录（`lark-remote -c`）。
 *
 * 由来：同机多实例时 --config-dir 的路径记不住。裸 `-c` 列出本机候选目录，
 * 并显示目录里飞书应用的名字（见 bot-info.ts），上下键选中后按原流程启动。
 *
 * 候选范围（明确写死，避免“全盘扫描”）：
 *   ~/.lark-remote  以及 $HOME 下所有 .lark-remote* 且含 config.yaml 的目录。
 * 选择器只做选择：不抢单例锁、不写 config、不启动任何进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import YAML from 'yaml';
import { AppConfigSchema } from './index.js';
import { isDirectoryPath } from '../common/fs.js';
import { resolveBotNames, type BotInfoHttp, type BotNameSource } from './bot-info.js';
import {
  displayWidth,
  truncateMiddleToDisplayWidth,
  truncateToDisplayWidth,
} from '../common/text-width.js';

export interface ConfigDirCandidate {
  /** 绝对路径（真实路径用于去重，显示仍用用户可见路径）。 */
  dir: string;
  /** `~` 缩写后的显示路径。 */
  displayPath: string;
  appId?: string;
  appName?: string;
  nameSource: BotNameSource;
  running: boolean;
  /** config.yaml 不满足启动校验（选中后会在启动时报错）。 */
  configInvalid: boolean;
  /** 缺 feishu.appId/appSecret（选中后进入扫码向导）。 */
  missingCredentials: boolean;
}

interface ConfigDirEntry {
  dir: string;
  displayPath: string;
  appId?: string;
  appSecret?: string;
  configInvalid: boolean;
  missingCredentials: boolean;
}

interface ListCandidatesOptions {
  home?: string;
  now?: number;
  http?: BotInfoHttp;
  timeoutMs?: number;
  /** false = 名字只读缓存，不联网（非交互场景）。 */
  remoteNames?: boolean;
  /** 只读探测 pid 是否存活（测试注入）。 */
  isPidAlive?: (pid: number) => boolean;
  /** 确实需要联网取名字时回调一次。 */
  onFetchStart?: (pending: number) => void;
}

const CONFIG_FILE = 'config.yaml';
const PID_FILE = 'lark-remote.pid';
const DIR_PREFIX = '.lark-remote';

function hasConfigFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, CONFIG_FILE)).isFile();
  } catch {
    return false;
  }
}

function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** `$HOME/...` → `~/...`；不在 home 下则原样返回。 */
export function shortenHome(dir: string, home: string): string {
  if (dir === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return dir.startsWith(prefix) ? `~${path.sep}${dir.slice(prefix.length)}` : dir;
}

interface ConfigProbe {
  appId?: string;
  appSecret?: string;
  configInvalid: boolean;
  missingCredentials: boolean;
}

interface ConfigDocument {
  ok: boolean;
  parsed?: unknown;
}

function readConfigDocument(dir: string): ConfigDocument {
  try {
    return { ok: true, parsed: YAML.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf-8')) };
  } catch {
    return { ok: false };
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function credentialsOf(parsed: unknown): Pick<ConfigProbe, 'appId' | 'appSecret'> {
  const feishu = (parsed as { feishu?: unknown } | null)?.feishu as
    { appId?: unknown; appSecret?: unknown } | undefined;
  return { appId: nonEmptyString(feishu?.appId), appSecret: nonEmptyString(feishu?.appSecret) };
}

function probeConfig(dir: string): ConfigProbe {
  const doc = readConfigDocument(dir);
  if (!doc.ok) return { configInvalid: true, missingCredentials: true };
  const credentials = credentialsOf(doc.parsed);
  return {
    ...credentials,
    configInvalid: !AppConfigSchema.safeParse(doc.parsed).success,
    missingCredentials: !(credentials.appId && credentials.appSecret),
  };
}

/** 只读探测配置目录归属的实例是否在跑；仅用于展示，不参与任何决策。 */
function readRunningPid(dir: string): number | undefined {
  try {
    const firstLine = fs.readFileSync(path.join(dir, PID_FILE), 'utf-8').split('\n')[0]?.trim();
    const pid = Number(firstLine);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但当前用户无权发信号。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 扫描候选目录。默认目录固定排第一，其余按路径字典序；按 realpath 去重
 * （clone 的目录可能是软链）。
 */
function addConfigDir(byRealpath: Map<string, string>, dir: string): void {
  if (!hasConfigFile(dir)) return;
  const real = realpathOrSelf(dir);
  if (!byRealpath.has(real)) byRealpath.set(real, dir);
}

function siblingConfigDirs(home: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name.startsWith(DIR_PREFIX))
    .map((entry) => path.join(home, entry.name))
    .filter(isDirectoryPath);
}

function sortConfigDirs(dirs: string[], defaultDir: string): string[] {
  return [...dirs].sort((a, b) => {
    if (a === defaultDir) return -1;
    if (b === defaultDir) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function scanConfigDirs(home: string): ConfigDirEntry[] {
  const defaultDir = path.join(home, DIR_PREFIX);
  const byRealpath = new Map<string, string>();
  addConfigDir(byRealpath, defaultDir);
  for (const dir of siblingConfigDirs(home)) addConfigDir(byRealpath, dir);

  return sortConfigDirs([...byRealpath.values()], defaultDir).map((dir) => ({
    dir,
    displayPath: shortenHome(dir, home),
    ...probeConfig(dir),
  }));
}

/** 列候选并补齐应用名。返回顺序即选择器展示顺序。 */
export async function listConfigDirCandidates(
  opts: ListCandidatesOptions = {},
): Promise<ConfigDirCandidate[]> {
  const home = opts.home ?? os.homedir();
  const entries = scanConfigDirs(home);
  const targets = entries
    .filter((entry): entry is ConfigDirEntry & { appId: string; appSecret: string } =>
      Boolean(entry.appId && entry.appSecret),
    )
    .map((entry) => ({ dir: entry.dir, appId: entry.appId, appSecret: entry.appSecret }));

  const names =
    targets.length > 0
      ? await resolveBotNames(targets, {
          now: opts.now,
          http: opts.http,
          timeoutMs: opts.timeoutMs,
          remote: opts.remoteNames !== false,
          onStart: opts.onFetchStart,
        })
      : new Map();

  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  return entries.map((entry) => {
    const pid = readRunningPid(entry.dir);
    const name = names.get(entry.dir);
    return {
      dir: entry.dir,
      displayPath: entry.displayPath,
      appId: entry.appId,
      appName: name?.appName,
      nameSource: name?.source ?? 'none',
      running: pid !== undefined && isPidAlive(pid),
      configInvalid: entry.configInvalid,
      missingCredentials: entry.missingCredentials,
    };
  });
}

/**
 * 名字的展示口径：真实应用名 → appId 尾号 → 未配置。
 * 选择器行、选中回执、非 TTY 表格共用，避免三处各写一份。
 */
export function candidateAppLabel(item: ConfigDirCandidate): string {
  if (item.appName) return `飞书：${item.appName}`;
  if (item.appId) return `飞书：appId …${item.appId.slice(-6)}`;
  return '飞书：未配置';
}

interface PickerKey {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

type PickerAction = 'continue' | 'confirm' | 'cancel' | 'interrupt';

interface PickerState {
  index: number;
}

interface PickerKeyResult extends PickerState {
  action: PickerAction;
}

type PickerIntent = 'up' | 'down' | 'confirm' | 'cancel' | 'interrupt' | 'digit' | 'other';

interface PickerIntentResult {
  intent: PickerIntent;
  digit?: number;
}

const NAME_INTENTS = new Map<string, PickerIntent>([
  ['up', 'up'],
  ['down', 'down'],
  ['return', 'confirm'],
  ['enter', 'confirm'],
  ['escape', 'cancel'],
]);

const INTENT_ACTIONS: Partial<Record<PickerIntent, PickerAction>> = {
  confirm: 'confirm',
  cancel: 'cancel',
  interrupt: 'interrupt',
};

function isQuitKey(key: PickerKey): boolean {
  return key.sequence === 'q' || key.sequence === 'Q';
}

function digitOf(key: PickerKey): number {
  const sequence = key.sequence;
  if (sequence === undefined) return 0;
  return /^[1-9]$/.test(sequence) ? Number(sequence) : 0;
}

function pickerIntent(key: PickerKey): PickerIntentResult {
  if (key.ctrl && key.name === 'c') return { intent: 'interrupt' };
  const byName = key.name ? NAME_INTENTS.get(key.name) : undefined;
  if (byName !== undefined) return { intent: byName };
  if (isQuitKey(key)) return { intent: 'cancel' };
  const digit = digitOf(key);
  return digit > 0 ? { intent: 'digit', digit } : { intent: 'other' };
}

function pickerDigitResult(
  state: PickerState,
  digit: number | undefined,
  count: number,
): PickerKeyResult {
  const index = (digit ?? 0) - 1;
  if (index < 0 || index >= count) return { index: state.index, action: 'continue' };
  return { index, action: 'confirm' };
}

/**
 * 纯按键归约：↑/↓ 首尾循环，Enter 确认，Esc/q 取消，Ctrl+C 中断，1-9 直选。
 * 非法/未识别按键返回 continue，选择不变。
 */
export function applyPickerKey(state: PickerState, key: PickerKey, count: number): PickerKeyResult {
  if (count <= 0) return { index: 0, action: 'continue' };
  const { intent, digit } = pickerIntent(key);
  const delta = intent === 'up' ? -1 : intent === 'down' ? 1 : 0;
  if (delta !== 0) {
    return { index: (state.index + delta + count) % count, action: 'continue' };
  }
  if (intent === 'digit') return pickerDigitResult(state, digit, count);
  return { index: state.index, action: INTENT_ACTIONS[intent] ?? 'continue' };
}

interface RenderOptions {
  columns?: number;
  rows?: number;
  color?: boolean;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MID_SEPARATOR = '  ·  ';

/** 可见窗口：候选多于终端高度时围绕当前选择滚动（避免整屏重排）。 */
export function visibleWindow(
  count: number,
  index: number,
  maxItems: number,
): { start: number; end: number } {
  if (count <= maxItems) return { start: 0, end: count };
  const half = Math.floor(maxItems / 2);
  const start = Math.min(Math.max(index - half, 0), count - maxItems);
  return { start, end: start + maxItems };
}

function candidateRow(
  item: ConfigDirCandidate,
  opts: { columns: number; selected?: boolean; indexLabel?: string; color?: boolean },
): string {
  const { columns } = opts;
  const selected = opts.selected === true;
  const left = opts.indexLabel ? `  ${selected ? '❯' : ' '} ${opts.indexLabel}  ` : '  ';
  const tailParts = [item.running ? '● 运行中' : '○ 未运行'];
  if (item.configInvalid) tailParts.push('⚠ 配置无效');
  else if (item.missingCredentials) tailParts.push('⚠ 未配置凭据');
  const tail = `${MID_SEPARATOR}${tailParts.join('  ')}`;
  const name = candidateAppLabel(item);

  const fixedWidth = displayWidth(left) + displayWidth(MID_SEPARATOR) + displayWidth(tail);
  const available = columns - fixedWidth;
  let line: string;
  if (available < 24) {
    // 窄屏：名字列先让位，保住目录与状态。
    const pathWidth = Math.max(8, columns - displayWidth(left) - displayWidth(tail));
    line = `${left}${truncateMiddleToDisplayWidth(item.displayPath, pathWidth)}${tail}`;
  } else {
    const nameWidth = Math.min(Math.max(16, Math.floor(available * 0.4)), available - 10);
    const pathWidth = Math.max(10, available - nameWidth);
    line = `${left}${truncateMiddleToDisplayWidth(item.displayPath, pathWidth)}${MID_SEPARATOR}${truncateToDisplayWidth(name, nameWidth)}${tail}`;
  }
  // 最后一道保险：任何分支都不允许折行（折行会破坏逐帧重绘的行数计算）。
  const fitted = truncateToDisplayWidth(line, columns);
  return opts.color && selected ? `\x1b[36m${fitted}\x1b[0m` : fitted;
}

const HEADER_HINT = '↑/↓ 选择 · Enter 确认 · Esc 取消 · 1-9 直选';

/** 某些 pty（未设置 TIOCSWINSZ）会给出 columns=0：按 0 截断会让整帧变成 "…"。 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

export function renderPicker(
  items: ConfigDirCandidate[],
  index: number,
  opts: RenderOptions = {},
): string {
  const columns = positiveOr(opts.columns, DEFAULT_COLUMNS);
  const rows = positiveOr(opts.rows, DEFAULT_ROWS);
  const maxItems = Math.max(3, rows - 4);
  const { start, end } = visibleWindow(items.length, index, maxItems);
  const title = `? 选择 lark-remote 配置目录   ${HEADER_HINT}`;
  const lines = [truncateToDisplayWidth(title, columns), ''];
  for (let i = start; i < end; i++) {
    const item = items[i];
    if (!item) continue;
    lines.push(
      candidateRow(item, {
        columns,
        selected: i === index,
        indexLabel: `${i + 1}`,
        color: opts.color === true,
      }),
    );
  }
  return lines.join('\n');
}

/** 非 TTY（watchdog / cron / 管道）下的纯文本表格。 */
export function renderCandidateTable(
  items: ConfigDirCandidate[],
  opts: { columns?: number } = {},
): string {
  return items
    .map((item) =>
      candidateRow(item, { columns: positiveOr(opts.columns, DEFAULT_COLUMNS), selected: false }),
    )
    .join('\n');
}

export interface PickOutcome {
  kind: 'selected' | 'cancelled' | 'interrupted';
  item?: ConfigDirCandidate;
}

interface PickerIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * 终端交互选择。调用方保证 stdin/stdout 都是 TTY；非 TTY 分支由
 * applyConfigDirPick 负责（打印候选表 + exit 2，不在这里静默降级）。
 */
export function pickConfigDir(
  items: ConfigDirCandidate[],
  io: PickerIO = {},
): Promise<PickOutcome> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const view = new PickerView(output, pickerColor(output));
  return new Promise<PickOutcome>((resolve) => {
    new PickerSession(items, input, view, resolve).start();
  });
}

function pickerColor(output: NodeJS.WriteStream): boolean {
  return output.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

/** 逐帧重绘：清掉上一帧（行数由上一帧决定）再画新帧。 */
class PickerView {
  private paintedLines = 0;

  constructor(
    private readonly output: NodeJS.WriteStream,
    private readonly color: boolean,
  ) {}

  paint(items: ConfigDirCandidate[], index: number): void {
    const frame = renderPicker(items, index, {
      columns: this.output.columns,
      rows: this.output.rows,
      color: this.color,
    });
    const prefix = this.paintedLines > 0 ? `\x1b[${this.paintedLines}A\x1b[0J` : '';
    this.output.write(`${prefix}${frame}\n`);
    this.paintedLines = frame.split('\n').length;
  }

  clear(): void {
    if (this.paintedLines > 0) this.output.write(`\x1b[${this.paintedLines}A\x1b[0J`);
    this.paintedLines = 0;
  }

  cursor(visible: boolean): void {
    this.output.write(visible ? '\x1b[?25h' : '\x1b[?25l');
  }

  finish(outcome: PickOutcome): void {
    this.clear();
    this.cursor(true);
    const item = outcome.item;
    if (item) {
      this.output.write(`✔ 使用配置目录：${item.displayPath}（${candidateAppLabel(item)}）\n`);
      return;
    }
    this.output.write('已取消\n');
  }
}

/** 一次选择的完整生命周期（监听 → 归约 → 收尾），把 Promise 状态挡在类外面。 */
class PickerSession {
  private state: PickerState = { index: 0 };
  private settled = false;

  constructor(
    private readonly items: ConfigDirCandidate[],
    private readonly input: NodeJS.ReadStream,
    private readonly view: PickerView,
    private readonly resolve: (outcome: PickOutcome) => void,
  ) {}

  start(): void {
    readline.emitKeypressEvents(this.input);
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', this.handleKey);
    this.view.cursor(false);
    this.view.paint(this.items, this.state.index);
    // 终端被 Ctrl+C 以外的信号带走时也要把光标/raw mode 还原。
    if (this.input.isTTY) process.once('exit', this.restore);
  }

  private readonly restore = () => {
    if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(false);
    }
  };

  private readonly handleKey = (_str: string, key: readline.Key) => {
    const next = applyPickerKey(this.state, key, this.items.length);
    this.state = { index: next.index };
    if (next.action === 'confirm') {
      this.settle('selected');
      return;
    }
    if (next.action !== 'continue') {
      this.settle(next.action === 'cancel' ? 'cancelled' : 'interrupted');
      return;
    }
    this.view.paint(this.items, this.state.index);
  };

  private settle(kind: PickOutcome['kind']): void {
    if (this.settled) return;
    this.settled = true;
    this.input.off('keypress', this.handleKey);
    process.off('exit', this.restore);
    this.restore();
    this.input.pause();
    const item = kind === 'selected' ? this.items[this.state.index] : undefined;
    const outcome: PickOutcome = item ? { kind, item } : { kind };
    this.view.finish(outcome);
    this.resolve(outcome);
  }
}

interface ConfigDirPickCliArgs {
  configDir?: string;
  configDirPick?: boolean;
}

interface StdoutLike {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

interface ApplyConfigDirPickDeps {
  stdin?: { isTTY?: boolean };
  stdout?: StdoutLike;
  exit?: (code: number) => void;
  argv?: string[];
  list?: (opts: {
    remoteNames: boolean;
    onFetchStart: (pending: number) => void;
  }) => Promise<ConfigDirCandidate[]>;
  pick?: (items: ConfigDirCandidate[]) => Promise<PickOutcome>;
}

type ConfigDirArgForm = 'flag' | 'equals' | 'other';

function configDirArgForm(arg: string): ConfigDirArgForm {
  if (arg === '-c' || arg === '--config-dir') return 'flag';
  if (arg.startsWith('--config-dir=') || arg.startsWith('-c=')) return 'equals';
  return 'other';
}

function hasFollowingValue(argv: string[], index: number): boolean {
  const next = argv[index + 1];
  return next !== undefined && next.trim().length > 0 && !next.startsWith('-');
}

/**
 * 把命令行里所有 `-c` / `--config-dir` 形式替换成唯一的
 * `--config-dir <dir>`。重启（spawnReplacementBridge）复用 process.argv，
 * 不钉住的话子进程会在没有 TTY 的环境里再弹一次选择器。
 */
export function pinConfigDirArgv(argv: string[], configDir: string): string[] {
  const out: string[] = [];
  let inserted = false;

  for (let i = 0; i < argv.length; i++) {
    const form = configDirArgForm(argv[i]);
    if (form === 'other') {
      out.push(argv[i]);
      continue;
    }
    if (!inserted) {
      out.push('--config-dir', configDir);
      inserted = true;
    }
    if (form === 'flag' && hasFollowingValue(argv, i)) i++;
  }
  if (!inserted) out.push('--config-dir', configDir);
  return out;
}

function nonInteractiveMessage(items: ConfigDirCandidate[], columns: number): string {
  return [
    'Error: -c/--config-dir 需要显式路径（当前不是交互式终端，无法选择）',
    '可用的配置目录：',
    renderCandidateTable(items, { columns }),
    'Usage: lark-remote --config-dir <path>',
    '',
  ].join('\n');
}

type CandidateList = (opts: {
  remoteNames: boolean;
  onFetchStart: (pending: number) => void;
}) => Promise<ConfigDirCandidate[]>;

async function listWithProgress(
  deps: ApplyConfigDirPickDeps,
  stdout: StdoutLike,
  interactive: boolean,
): Promise<ConfigDirCandidate[]> {
  const list: CandidateList = deps.list ?? ((opts) => listConfigDirCandidates(opts));
  let announced = false;
  const items = await list({
    remoteNames: interactive,
    onFetchStart: (pending) => {
      if (!interactive) return;
      stdout.write(`正在读取飞书应用信息（${pending} 个目录）…\n`);
      announced = true;
    },
  });
  // 抹掉进度行再进全屏选择器，避免它被逐帧重绘留在列表上方。
  if (announced) stdout.write('\x1b[1A\x1b[0J');
  return items;
}

function reportNoCandidates(stdout: StdoutLike, exit: (code: number) => void): void {
  stdout.write(
    [
      'Error: 未发现可用的配置目录（~/.lark-remote*）',
      '先运行一次 lark-remote 创建默认配置，或用 --config-dir <path> 指定目录',
      'Usage: lark-remote --config-dir <path>',
      '',
    ].join('\n'),
  );
  exit(2);
}

function reportNonInteractive(
  stdout: StdoutLike,
  items: ConfigDirCandidate[],
  exit: (code: number) => void,
): void {
  stdout.write(nonInteractiveMessage(items, positiveOr(stdout.columns, DEFAULT_COLUMNS)));
  exit(2);
}

function applySelection(
  cliArgs: ConfigDirPickCliArgs,
  argv: string[],
  item: ConfigDirCandidate,
): void {
  cliArgs.configDir = item.dir;
  const pinned = pinConfigDirArgv(argv.slice(2), item.dir);
  argv.splice(2, Math.max(0, argv.length - 2), ...pinned);
}

function isInteractiveTerminal(stdin: { isTTY?: boolean }, stdout: { isTTY?: boolean }): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

function exitCodeFor(outcome: PickOutcome): number {
  return outcome.kind === 'interrupted' ? 130 : 1;
}

function finishPick(cliArgs: ConfigDirPickCliArgs, argv: string[], outcome: PickOutcome): boolean {
  if (outcome.kind !== 'selected' || !outcome.item) return false;
  applySelection(cliArgs, argv, outcome.item);
  return true;
}

interface PickContext {
  stdout: NonNullable<ApplyConfigDirPickDeps['stdout']>;
  exit: (code: number) => void;
  interactive: boolean;
}

function pickContext(deps: ApplyConfigDirPickDeps): PickContext {
  const stdout = deps.stdout ?? process.stdout;
  return {
    stdout,
    exit: deps.exit ?? ((code: number) => process.exit(code)),
    interactive: isInteractiveTerminal(deps.stdin ?? process.stdin, stdout),
  };
}

async function runPicker(
  deps: ApplyConfigDirPickDeps,
  items: ConfigDirCandidate[],
): Promise<PickOutcome> {
  const pick = deps.pick ?? ((candidates: ConfigDirCandidate[]) => pickConfigDir(candidates));
  return pick(items);
}

/**
 * 启动接线：仅当 `-c` 未带值且没有显式路径时执行。
 * 成功后写回 cliArgs.configDir 并钉住 process.argv。
 */
export async function applyConfigDirPick(
  cliArgs: ConfigDirPickCliArgs,
  deps: ApplyConfigDirPickDeps = {},
): Promise<void> {
  if (!cliArgs.configDirPick || cliArgs.configDir) return;

  const { stdout, exit, interactive } = pickContext(deps);
  const items = await listWithProgress(deps, stdout, interactive);
  if (items.length === 0) {
    reportNoCandidates(stdout, exit);
    return;
  }
  if (!interactive) {
    reportNonInteractive(stdout, items, exit);
    return;
  }

  const outcome = await runPicker(deps, items);
  if (finishPick(cliArgs, deps.argv ?? process.argv, outcome)) return;
  exit(exitCodeFor(outcome));
}
