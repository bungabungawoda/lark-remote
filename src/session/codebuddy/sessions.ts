/**
 * CodeBuddy 会话读取内核：`~/.codebuddy/projects/<cwd编码>/<sessionId>.jsonl`。
 *
 * 行格式是 opencode 风格而非 Claude 风格（真实会话样本验证）：
 *   {id, parentId, timestamp(纪元毫秒), type:"message", role:"user"|"assistant",
 *    content:[{type:"input_text"|"output_text", text}], providerData, sessionId,
 *    cwd}
 * 另有 `turn-metrics` / `summary` / `file-history-snapshot` 等行；子 agent 记录
 * 在同名无扩展名目录 `<sessionId>/subagents/`（只读 *.jsonl 顶层文件即天然
 * 排除，子 agent 用量不进主时间线）。
 *
 * 与 claude 的项目目录编码不同：无前导 `-`、保留 `_`（`disk_d` 不变）、
 * `/`→`-`。编码有损（`/`→`-` 是 N-to-1），因此定位到的文件必须用行内 `cwd`
 * 字段校验归属（同 claude 的回归教训：/resume & /cd 路径错乱）。
 *
 * 用量：jsonl 只在每个 turn 的最后一条 assistant 消息上落 usage（`requests: 1`），
 * 中间模型请求没有采样；reader 优先用 CodeBuddy 的逐请求日志（`usage-log.ts`）
 * 重建 flow/cumulative，日志缺失时才回退 jsonl（末次请求，口径是下界）。
 *
 * 待真机验证（fixture 固化后收敛）：
 * - jsonl 兜底路径的 assistant 行 usage 字段名（读取按多候选 key 归一化，双 casing 都接受）；
 * - turn-metrics 行的窗口水位字段（v1 不依赖，contextLength 用统一占用口径）；
 * - 工具调用行形状（样本未含工具行；tail 装配对未知行类型一律跳过）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileContainsCwd, findJsonlLine } from '../common/jsonl.js';
import { isStale } from '../common/constants.js';
import { capEvents } from '../common/pagination.js';
import { throwSessionListError } from '../common/throw-session-list-error.js';
import { getLogger } from '../../logger/index.js';
import type {
  AgentSession,
  AgentSessionContentEvent,
  AgentSessionUsage,
} from '../../session-contract.js';
import { resolveCodebuddyConfigDir } from '../../config/codebuddy-config.js';
import {
  addCodebuddyUsageSample,
  emptyCodebuddyUsageSample,
  readCodebuddyLogUsage,
  type CodebuddyLogUsage,
  type CodebuddyUsageSample,
} from './usage-log.js';

export interface CodebuddyReaderOptions {
  /** CodeBuddy 配置根目录；缺省 `~/.codebuddy`。 */
  configDir?: string;
}

export function codebuddyProjectsDir(configDir?: string): string {
  return path.join(resolveCodebuddyConfigDir(configDir), 'projects');
}

/**
 * CodeBuddy 的项目目录编码：去前导分隔符、`/`→`-`、`.`→`-`、保留 `_`
 * （`/home/user/my-project` → `home-user-my-project`；
 * `/home/user/my_project.v2` → `home-user-my_project-v2`）。win32 路径把 `\` 与 `:`
 * 一并归一为 `-`（防非法文件名字符）。
 */
export function encodeCodebuddyProjectDirName(cwd: string): string {
  const isWinPath = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\');
  const stripped = cwd.replace(/^[/\\]+/, '');
  return stripped.replace(isWinPath ? /[/\\:]/g : /\//g, '-').replace(/\./g, '-');
}

function projectDirForCwd(cwd: string, configDir?: string): string {
  return path.join(codebuddyProjectsDir(configDir), encodeCodebuddyProjectDirName(cwd));
}

/** content[] 里 input_text 优先于 output_text，取首个非空 text。 */
export function textFromContent(content: unknown[]): string | undefined {
  for (const wantType of ['input_text', 'output_text']) {
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type === wantType && typeof p.text === 'string' && p.text) return p.text;
    }
  }
  return undefined;
}

/** 从一行（已 parse）取可展示文本：summary/text 优先，再回退 content[]。 */
function textFromRow(row: Record<string, unknown>): string | undefined {
  if (typeof row.summary === 'string' && row.summary) return row.summary;
  if (typeof row.text === 'string' && row.text) return row.text;
  const content = row.content;
  if (!Array.isArray(content)) return undefined;
  return textFromContent(content);
}

function isUserMessageRow(row: Record<string, unknown>): boolean {
  return row.type === 'message' && row.role === 'user';
}

/** 摘要行文本优先（早停扫描）；拿不到可用文本返回 undefined 交给 user 兜底。 */
export function findSummaryText(filePath: string): string | undefined {
  const summaryLine = findJsonlLine(filePath, (l) => {
    try {
      return (JSON.parse(l) as { type?: unknown }).type === 'summary';
    } catch {
      return false;
    }
  });
  if (!summaryLine) return undefined;
  try {
    const text = textFromRow(JSON.parse(summaryLine) as Record<string, unknown>);
    if (text) return text;
  } catch {
    // 摘要行解析失败 → 交给调用方回退到真人 user 文本
  }
  return undefined;
}

/** 回退首个真人 user 文本（早停扫描）；无则空串。 */
export function findFirstUserText(filePath: string): string {
  const userLine = findJsonlLine(filePath, (l) => {
    try {
      const row = JSON.parse(l) as Record<string, unknown>;
      return isUserMessageRow(row) && textFromRow(row) !== undefined;
    } catch {
      return false;
    }
  });
  if (!userLine) return '';
  try {
    return textFromRow(JSON.parse(userLine) as Record<string, unknown>) ?? '';
  } catch {
    return '';
  }
}

/** 列表摘要：summary 行文本优先，回退首个真人 user 文本（各自早停扫描）。 */
function extractSummaryLine(filePath: string): string {
  return findSummaryText(filePath) ?? findFirstUserText(filePath);
}

/**
 * 扫描编码目录：readdir + stat + 逐文件 cwd 归属校验，产出未排序会话列表。
 * 目录 ENOENT 按空态返回 []；stat ENOENT（条目竞态消失）跳过该条目，其余
 * errno 分别 throwSessionListError / debug 留痕。dir/cwd 入参、AgentSession[]
 * 出参明确，便于 fixture 直测。
 */
export function collectSessionEntries(dir: string, cwd: string): AgentSession[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throwSessionListError('codebuddy', err);
    }
    return [];
  }

  const sessions: AgentSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch (err) {
      // stat 失败：ENOENT = 两次查询之间消失（正常竞态）；其余 errno 留痕。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLogger().debug(
          `[codebuddy-session-reader] stat ${filePath} failed: ${(err as Error).message}`,
        );
      }
      continue;
    }
    // 编码有损：逐文件 cwd 校验（早停扫描），归属不符的文件不进列表。
    if (!fileContainsCwd(filePath, cwd)) continue;
    sessions.push({
      sessionId: entry.slice(0, -'.jsonl'.length),
      summary: extractSummaryLine(filePath),
      mtime: mtimeMs,
    });
  }
  return sessions;
}

/**
 * List CodeBuddy sessions for a cwd, newest first. 只列编码目录下的 *.jsonl
 * 顶层文件（子 agent 目录 `<sessionId>/` 天然排除）。不传 limit 返回全集
 * （claude 同款契约：total 由 reader 用全集长度算）。
 */
export function listCodebuddySessions(
  cwd: string,
  opts: { limit?: number; configDir?: string } = {},
): AgentSession[] {
  const dir = projectDirForCwd(cwd, opts.configDir);
  const sessions = collectSessionEntries(dir, cwd);
  sessions.sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId));
  return opts.limit === undefined ? sessions : sessions.slice(0, opts.limit);
}

export function getNewestCodebuddySession(
  cwd: string,
  opts: { configDir?: string } = {},
): AgentSession | undefined {
  const sessions = listCodebuddySessions(cwd, { limit: 1, configDir: opts.configDir });
  return sessions[0];
}

// =============================================================================
// readSessionContent：单遍扫描（usage + turn 边界 + tail 装配）
// =============================================================================

export type { CodebuddyUsageSample } from './usage-log.js';

/** usage 字段多候选 key（wire 未验证，casing/命名双口径都接）。 */
function pickNumber(row: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function normalizeUsage(raw: unknown): CodebuddyUsageSample | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  // 真机 2.142.0 实测：usage 是 camelCase 且 `inputTokens` **含缓存**
  // （cached_tokens 只在 `inputTokensDetails[]` 里）。按「未命中缓存的输入
  // 才算 input」（§9.21 口径）：有明细时 input 扣掉缓存、cacheRead 取明细；
  // 无明细时不做减法（cacheRead 记 0，input 原样——宁可高报上下文水位，
  // 不把同一批 token 在 input 与 cacheRead 里双计）。
  const cached = cachedTokensFromDetails(rec);
  const inputRaw = pickNumber(rec, ['input_tokens', 'inputTokens', 'input']);
  const cacheRead =
    cached > 0
      ? cached
      : pickNumber(rec, [
          'cache_read_input_tokens',
          'cache_read_tokens',
          'cacheReadTokens',
          'cacheRead',
        ]);
  const sample: CodebuddyUsageSample = {
    input: cached > 0 ? Math.max(0, inputRaw - cached) : inputRaw,
    output: pickNumber(rec, ['output_tokens', 'outputTokens', 'output']),
    cacheRead,
    cacheCreation: pickNumber(rec, [
      'cache_creation_input_tokens',
      'cache_creation_tokens',
      'cacheCreationTokens',
      'cacheCreation',
    ]),
  };
  const total = sample.input + sample.output + sample.cacheRead + sample.cacheCreation;
  if (total === 0) return undefined;
  return sample;
}

/** `inputTokensDetails[]` / `input_tokens_details[]` 里的 cached_tokens 求和。 */
function cachedTokensFromDetails(rec: Record<string, unknown>): number {
  for (const key of ['inputTokensDetails', 'input_tokens_details']) {
    const details = rec[key];
    if (!Array.isArray(details)) continue;
    let sum = 0;
    for (const item of details) {
      const cached = (item as { cached_tokens?: unknown } | null)?.cached_tokens;
      if (typeof cached === 'number' && Number.isFinite(cached)) sum += cached;
    }
    if (sum > 0) return sum;
  }
  return 0;
}

/** assistant 行的 usage 位置：`row.usage` 或 `row.providerData.usage`。 */
function usageOfRow(row: Record<string, unknown>): CodebuddyUsageSample | undefined {
  const direct = normalizeUsage(row.usage);
  if (direct) return direct;
  const providerData = row.providerData;
  if (providerData && typeof providerData === 'object') {
    return normalizeUsage((providerData as Record<string, unknown>).usage);
  }
  return undefined;
}

/** 是否是真人发起新 turn 的 user 行（工具结果/注入类不算）。 */
function isRealUserRow(row: Record<string, unknown>): boolean {
  if (!isUserMessageRow(row)) return false;
  const providerData = row.providerData;
  if (providerData && typeof providerData === 'object') {
    const pd = providerData as Record<string, unknown>;
    if (pd.skipRun === true || pd.isMeta === true) return false;
    // autocompact 后的约束注入（真机取证：providerData={agent:'compact',
    // startsNewUserRequest:true}，不带 skipRun）——不是真人输入；不排除会把
    // 压缩点误判成 turn 边界，末 turn flow 错位。
    if (pd.agent === 'compact') return false;
  }
  const content = row.content;
  if (!Array.isArray(content)) return false;
  // 真人输入 = 有 input_text part；无 input_text 的 user 行（纯工具结果等）
  // 不开新 turn。
  return content.some((part) => (part as { type?: unknown } | null)?.type === 'input_text');
}

interface CodebuddyScan {
  /** 本 run flow：末个真人 turn 内采样求和（无真人 turn 时回退末条采样）。 */
  turn: CodebuddyUsageSample;
  /** 全会话累计。 */
  cum: CodebuddyUsageSample;
  /** 末条采样（contextLength 水位来源）。 */
  latest: CodebuddyUsageSample | undefined;
  /** 末个真人 user 行的行号（tail 起点）；无 → -1。 */
  tailStart: number;
  /** tail 内首条真人 user 文本（displayTitle 次选）。 */
  tailTitle: string | undefined;
  /** 全会话首条真人 user 文本（displayTitle 兜底）。 */
  firstTitle: string | undefined;
  /** ai-title 行文本（真机形状 {type:'ai-title', aiTitle}；displayTitle 首选）。 */
  aiTitle: string | undefined;
}

/** scanRows 逐行累积的标题状态（纯数据，供 collectRowTitle 直测）。 */
export interface CodebuddyTitleState {
  tailTitle: string | undefined;
  firstTitle: string | undefined;
  aiTitle: string | undefined;
}

/**
 * 单行标题采集：真人 user 行覆盖 tailTitle 并记首条 firstTitle；非真人
 * user 行在尚无 firstTitle 时兜底；ai-title 行取最后一条。turn 边界
 * tailStart 由主循环按同一 isRealUserRow 判定记录，不在这里改。
 */
export function collectRowTitle(row: Record<string, unknown>, state: CodebuddyTitleState): void {
  if (isRealUserRow(row)) {
    const text = textFromRow(row);
    // tail 从末条真人 user 行开始，「tail 内首条 user 文本」= 末条真人
    // user 行的文本（逐条覆盖，attachment-only 的空行不顶掉前值）。
    if (text) state.tailTitle = text;
    if (text && !state.firstTitle) state.firstTitle = text;
  } else if (!state.firstTitle && isUserMessageRow(row)) {
    const text = textFromRow(row);
    if (text) state.firstTitle = text;
  }
  if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle) {
    state.aiTitle = row.aiTitle; // 最后一条生效（claude 同口径）
  }
}

/**
 * 末 turn 汇总：flow = 末个真人 turn 内采样之和；无真人 turn（旧数据/截断
 * 文件）无法划分 turn，回退末条采样（与 claude/codex「无 turn 标记退回末条」
 * 一致），不把整份文件当成一轮。
 */
export function summarizeTurnFlow(
  samples: Array<{ turn: number; sample: CodebuddyUsageSample }>,
  tailStart: number,
  latest: CodebuddyUsageSample | undefined,
): CodebuddyUsageSample {
  const turn = emptyCodebuddyUsageSample();
  if (tailStart >= 0) {
    for (const { turn: turnOf, sample } of samples) {
      if (turnOf === tailStart) addCodebuddyUsageSample(turn, sample);
    }
  } else if (latest) {
    Object.assign(turn, latest);
  }
  return turn;
}

/**
 * 单遍扫描：主循环只做分类分发与采样归属——真人 user 行记录 tail 位置、
 * assistant 采样按其前最近的真人 user 行号归属 turn（行序即时间序）；
 * 标题采集交给 collectRowTitle，扫完后的末 turn 汇总交给
 * summarizeTurnFlow（flow = 末个真人 turn 内采样之和，多步 run 低报防线，
 * §9.21；cumulative = 全部采样之和，子 agent 文件不读，天然不混入）。
 */
function scanRows(rows: Record<string, unknown>[]): CodebuddyScan {
  const cum = emptyCodebuddyUsageSample();
  let latest: CodebuddyUsageSample | undefined;
  let tailStart = -1;
  const titleState: CodebuddyTitleState = {
    tailTitle: undefined,
    firstTitle: undefined,
    aiTitle: undefined,
  };
  /** 每条采样归属的真人 turn（其前最近真人 user 行号；尚无 → -1）。 */
  const samples: Array<{ turn: number; sample: CodebuddyUsageSample }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    // 分类分发：assistant 行采样，按其前最近真人 user 行号归属 turn。
    if (row.type === 'message' && row.role === 'assistant') {
      const sample = usageOfRow(row);
      if (sample) {
        addCodebuddyUsageSample(cum, sample);
        samples.push({ turn: tailStart, sample });
        latest = sample;
      }
    }
    // 分类分发：真人 user 行标记 turn 边界（采样归属基准）。autocompact
    // 注入行 isRealUserRow=false，不切边界（§9.21 回归锚）。
    if (isRealUserRow(row)) {
      tailStart = i;
    }
    // 标题采集（tailTitle/firstTitle/aiTitle）交给纯函数。
    collectRowTitle(row, titleState);
  }

  const turn = summarizeTurnFlow(samples, tailStart, latest);

  return {
    turn,
    cum,
    latest,
    tailStart,
    tailTitle: titleState.tailTitle,
    firstTitle: titleState.firstTitle,
    aiTitle: titleState.aiTitle,
  };
}

/**
 * 组装 `AgentSessionUsage`。调用方决定 flow/cumulative/latest 的数据源：
 * 逐请求日志可用时用日志，否则回退 jsonl 的末次请求采样。
 */
function usageToSessionUsage(
  turn: CodebuddyUsageSample,
  cum: CodebuddyUsageSample,
  latest: CodebuddyUsageSample | undefined,
): AgentSessionUsage | undefined {
  const cumTotal = cum.input + cum.output + cum.cacheRead + cum.cacheCreation;
  if (cumTotal === 0) return undefined;
  return {
    inputTokens: turn.input,
    outputTokens: turn.output,
    // 统一占用口径：末条采样的 input+output+cache（水位不求和，含末轮 output）。
    contextLength: latest
      ? latest.input + latest.output + latest.cacheRead + latest.cacheCreation
      : 0,
    cacheReadTokens: turn.cacheRead > 0 ? turn.cacheRead : undefined,
    cacheCreationTokens: turn.cacheCreation > 0 ? turn.cacheCreation : undefined,
    totalTokens: turn.input + turn.output + turn.cacheRead + turn.cacheCreation,
    cumulativeTotalTokens: cumTotal,
    cumulativeInputTokens: cum.input,
    cumulativeOutputTokens: cum.output,
    cumulativeCacheReadTokens: cum.cacheRead,
    cumulativeCacheCreationTokens: cum.cacheCreation,
  };
}

/** 日志缺失时的兜底：jsonl 每个 turn 只有末次请求一条采样。 */
function usageFromJsonl(scan: CodebuddyScan): AgentSessionUsage | undefined {
  return usageToSessionUsage(scan.turn, scan.cum, scan.latest);
}

function usageFromLog(logUsage: CodebuddyLogUsage): AgentSessionUsage | undefined {
  return usageToSessionUsage(logUsage.turn, logUsage.cum, logUsage.latest);
}

/** tail 行 → 展示事件（user/assistant 文本同 text 通道；未知行类型跳过）。 */
function assembleTailEvents(
  rows: Record<string, unknown>[],
  startIndex: number,
): AgentSessionContentEvent[] {
  const events: AgentSessionContentEvent[] = [];
  for (let i = Math.max(startIndex, 0); i < rows.length; i++) {
    const row = rows[i]!;
    if (row.type !== 'message') continue;
    const timestamp =
      typeof row.timestamp === 'number' ? new Date(row.timestamp).toISOString() : undefined;
    const text = textFromRow(row);
    if (!text) continue;
    events.push({ type: 'text', content: text, timestamp });
  }
  return events;
}

export function readCodebuddySessionContent(
  sessionId: string,
  cwd: string,
  opts: { maxEvents?: number; configDir?: string } = {},
): {
  events: AgentSessionContentEvent[];
  usage?: AgentSessionUsage;
  aiTitle?: string;
  displayTitle?: string;
} {
  // sessionId 来自用户 /resume 输入：净化防路径穿越（同 opencode reader 的
  // path.basename 口径）。
  const safeId = path.basename(sessionId);
  const filePath = path.join(projectDirForCwd(cwd, opts.configDir), `${safeId}.jsonl`);
  if (!fs.existsSync(filePath)) return { events: [] };
  if (!fileContainsCwd(filePath, cwd)) return { events: [] };

  const rows: Record<string, unknown>[] = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // 跳过损坏行（半写入的尾行）
      }
    }
  } catch (err) {
    getLogger().warn(
      `[codebuddy-session-reader] read ${filePath} failed: ${(err as Error).message}`,
    );
    return { events: [] };
  }

  const scan = scanRows(rows);
  // 逐请求日志优先：jsonl 每 turn 只落最后一条 assistant 的 usage，
  // 求和仍等于末次请求；日志缺失/清理时才回退（数字是下界）。
  const logUsage = readCodebuddyLogUsage(sessionId, cwd, { configDir: opts.configDir });
  // tail = 末条真人 user 之后的行（不含该行，claude 的 tailOffset 同语义）；
  // 无真人 user 行时退回整个文件（空态兜底）。
  const startIndex = scan.tailStart >= 0 ? scan.tailStart + 1 : 0;
  return {
    events: capEvents(assembleTailEvents(rows, startIndex), opts.maxEvents),
    usage: logUsage ? usageFromLog(logUsage) : usageFromJsonl(scan),
    aiTitle: scan.aiTitle,
    displayTitle: scan.aiTitle ?? scan.tailTitle ?? scan.firstTitle,
  };
}

export function isCodebuddySessionActive(
  sessionId: string,
  cwd: string,
  opts: { configDir?: string; now?: number } = {},
): boolean {
  const safeId = path.basename(sessionId);
  const filePath = path.join(projectDirForCwd(cwd, opts.configDir), `${safeId}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return false;
  }
  if (!fileContainsCwd(filePath, cwd)) return false;
  // 文件侧证据只有 mtime 新鲜度（codebuddy 的行格式未观察到终态标记行；
  // 与 opencode/kimi 同口径，拿它当「最近有写入」而非「turn 在跑」）。
  return !isStale(mtimeMs, opts.now);
}
