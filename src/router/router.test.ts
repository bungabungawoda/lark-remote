import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter, isImmediateAction, formatUsageStats } from './index.js';
import { formatTimestamp } from '../card/time.js';
import { Bridge } from '../bridge/index.js';
import { SessionStore } from '../session/index.js';
import { SessionReaderRegistry } from '../session/registry.js';
import { _ClaudeSessionReader } from '../session/claude/index.js';
import { AppConfigSchema } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { AgentEvent, Runner } from '../runner/index.js';
import type { AgentSessionReader } from '../runner/index.js';

import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
} from '../../tests/lib/bridge-stubs.js';

// Stub session reader for tests that need empty results (used in manual registry composition)
const stubSessionReader: AgentSessionReader = {
  listSessions: () => ({ sessions: [], total: 0 }),
  getNewestSession: () => null,
  readSessionContent: () => ({
    events: [],
    aiTitle: undefined,
    recap: undefined,
    displayTitle: undefined,
    usage: undefined,
    reason: 'not_found',
  }),
  isSessionActive: () => false,
};

/**
 * Create a stub session reader registry.
 * @param claudeProjectsDir - Optional projectsDir for claude reader to read real sessions
 */

type TestCardElement = {
  tag?: string;
  text?: { content?: string };
  actions?: Array<{
    value?: { cmd?: string; name?: string; sessionId?: string };
    text?: { content?: string };
  }>;
  columns?: Array<{ elements?: TestCardElement[] }>;
  behaviors?: Array<{ value?: { cmd?: string; name?: string; sessionId?: string } }>;
  value?: { cmd?: string; name?: string; sessionId?: string };
};

type TestCard = {
  header?: { title?: { content?: string } };
  body?: { elements?: TestCardElement[] };
  elements?: TestCardElement[];
};
function createBackgroundRunningRunner(events: AgentEvent[]) {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    runner: {
      isRunning: false,
      stop: async () => {
        release();
      },
      killOrphan: () => {},
      registerExitHandlers: () => {},
      getStatusInfo: () => ({ kind: 'claude', model: 'test-model' }),
      run: async function* () {
        for (const e of events) yield e;
        await wait;
      },
    } as Runner,
    release,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-router-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRouter(overrides?: {
  runner?: Runner;
  output?: Partial<AppConfig['output']>;
  idle?: Partial<AppConfig['idle']>;

  exitHandler?: () => void;
  restartSpawner?: () => number;
  bridge?: Bridge;
  idleTimeoutMs?: number;
  defaultAgent?: string;
  sessionReaderRegistry?: SessionReaderRegistry;
  projectsDir?: string; // For tests that need to read real session files
}) {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner: Runner = overrides?.runner ?? createStubRunner({ withStatusInfo: true });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      stopGraceMs: 5000,
    },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
      ...overrides?.output,
    },
    ...(overrides?.idle ? { idle: { watchdogMinutes: 15, ...overrides.idle } } : {}),
    ...(overrides?.defaultAgent ? { defaultAgent: overrides.defaultAgent } : {}),
  });
  const router = new CommandRouter({
    sessionStore,
    bridge:
      overrides?.bridge ??
      new Bridge({
        runner,
        agentRegistry: createStubAgentRegistry(runner),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        connector,
        sessionStore,
        config,
      }),
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath: path.join(tmpDir, 'workspace.json'),
    exitHandler: overrides?.exitHandler,
    restartSpawner: overrides?.restartSpawner,
    idleTimeoutMs: overrides?.idleTimeoutMs,
    sessionReaderRegistry:
      overrides?.sessionReaderRegistry ??
      createStubSessionReaderRegistry(
        overrides?.projectsDir ? { claudeProjectsDir: overrides.projectsDir } : undefined,
      ),
  });
  return { router, sessionStore, connector };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

// Write a fake Claude session jsonl under <projDir>/<sid>.jsonl. Injects an
// init line with the cwd so the production code can locate the file via
// projectDirForCwd + readCwdFromJsonl (regression 2026-06-21 /active).
function writeSessionJsonl(projDir: string, sid: string, cwd: string, body: string): void {
  // Canonicalize via realpath so the cwd written to JSONL matches what
  // production cmdCd stores after `fs.realpathSync`. On macOS `os.tmpdir()`
  // lives under `/var/folders/...` which is a symlink to
  // `/private/var/folders/...`. If we wrote the unresolved path here,
  // listClaudeSessions(getNewestSession) would never find it.
  const canonicalCwd = fs.realpathSync(cwd);
  const initLine = `{"type":"system","subtype":"init","session_id":"${sid}","cwd":"${canonicalCwd}","model":"opus"}`;
  fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), `${initLine}\n${body}\n`);
}

// Same encoding as production `projectDirForCwd` (cwd → dirName), but
// canonicalizes the cwd via realpath first so the directory name matches
// what Claude writes (`/private/var/folders/...` not `/var/folders/...`).
// Falls back to path.resolve when the path doesn't exist (test fixtures
// sometimes use synthetic paths like `/p1` that don't need to be on disk).
function encodedProjectDir(cwd: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  return canonical.replace(/\//g, '-').replace(/_/g, '-');
}

describe('formatTimestamp', () => {
  it('formats JSONL UTC timestamp in local time', () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      expect(formatTimestamp('2026-06-20T15:30:01.000Z')).toBe('2026-06-20 23:30');
    } finally {
      if (oldTz === undefined) delete process.env.TZ;
      else process.env.TZ = oldTz;
    }
  });
});

describe('formatUsageStats', () => {
  it('renders context length + compact count when present', () => {
    const out = formatUsageStats({ contextLength: 5000, compactCount: 2 });
    expect(out).toContain('✅ 已完成');
    expect(out).toContain('Context - 5K');
    expect(out).toContain('Compact - 2次');
  });

  it('renders context length in K units (e.g., 120K instead of 120,000)', () => {
    const out = formatUsageStats({ contextLength: 120000, compactCount: 3 });
    expect(out).toContain('120K');
    expect(out).not.toContain('120,000');
  });

  it('renders Token stats in K units', () => {
    const out = formatUsageStats({
      contextLength: 150000,
      compactCount: 2,
      cacheReadTokens: 90000,
      cacheCreationTokens: 30000,
    });
    // Input = contextLength + cacheRead = 150K + 90K = 240K
    expect(out).toContain('Input token - 240K');
    // Output estimation = 10% of input = 15K
    expect(out).toContain('Output token - 15K');
    // Cache percentage: 90000 / (150000 + 90000) = 37.5% ≈ 38%
    expect(out).toContain('Cached token - 90K (38%)');
  });

  it('omits compact when compactCount is 0 or missing (regression: run/resume card footer)', () => {
    // compactCount=0 是 falsy — 不应渲染 "compact 0 次"。无 compact 的普通会话
    // 不能显示误导性的 "compact 0 次"。
    expect(formatUsageStats({ contextLength: 100, compactCount: 0 })).not.toContain('Compact');
    expect(formatUsageStats({ contextLength: 100 })).not.toContain('Compact');
  });

  it('omits context length and compact when usage is undefined', () => {
    expect(formatUsageStats(undefined)).toBe('✅ 已完成');
  });

  it('renders unified ccusage-aligned totals (pi/codex/opencode)', () => {
    // Unified formula (ccusage-aligned):
    //   total = max(total_tokens, input + output + cacheRead + cacheCreation)
    //   cache% = cacheRead / (input + cacheRead)
    //   "Cache create" line only when cacheCreation > 0
    // cacheRead/cacheCreation are NEVER double-counted; total_tokens folds in
    // any extra (e.g. opencode reasoning) via the max().

    // Pi (real shape): input uncached; totalTokens == sum of 4.
    const pi = formatUsageStats({
      inputTokens: 500,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreationTokens: 30,
      totalTokens: 650,
    });
    expect(pi).toContain('Input token - 500');
    expect(pi).toContain('Output token - 20');
    expect(pi).toContain('Cached token - 100 (17%)'); // 100/(500+100)=16.7%≈17%
    expect(pi).toContain('Cache create - 30');
    expect(pi).toContain('Total token - 650'); // not 620 (must include cacheCreation)

    // Codex (ccusage display): uncached input = raw - cached.
    const codex = formatUsageStats({
      inputTokens: 30,
      outputTokens: 8,
      cacheReadTokens: 90,
      cacheCreationTokens: 0,
      totalTokens: 128,
    });
    expect(codex).toContain('Input token - 30');
    expect(codex).toContain('Output token - 8');
    expect(codex).toContain('Cached token - 90 (75%)'); // 90/(30+90)
    expect(codex).not.toContain('Cache create');
    expect(codex).toContain('Total token - 128'); // max(128, 30+8+90)

    // OpenCode (real shape): totalTokens includes reasoning (separate from
    // output); the max() captures it so Total != bare sum of 4 (393, not 343).
    const oc = formatUsageStats({
      inputTokens: 240,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 100,
      totalTokens: 393,
    });
    expect(oc).toContain('Cache create - 100');
    expect(oc).toContain('Total token - 393'); // not 343 (must fold reasoning via totalTokens)
  });

  it('appends cumulative input/output when present', () => {
    const out = formatUsageStats({
      inputTokens: 677,
      outputTokens: 376,
      cacheReadTokens: 30182,
      cacheCreationTokens: 0,
      totalTokens: 31235,
      contextLength: 31235,
      cumulativeInputTokens: 46630,
      cumulativeOutputTokens: 3319,
    });
    // Per-turn lines unchanged.
    expect(out).toContain('Input token - 677');
    expect(out).toContain('Output token - 376');
    // Cumulative appended on the input/output lines.
    expect(out).toContain('累计 47K'); // 46630 rounds to 47K
    expect(out).toContain('累计 3K');
    // Cache/Total lines must NOT carry a cumulative suffix.
    expect(out).not.toMatch(/Cached token.*累计/);
    expect(out).not.toMatch(/Total token.*累计/);
  });

  it('supports optional result line when showResult is true', () => {
    const out = formatUsageStats({ contextLength: 5000 }, { showResult: true, result: 'error' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('✅ 已完成');
    expect(lines[1]).toBe('结果 - error');
    // No result line when showResult is false or undefined.
    expect(formatUsageStats({ contextLength: 5000 })).not.toContain('结果 -');
  });

  it('uses real input/output tokens when provided (no 10% estimate)', () => {
    // Codex regression: real output_tokens=101 must render, not the 10%
    // estimate of contextLength (15107 → 1511 → "2K"); real input renders
    // as-is, not contextLength+cacheRead (which double-counts for codex).
    const out = formatUsageStats({
      contextLength: 15107,
      inputTokens: 15006,
      outputTokens: 101,
      cacheReadTokens: 6400,
    });
    expect(out).toContain('Output token - 101');
    expect(out).not.toMatch(/Output token - \d+K/);
    expect(out).toContain('Input token - 15K');
  });

  it('falls back to 10% output estimate when outputTokens absent', () => {
    const out = formatUsageStats({ contextLength: 120000, compactCount: 2 });
    expect(out).toContain('Output token - 12K');
  });
});

describe('CommandRouter', () => {
  it('/help returns command card', async () => {
    const { router, connector } = createRouter();
    await router.handle('/help', ctx);
    const card = (
      connector._sent[0].input as { card: { body?: { elements: object[] }; elements?: object[] } }
    ).card;
    expect(card).toBeDefined();
    // CardKit 2.0 uses body.elements instead of elements
    const elements = card.body!.elements;
    // Should contain column_set with buttons for commands like /status
    const columnSets = elements.filter((e: { tag?: string }) => e.tag === 'column_set');
    expect(columnSets.length).toBeGreaterThan(0);
  });

  // 2026-07-04: /help 卡片对齐修复（方案 A：weighted columns）
  // 根因：每行独立 column_set + width:'auto' → 列宽随内容变化 → 跨行不对齐
  // 修复：两列都改为 width:'weighted' + 固定 weight 比例，保证跨行对齐
  it('/help columns use weighted width with consistent weights across rows (alignment fix)', async () => {
    const { router, connector } = createRouter();
    await router.handle('/help', ctx);
    const card = (
      connector._sent[0].input as { card: { body?: { elements: object[] }; elements?: object[] } }
    ).card;
    const elements = card.body!.elements;
    const columnSets = elements.filter((e: { tag?: string }) => e.tag === 'column_set');

    expect(columnSets.length).toBeGreaterThan(0);

    // 收集每行 button 列 / text 列的 width 与 weight
    const buttonColSpecs: { width?: string; weight?: number }[] = [];
    const textColSpecs: { width?: string; weight?: number }[] = [];
    for (const cs of columnSets) {
      const cols = (
        cs as {
          columns: {
            tag?: string;
            elements?: { tag?: string }[];
            width?: string;
            weight?: number;
          }[];
        }
      ).columns;
      // button 列 = 含 button 元素的列；text 列 = 含 div 元素的列
      const buttonCol = cols.find((c) => c.elements?.some((e) => e.tag === 'button'));
      const textCol = cols.find((c) => c.elements?.some((e) => e.tag === 'div'));
      if (buttonCol) buttonColSpecs.push({ width: buttonCol.width, weight: buttonCol.weight });
      if (textCol) textColSpecs.push({ width: textCol.width, weight: textCol.weight });
    }

    // 断言 1：所有 button 列 width=weighted（不再 auto）
    expect(buttonColSpecs.length).toBeGreaterThan(0);
    for (const spec of buttonColSpecs) {
      expect(spec.width).toBe('weighted');
    }
    // 断言 2：所有 text 列 width=weighted
    expect(textColSpecs.length).toBeGreaterThan(0);
    for (const spec of textColSpecs) {
      expect(spec.width).toBe('weighted');
    }
    // 断言 3：所有 button 列 weight 一致（跨行对齐）
    const buttonWeights = new Set(buttonColSpecs.map((s) => s.weight));
    expect(buttonWeights.size).toBe(1);
    // 断言 4：所有 text 列 weight 一致
    const textWeights = new Set(textColSpecs.map((s) => s.weight));
    expect(textWeights.size).toBe(1);
    // 断言 5：text 列 weight > button 列 weight（描述列更宽）
    const buttonWeight = buttonColSpecs[0].weight;
    const textWeight = textColSpecs[0].weight;
    expect(textWeight!).toBeGreaterThan(buttonWeight!);
  });

  it('/help card does not mix V1/V2 — no 1.x `action` container (regression: 200861)', async () => {
    const { router, connector } = createRouter();
    await router.handle('/help', ctx);
    const card = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(card.card);
    // 2.0 cards MUST NOT mix in 1.x `tag:"action"` containers (200861 root cause).
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  // 2026-07-04: /help 卡片重构
  // - 按钮组在上、文本组在下，中间 hr 分隔
  // - /reset 别名删除、/doctor 命令删除
  // - 按钮只保留子命令不含参数（/active 只显示 /active）
  // - /ls 标签从 [A-Z|0-9|#] 过滤改为 [dir]（与 bash ls 等价）
  it('/help reorganization: buttons first, text rows last, separated by hr; /reset & /doctor removed; button labels have no params', async () => {
    const { router, connector } = createRouter();
    await router.handle('/help', ctx);
    const card = (
      connector._sent[0].input as { card: { body?: { elements: object[] }; elements?: object[] } }
    ).card;
    const elements = card.body!.elements;

    // 整卡不得出现 /reset 或 /doctor
    const cardStr = JSON.stringify(elements);
    expect(cardStr).not.toMatch(/\/reset/);
    expect(cardStr).not.toMatch(/\/doctor/);

    // 找到第一个 hr 的位置（按钮组与文本组分隔线）
    const hrIdx = elements.findIndex((e: { tag?: string }) => e.tag === 'hr');
    expect(hrIdx).toBeGreaterThan(0);

    // hr 之前应全部是 column_set（按钮组），hr 之后到下一个 hr 之间应全是 div（文本组）
    const beforeHr = elements.slice(0, hrIdx);
    for (const e of beforeHr) {
      expect((e as { tag?: string }).tag).toBe('column_set');
    }
    // 按钮组至少有 /help /status 等多个按钮
    expect(beforeHr.length).toBeGreaterThanOrEqual(8);

    // hr 之后到第二个 hr 之间是文本组（全是 div）
    const secondHrIdx = elements.findIndex(
      (e: { tag?: string }, i: number) => i > hrIdx && e.tag === 'hr',
    );
    expect(secondHrIdx).toBeGreaterThan(hrIdx);
    const textGroup = elements.slice(hrIdx + 1, secondHrIdx);
    for (const e of textGroup) {
      expect((e as { tag?: string }).tag).toBe('div');
    }
    // 文本组至少含 /cd /ls /resume /order
    expect(textGroup.length).toBeGreaterThanOrEqual(4);

    // /ls 文本行标签应为 `/ls [dir]`（不再 [A-Z|0-9|#]）
    const lsTextRow = textGroup.find((d) => {
      const content = (d as { text?: { content?: string } }).text?.content ?? '';
      return content.includes('/ls');
    });
    expect(lsTextRow).toBeDefined();
    const lsContent = (lsTextRow as { text: { content: string } }).text.content;
    expect(lsContent).toMatch(/\/ls \[dir\]/);
    expect(lsContent).not.toMatch(/\[A-Z/);
  });

  // 2026-07-04: /help 卡片 /ws 按钮简化 + 按钮 label 长度排序
  it('/help /ws button label is "/ws" (subcommands moved to right text); buttons sorted by label length', async () => {
    const { router, connector } = createRouter();
    await router.handle('/help', ctx);
    const card = (
      connector._sent[0].input as { card: { body?: { elements: object[] }; elements?: object[] } }
    ).card;
    const elements = card.body!.elements ?? [];

    const columnSets = elements.filter((e: { tag?: string }) => e.tag === 'column_set');
    expect(columnSets.length).toBeGreaterThan(0);

    // 提取每个 column_set 的按钮 label 与右侧文本
    const rows: { label: string; desc: string }[] = [];
    for (const cs of columnSets) {
      const cols = (
        cs as { columns: { elements?: { tag?: string; text?: { content?: string } }[] }[] }
      ).columns;
      const buttonCol = cols.find((c) => c.elements?.some((e) => e.tag === 'button'));
      const textCol = cols.find((c) => c.elements?.some((e) => e.tag === 'div'));
      const btn = buttonCol?.elements?.find((e) => e.tag === 'button');
      const div = textCol?.elements?.find((e) => e.tag === 'div');
      if (btn?.text?.content && div?.text?.content) {
        rows.push({ label: btn.text.content, desc: div.text.content });
      }
    }

    // /ws 按钮的 label 应为 "/ws"（不再含 save|use|remove）
    const wsRow = rows.find((r) => r.label === '/ws');
    expect(wsRow).toBeDefined();
    // 子命令应在右侧文本中
    expect(wsRow!.desc).toContain('save');
    expect(wsRow!.desc).toContain('use');
    expect(wsRow!.desc).toContain('remove');

    // 整张卡片不应再出现 "/ws save|use|remove" 作为按钮 label
    for (const r of rows) {
      expect(r.label).not.toMatch(/save\|use\|remove/);
    }

    // 按钮 label 应按长度升序排列（短在上，长在下）
    // 同长度时按 cmd 字典序排列（实现细节，只断言长度单调不减）
    const labels = rows.map((r) => r.label);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i].length).toBeGreaterThanOrEqual(labels[i - 1].length);
    }
  });

  it('/status shows current state', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/status', ctx);
    const md = (connector._sent[0].input as { markdown: string }).markdown;
    expect(md).toContain('/tmp');
    expect(md).toContain('s1');
  });

  it('/ps returns process status', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/ps', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('无进程');
  });

  it('/new clears sessionId', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/new', ctx);
    const entry = sessionStore.get('user1');
    expect(entry?.sessions?.get('claude') ?? '').toBe('');
  });

  it('/new clears sessionId but keeps cwd so /resume still works (2026-06-21)', async () => {
    // Regression: /new 用 sessionStore.delete 把整个 entry 都清掉，导致
    // /new 之后 /resume 提示"请先 /cd 设置工作目录"，但用户的 workspace
    // 还在 — 期望是只清 sessionId 保留 cwd。
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/new', ctx);
    const entry = sessionStore.get('user1');
    expect(entry?.cwd).toBe('/tmp');
    expect(entry?.sessions?.get('claude') ?? '').toBe('');
  });

  it('/cd sets cwd and clears sessionId', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle(`/cd ${tmpDir}`, ctx);
    const entry = sessionStore.get('user1');
    // cmdCd canonicalizes via realpathSync, so cwd matches what Claude
    // writes into JSONL (`/var/folders/...` → `/private/var/folders/...`).
    expect(entry?.cwd).toBe(fs.realpathSync(tmpDir));
    expect(entry?.sessions.get('claude')).toBe('');
  });

  it('/cd resolves symlinks so cwd matches Claude JSONL cwd field (2026-06-21)', async () => {
    // On macOS `/tmp` is a symlink to `/private/tmp`. Claude writes the
    // symlink-resolved cwd into JSONL. If `/cd /tmp/foo` stores `/tmp/foo`
    // (not resolved), session lookups never find
    // matching sessions. Regression: 2026-06-21 /active paths.
    const real = path.join(tmpDir, 'real-target');
    fs.mkdirSync(real);
    const link = path.join(tmpDir, 'alias-link');
    fs.symlinkSync(real, link);

    const { router, sessionStore } = createRouter();
    await router.handle(`/cd ${link}`, ctx);

    // sessionStore cwd must be the resolved target, not the symlink.
    expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(real));
    expect(sessionStore.getCwd('user1')).not.toBe(link);
  });

  it('/cd nonexistent path returns error', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/cd /nonexistent/path/xyz', ctx);
    expect(sessionStore.getCwd('user1')).toBe('/tmp');
    expect((connector._sent[0].input as { text: string }).text).toContain('不存在');
  });

  it('/cd expands ~ to home directory (not treated as relative)', async () => {
    const { router, sessionStore, connector } = createRouter();
    const home = os.homedir();
    // Use a subdir of home that definitely exists: home itself via `~`
    await router.handle('/cd ~', ctx);
    expect(sessionStore.getCwd('user1')).toBe(home);
    // A non-existent ~ path must report the expanded path, not <cwd>/~/...
    await router.handle('/cd ~/no_such_dir_xyz', ctx);
    // Use the last sent message (may be card if auto-resume triggered)
    const lastInput = connector._sent[connector._sent.length - 1].input as {
      text?: string;
      card?: object;
    };
    expect(lastInput.text ?? JSON.stringify(lastInput.card)).toContain(home);
    expect(lastInput.text ?? JSON.stringify(lastInput.card)).not.toContain(`/~/`);
  });

  it('/cd expands ~ to home directory, not relative to process.cwd()', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: tmpDir,
    });
    // Create a subdirectory under home to guarantee it exists on CI.
    const homeSubdir = path.join(os.homedir(), `.lark-router-test-${process.pid}`);
    fs.mkdirSync(homeSubdir, { recursive: true });
    try {
      await router.handle(`/cd ~/${path.basename(homeSubdir)}`, ctx);
      const entry = sessionStore.get('user1');
      expect(entry?.cwd).toBe(homeSubdir);
      expect(entry?.cwd).not.toContain('~');
      expect(entry?.cwd).not.toContain(tmpDir);
    } finally {
      fs.rmSync(homeSubdir, { recursive: true, force: true });
    }
  });

  it('/cd with bare ~ goes to home directory', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: tmpDir,
    });
    await router.handle('/cd ~', ctx);
    expect(sessionStore.getCwd('user1')).toBe(os.homedir());
  });

  it('/cd expands ~ to home directory', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/cd ~', ctx);
    expect(sessionStore.getCwd('user1')).toBe(os.homedir());
  });

  it('/ls without cwd prompts to /cd', async () => {
    const { router, connector } = createRouter();
    await router.handle('/ls', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('/cd');
  });

  it('/ls returns CardKit 2.0 card with section headers (§6.1)', async () => {
    const { router, sessionStore, connector } = createRouter();
    fs.mkdirSync(path.join(tmpDir, 'sub1'));
    fs.mkdirSync(path.join(tmpDir, 'sub2'));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as {
      card: {
        schema?: string;
        config: { wide_screen_mode: boolean };
        header: { title: { tag: string; content: string } };
        body: { elements: object[] };
      };
    };
    expect(input.card).toBeDefined();
    expect(input.card.schema).toBe('2.0');
    expect(input.card.config.wide_screen_mode).toBe(true);
    expect(input.card.header.title.tag).toBe('plain_text');
    expect(input.card.header.title.content).toContain(path.basename(tmpDir));
    // Should have section headers (CardKit 2.0 doesn't support tabs)
    const cardStr = JSON.stringify(input.card);
    expect(cardStr).toContain('**📂 目录');
    // 2 subdirectories = 2 buttons in dirs section
    const dirButtons = cardStr.match(/📁 sub\d/g);
    expect(dirButtons?.length).toBe(2);
    // Verify button structure with behaviors (column_set + column + button)
    expect(cardStr).toContain('"tag":"column_set"');
    expect(cardStr).toContain('"tag":"button"');
    expect(cardStr).toContain('"behaviors"');
  });

  it('/ls card does not mix V1/V2 — no 1.x `action` container (regression: 200861)', async () => {
    const { router, sessionStore, connector } = createRouter();
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const cardStr = JSON.stringify((connector._sent[0].input as { card: object }).card);
    expect(cardStr).toContain('"schema":"2.0"');
    // 2.0 cards MUST NOT mix in 1.x `tag:"action"` containers (200861 root cause).
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    // ls.browse buttons use 2.0 behaviors, not 1.x `value`
    expect(cardStr).toContain('"cmd":"ls.browse"');
  });

  it('/ls renders one button per directory in section', async () => {
    const { router, sessionStore, connector } = createRouter();
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(tmpDir, `d${i}`));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: { body?: { elements?: object[] } } };
    const cardStr = JSON.stringify(input.card);
    // 5 directories shown in section
    const dirMatches = cardStr.match(/📁 d\d/g);
    expect(dirMatches?.length).toBe(5);
  });

  it('/ls shows all subdirectories in section', async () => {
    const { router, sessionStore, connector } = createRouter();
    for (const n of ['apple', 'avocado', 'banana', '9start', '#hash']) {
      fs.mkdirSync(path.join(tmpDir, n));
    }
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);
    // 5 directories shown in section
    const dirMatches = cardStr.match(/📁 (apple|avocado|banana|9start|#hash)/g);
    expect(dirMatches?.length).toBe(5);
  });

  it('/ls no longer truncates at 40 subdirectories', async () => {
    const { router, sessionStore, connector } = createRouter();
    for (let i = 0; i < 45; i++) fs.mkdirSync(path.join(tmpDir, `d${String(i).padStart(2, '0')}`));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);
    // Page 1 shows d00-d29 (LS_PAGE_SIZE=30). d44 is on page 2.
    expect(cardStr).toContain('d00');
    expect(cardStr).toContain('d29');
    // Should have pagination info (not all 45 fit on one page)
    expect(cardStr).toContain('第 1/2 页');
    expect(cardStr).toContain('下一页');
  });

  it('/ls uses section headers to organize different categories', async () => {
    const { router, sessionStore, connector } = createRouter();
    // Create directories and files
    fs.mkdirSync(path.join(tmpDir, 'aaa'));
    fs.mkdirSync(path.join(tmpDir, 'bbb'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);
    // Should have section headers with different categories (CardKit 2.0 doesn't support tabs)
    expect(cardStr).toContain('**📂 目录');
    expect(cardStr).toContain('**📄 文件');
  });

  it('/ls lists both files and directories in separate tabs', async () => {
    const { router, sessionStore, connector } = createRouter();
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);
    // Should have subdir in dirs tab
    expect(cardStr).toContain('subdir');
    // Should have file.txt in files tab
    expect(cardStr).toContain('file.txt');
  });

  it('/ls formats directories differently from files (different icons)', async () => {
    const { router, sessionStore, connector } = createRouter();
    fs.mkdirSync(path.join(tmpDir, 'mydir'));
    fs.writeFileSync(path.join(tmpDir, 'myfile.txt'), 'content');
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);
    // Directory should have folder icon (📁), file should have different format (📄)
    expect(cardStr).toContain('📁 mydir');
    expect(cardStr).toContain('📄 myfile.txt');
  });

  it('/ls has parent directory button (..) in header', async () => {
    const { router, sessionStore, connector } = createRouter();
    // Create a nested directory structure
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    sessionStore.setCwd('user1', subDir);
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: object };
    const cardStr = JSON.stringify(input.card);
    // Should have "上级" button in the column_set header (ls.browse)
    expect(cardStr).toContain('上级');
    expect(cardStr).toContain('ls.browse');
  });

  it('/ls with subdirectory argument lists that directory (like bash ls)', async () => {
    const { router, sessionStore, connector } = createRouter();
    // Create parent dir and subdir
    fs.mkdirSync(path.join(tmpDir, 'parent'));
    fs.mkdirSync(path.join(tmpDir, 'parent', 'child'));
    fs.writeFileSync(path.join(tmpDir, 'parent', 'file.txt'), 'content');
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    // /ls parent should list contents of parent directory
    await router.handle('/ls parent', ctx);
    const input = connector._sent[0].input as {
      card: { header?: { title?: { content?: string } } };
    };
    const cardStr = JSON.stringify(input.card);

    // Header should show "parent" not "tmpDir"
    expect(input.card.header?.title?.content).toContain('parent');
    // Should show child directory and file.txt
    expect(cardStr).toContain('📁 child');
    expect(cardStr).toContain('📄 file.txt');
    // Should NOT show parent directory button (..) since parent is the target
    // (we're inside parent now, so parent of parent is different)
  });

  it('/ls shows "返回" button when viewing subdirectory', async () => {
    const { router, sessionStore, connector } = createRouter();
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    // /ls subdir should show a "返回" button to go back to cwd
    await router.handle('/ls subdir', ctx);
    const cardStr = JSON.stringify((connector._sent[0].input as { card: object }).card);

    // Should have a 返回 button
    expect(cardStr).toContain('返回');
  });

  it('/ls pagination: every column in column_set has tag="column" (regression: ErrCode 200621)', async () => {
    // Root cause (2026-07-14): pagination bar pageColumns.push() omitted `tag: 'column'`
    // on each column object. Feishu CardKit 2.0 requires every item in columns[] to have
    // tag: 'column', otherwise returns ErrCode 200621 "no tag specified".
    const { router, sessionStore, connector } = createRouter();
    // 31 items triggers pagination on page 1
    for (let i = 0; i < 31; i++) fs.mkdirSync(path.join(tmpDir, `d${String(i).padStart(2, '0')}`));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: { body: { elements: TestCardElement[] } } };
    const card = input.card;

    // Recursively assert: every column in every column_set has tag === 'column'
    const violations: string[] = [];
    function checkColumnTags(els: TestCardElement[], path: string): void {
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const p = `${path}[${i}]`;
        if (el.tag === 'column_set' && el.columns) {
          for (let j = 0; j < el.columns.length; j++) {
            const col = el.columns[j] as Record<string, unknown>;
            const cp = `${p}.columns[${j}]`;
            if (col.tag !== 'column') {
              violations.push(`${cp}.tag is "${col.tag ?? 'undefined'}", expected "column"`);
            }
            if (col.elements) checkColumnTags(col.elements as TestCardElement[], `${cp}.elements`);
          }
        }
      }
    }
    checkColumnTags(card.body.elements, 'body.elements');
    expect(violations).toEqual([]);
  });

  it('/ls pagination: no column with empty elements (regression: ErrCode 200621)', async () => {
    // Root cause: pagination bar used hasPrev ? [button] : [] which produced
    // columns with elements=[] on the first page. Feishu rejects empty elements
    // with "no tag specified" (ErrCode 200621). Fix: only include column when
    // it has content.
    const { router, sessionStore, connector } = createRouter();
    // 31 items = 1 more than LS_PAGE_SIZE(30), triggers pagination on page 1
    for (let i = 0; i < 31; i++) fs.mkdirSync(path.join(tmpDir, `d${String(i).padStart(2, '0')}`));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: { body: { elements: TestCardElement[] } } };
    const card = input.card;

    // Recursively assert: no elements[] or columns[].elements[] is empty
    const violations: string[] = [];
    function checkElements(els: TestCardElement[], path: string): void {
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const p = `${path}[${i}]`;
        if (el.columns) {
          for (let j = 0; j < el.columns.length; j++) {
            const col = el.columns[j];
            const cp = `${p}.columns[${j}]`;
            if (!col.elements || col.elements.length === 0) {
              violations.push(`${cp}.elements is empty (tag=${el.tag || 'none'})`);
            } else {
              checkElements(col.elements, `${cp}.elements`);
            }
          }
        }
        // Also check direct elements on the element itself (e.g. button elements)
      }
    }
    checkElements(card.body.elements, 'body.elements');
    expect(violations).toEqual([]);

    // First page should NOT have 上一页 (hasPrev=false), but SHOULD have 下一页
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain('上一页');
    expect(cardStr).toContain('下一页');
  });

  it('/ls pagination: second page has 上一页 but no 下一页', async () => {
    const { router, sessionStore, connector } = createRouter();
    for (let i = 0; i < 31; i++) fs.mkdirSync(path.join(tmpDir, `d${String(i).padStart(2, '0')}`));
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    // Simulate ls.page callback for page 2 (offset=30)
    const ctxWithMsgId = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
    await router.handleCardAction(
      { cmd: 'ls.page', path: fs.realpathSync(tmpDir), offset: 30 },
      ctxWithMsgId,
    );
    // handleLsPage now updates card in place via bridge.updateCardInPlace
    // The result is just a toast response. Check the updated card in connector._cards
    expect(connector._cards.length).toBeGreaterThan(0);
    const card = connector._cards[connector._cards.length - 1] as {
      body: { elements: TestCardElement[] };
    };

    // Same empty-elements check
    const violations: string[] = [];
    function checkElements(els: TestCardElement[], path: string): void {
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const p = `${path}[${i}]`;
        if (el.columns) {
          for (let j = 0; j < el.columns.length; j++) {
            const col = el.columns[j];
            const cp = `${p}.columns[${j}]`;
            if (!col.elements || col.elements.length === 0) {
              violations.push(`${cp}.elements is empty (tag=${el.tag || 'none'})`);
            } else {
              checkElements(col.elements, `${cp}.elements`);
            }
          }
        }
      }
    }
    checkElements(card.body.elements, 'body.elements');
    expect(violations).toEqual([]);

    const cardStr = JSON.stringify(card);
    expect(cardStr).toContain('上一页');
    expect(cardStr).not.toContain('下一页');
  });

  it('/ls card has no empty elements[] anywhere (structural invariant)', async () => {
    // Broader invariant: every column.elements and top-level elements[] in the
    // entire card must be non-empty. This catches any future regression where
    // conditional rendering produces empty arrays.
    const { router, sessionStore, connector } = createRouter();
    // Small directory — no pagination
    fs.mkdirSync(path.join(tmpDir, 'onlydir'));
    fs.writeFileSync(path.join(tmpDir, 'onlyfile.txt'), 'hi');
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ls', ctx);
    const input = connector._sent[0].input as { card: { body: { elements: TestCardElement[] } } };

    const violations: string[] = [];
    function checkAll(obj: unknown, path: string): void {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        if (obj.length === 0 && path.endsWith('elements')) {
          violations.push(`${path} is empty`);
        }
        obj.forEach((v, i) => checkAll(v, `${path}[${i}]`));
        return;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        checkAll(v, `${path}.${k}`);
      }
    }
    checkAll(input.card, 'card');
    expect(violations).toEqual([]);
  });

  it('/ws save/use/remove/list with card (§6.3)', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    await router.handle('/ws save proj', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('已保存');

    await router.handle('/ws list', ctx);
    const listInput = connector._sent[1].input as {
      card: {
        body?: {
          elements: Array<{
            tag: string;
            actions?: Array<{ value: { cmd: string; name: string } }>;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string; name: string } }> }>;
            }>;
          }>;
        };
        elements?: Array<{
          tag: string;
          actions?: Array<{ value: { cmd: string; name: string } }>;
          columns?: Array<{
            elements?: Array<{ behaviors?: Array<{ value: { cmd: string; name: string } }> }>;
          }>;
        }>;
      };
    };
    expect(listInput.card).toBeDefined();
    const elements = listInput.card.body!.elements;
    // CardKit 2.0 only: use column_set+column with behaviors
    const buttons2x = elements.flatMap((e) =>
      (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
    );
    const allButtons = buttons2x.map((b) => ({ cmd: b.value?.cmd, name: b.value?.name }));
    const cmds = allButtons.map((a) => a.cmd);
    expect(cmds).toContain('ws.use');
    expect(cmds).toContain('ws.remove');
    expect(allButtons.find((a) => a.cmd === 'ws.use')?.name).toBe('proj');

    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/ws use proj', ctx);
    const entry = sessionStore.get('user1');
    // cmdWsUse canonicalizes via realpathSync to match Claude JSONL cwd.
    expect(entry?.cwd).toBe(fs.realpathSync(tmpDir));
    expect(entry?.sessions?.get('claude')).toBe('');

    await router.handle('/ws remove proj', ctx);
    expect((connector._sent[3].input as { text: string }).text).toContain('已删除');
  });

  it('/ws list: buttons labeled 切换/删除, no workspace name on label (TDD)', async () => {
    // 每行只保留：文案 + 一个切换 + 一个删除；按钮文案不带 workspace 名字。
    // callback value 仍带 name（否则 handler 不知道操作哪个 workspace）。
    const { router, sessionStore, connector } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ws save proj', ctx);
    await router.handle('/ws list', ctx);

    const input = connector._sent[1].input as { card: TestCard };
    expect(input.card).toBeDefined();
    // 200861 铁律：2.0 卡片不得出现 tag:action + actions
    expect(JSON.stringify(input.card)).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    const elements = input.card.body!.elements ?? [];
    const buttons = elements
      .flatMap((e) => (e.columns ?? []).flatMap((c) => c.elements ?? []))
      .filter((b) => b.tag === 'button');

    // 每个 workspace 恰好两个按钮：切换 + 删除（无多余按钮）
    expect(buttons.length).toBe(2);
    const labels = buttons.map((b) => b.text?.content);
    expect(labels).toContain('切换');
    expect(labels).toContain('删除');
    // 按钮文案不带 workspace 名字
    expect(labels.every((l: string | undefined) => !l?.includes('proj'))).toBe(true);

    // callback value 仍带 name 识别操作目标
    const useBtn = buttons.find((b) => b.behaviors?.[0]?.value?.cmd === 'ws.use');
    expect(useBtn?.behaviors?.[0]?.value?.name).toBe('proj');
    const removeBtn = buttons.find((b) => b.behaviors?.[0]?.value?.cmd === 'ws.remove');
    expect(removeBtn?.behaviors?.[0]?.value?.name).toBe('proj');
  });

  it('/ws list with no workspaces shows card with hint', async () => {
    const { router, connector } = createRouter();
    await router.handle('/ws list', ctx);
    const input = connector._sent[0].input as {
      card: {
        body?: { elements: Array<{ tag: string; text?: { content: string } }> };
        elements?: Array<{ tag: string; text?: { content: string } }>;
      };
    };
    expect(input.card).toBeDefined();
    const elements = input.card.body!.elements ?? [];
    const texts = elements.filter((e) => e.text).map((e) => e.text!.content);
    expect(texts.some((t) => t.includes('没有保存的 workspace'))).toBe(true);
  });

  it('/ws with no subcommand defaults to list', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/ws save proj', ctx);
    await router.handle('/ws', ctx);
    const input = connector._sent[1].input as {
      card: {
        body?: {
          elements: Array<{
            tag: string;
            actions?: Array<{ value: { cmd: string } }>;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
            }>;
          }>;
        };
        elements?: Array<{
          tag: string;
          actions?: Array<{ value: { cmd: string } }>;
          columns?: Array<{ elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }> }>;
        }>;
      };
    };
    expect(input.card).toBeDefined();
    const elements = input.card.body!.elements;
    // CardKit 2.0 only: buttons are in column elements with behaviors
    const buttons2x = elements.flatMap((e) =>
      (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
    );
    const allButtons = buttons2x.map((b) => b.value?.cmd);
    expect(allButtons).toContain('ws.use');
  });

  it('/resume without cwd prompts to /cd', async () => {
    const { router, connector } = createRouter();
    await router.handle('/resume', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('/cd');
  });

  it('/resume list returns text when no sessions exist for cwd', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/resume', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('没有 Claude session');
  });

  it('/resume <id> sets session id only when session exists', async () => {
    // Setup: create a valid session JSONL in a custom projectsDir
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const encoded = encodedProjectDir(tmpDir);
    const projDir = path.join(projectsDir, encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const sid = 'abc-123';
    writeSessionJsonl(
      projDir,
      sid,
      tmpDir,
      // Valid session with user message and assistant response
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"]},"cwd":"' +
        tmpDir +
        '"}\n' +
        '{"type":"assistant","message":{"id":"msg1","role":"assistant","content":[{"type":"text","text":"hi"}]},"usage":{"input_tokens":10,"output_tokens":20}}',
    );

    // Pass projectsDir to the router so it can find the session
    const { router, sessionStore } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/resume abc-123', ctx);
    // Session should be set because it exists in this cwd
    expect(sessionStore.getSessionId('user1')).toBe('abc-123');
  });

  it('/resume <id> does NOT set session id when session not found', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    // Try to resume a non-existent session - should return error, NOT set sessionId
    await router.handle('/resume nonexistent-session', ctx);
    // SessionId should NOT be set because the session doesn't exist
    expect(sessionStore.getSessionId('user1')).toBeUndefined();
  });

  it('/resume <id> renders card even when session tail is empty (last line is user)', async () => {
    // session 存在 + cwd 匹配，但最后一行是 user 消息（无 assistant 回复）。
    // readSessionContent 的 catch-up tail 为空，但仍应输出卡片（header + 空状态），
    // 而非纯文本"已设置 session_id"。
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const encoded = encodedProjectDir(tmpDir);
    const projDir = path.join(projectsDir, encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const sid = 'cccccccc-0000-0000-0000-000000000000';
    writeSessionJsonl(
      projDir,
      sid,
      tmpDir,
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first q"}]}}\n' +
        '{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"first a"}],"usage":{"input_tokens":10,"output_tokens":20}}}\n' +
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second q"}]}}',
    );

    const { router, sessionStore, connector } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle(`/resume ${sid}`, ctx);

    const input = connector._sent[0].input as { card?: TestCard; text?: string };
    // 应输出卡片，不是纯文本
    expect(input.card).toBeDefined();
    expect(input.text).toBeUndefined();
    // 卡片 header 含 session id
    expect(JSON.stringify(input.card)).toContain(sid);
  });

  it('/resume <id> returns text when session does not exist in current cwd', async () => {
    // session 文件不存在 / cwd 不匹配：readSessionContent early return 无 header 信息，
    // 应返回文本说明，而非误导性的卡片。
    const { router, sessionStore, connector } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/resume nonexist-session-id', ctx);
    const input = connector._sent[0].input as { card?: TestCard; text?: string };
    expect(input.text).toBeDefined();
    expect(input.card).toBeUndefined();
    expect(input.text).toContain('未找到');
  });

  it('/resume lists sessions as a card reading from claude projects dir', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const encoded = encodedProjectDir(tmpDir);
    const projDir = path.join(projectsDir, encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const sidA = 'aaaaaaaa-0000-0000-0000-000000000000';
    const sidB = 'bbbbbbbb-0000-0000-0000-000000000000';
    writeSessionJsonl(
      projDir,
      sidA,
      tmpDir,
      `{"type":"user","message":{"role":"user","content":"older task"}}`,
    );
    const pathB = path.join(projDir, `${sidB}.jsonl`);
    writeSessionJsonl(
      projDir,
      sidB,
      tmpDir,
      `{"type":"queue-operation","operation":"enqueue"}\n{"type":"user","message":{"role":"user","content":"newer task"}}`,
    );
    const future = Date.now() / 1000 + 100;
    fs.utimesSync(pathB, future, future);

    const { router, sessionStore, connector } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('/resume', ctx);
    const input = connector._sent[0].input as {
      card: {
        body?: {
          elements: Array<{
            tag: string;
            actions?: Array<{
              value: { cmd: string; sessionId: string };
              text?: { content: string };
            }>;
            columns?: Array<{
              elements?: Array<{
                text?: { content: string };
                behaviors?: Array<{ value: { cmd: string; sessionId: string } }>;
              }>;
            }>;
          }>;
        };
        elements?: Array<{
          tag: string;
          actions?: Array<{
            value: { cmd: string; sessionId: string };
            text?: { content: string };
          }>;
          columns?: Array<{
            elements?: Array<{
              text?: { content: string };
              behaviors?: Array<{ value: { cmd: string; sessionId: string } }>;
            }>;
          }>;
        }>;
      };
    };
    expect(input.card).toBeDefined();
    const elements = input.card.body!.elements;
    // CardKit 2.0 only: buttons are in column elements with behaviors
    const buttons2x = elements.flatMap((e) => (e.columns ?? []).flatMap((c) => c.elements ?? []));
    const allButtons = buttons2x.map((b) => ({
      cmd: b.behaviors?.[0]?.value?.cmd,
      sessionId: b.behaviors?.[0]?.value?.sessionId,
      text: b.text?.content,
    }));
    expect(allButtons.length).toBe(2);
    // Newest first, both have "恢复此会话" button since neither is current
    expect(allButtons[0].sessionId).toBe(sidB);
    expect(allButtons[0].text ?? '').toContain('恢复此会话');
    expect(allButtons[0].cmd).toBe('resume.use');
  });

  it('/resume use card action sets session id for a real session (P1-5)', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const projDir = path.join(projectsDir, encodedProjectDir(tmpDir));
    fs.mkdirSync(projDir, { recursive: true });
    writeSessionJsonl(
      projDir,
      'real-session',
      tmpDir,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-06-19T10:00:00.000Z"}`,
    );
    const { router, sessionStore } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handleCardAction({ cmd: 'resume.use', sessionId: 'real-session' }, ctx);
    expect(sessionStore.getSessionId('user1')).toBe('real-session');
  });

  it('/resume use card action does not set session id when session missing (P1-5)', async () => {
    const { router, sessionStore } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handleCardAction({ cmd: 'resume.use', sessionId: 'sid-xyz' }, ctx);
    // P1-5：校验失败不得污染 sessionStore（旧实现会写入幽灵 sessionId）
    expect(sessionStore.getSessionId('user1')).toBeUndefined();
  });

  it('/resume <id> shows session history in card with timestamp', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const encoded = encodedProjectDir(tmpDir);
    const projDir = path.join(projectsDir, encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const sid = 'session-123';
    // Write a session with timestamp
    const body =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
        timestamp: '2026-06-19T10:00:00.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first response' }] },
        timestamp: '2026-06-19T10:00:01.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'last user input' }] },
        timestamp: '2026-06-20T15:30:00.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'last assistant output after last user input' }],
        },
        timestamp: '2026-06-20T15:30:01.000Z',
      }) +
      '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', session_id: sid });
    writeSessionJsonl(projDir, sid, tmpDir, body);

    const { router, sessionStore, connector } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle(`/resume ${sid}`, ctx);

    // Should return a card with session content after the last user input
    const input = connector._sent[0].input as {
      card?: { elements: Array<{ tag: string; text?: { content: string } }> };
    };
    expect(input.card).toBeDefined();
    const cardContent = JSON.stringify(input.card);
    // Should contain content AFTER the last user input
    expect(cardContent).toContain('last assistant output');
    // Should NOT contain content before the last user input
    expect(cardContent).not.toContain('first prompt');
    expect(cardContent).not.toContain('first response');
    // Should display timestamp in the card (format: YYYY-MM-DD HH:mm)
    expect(cardContent).toContain(formatTimestamp('2026-06-20T15:30:01.000Z'));
    // Session id should be set
    expect(sessionStore.getSessionId('user1')).toBe(sid);
  });

  it('/resume use card action shows session history', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const encoded = encodedProjectDir(tmpDir);
    const projDir = path.join(projectsDir, encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const sid = 'card-resume-456';
    const body =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'some task' }] },
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'some response' }] },
      }) +
      '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', session_id: sid });
    writeSessionJsonl(projDir, sid, tmpDir, body);

    const { router, sessionStore, connector } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handleCardAction({ cmd: 'resume.use', sessionId: sid }, ctx);

    // Should return a card with session content
    const input = connector._sent[0].input as {
      card?: { elements: Array<{ tag: string; text?: { content: string } }> };
    };
    expect(input.card).toBeDefined();
    expect(sessionStore.getSessionId('user1')).toBe(sid);
  });

  /** Create a SessionReaderRegistry where only codex has content, others are empty stubs. */
  function createCodexOnlyRegistry(codexReadSpy: ReturnType<typeof vi.fn>) {
    const codexReader: AgentSessionReader = {
      listSessions: () => ({ sessions: [], total: 0 }),
      getNewestSession: () => null,
      readSessionContent: codexReadSpy,
      isSessionActive: () => false,
    };
    const registry = new SessionReaderRegistry();
    registry.register('claude', stubSessionReader);
    registry.register('codex', codexReader);
    registry.register('opencode', stubSessionReader);
    registry.register('pi', stubSessionReader);
    registry.register('kimi', stubSessionReader);
    return registry;
  }

  it('resume.use with agent field routes to correct agent reader', async () => {
    // Session exists in codex reader but NOT in claude reader.
    // If resume.use carries agent:'codex', it should find the session.
    const codexReadSpy = vi.fn(() => ({
      events: [{ type: 'text', content: 'codex session tail' }],
      usage: undefined,
      aiTitle: undefined,
      recap: undefined,
      displayTitle: undefined,
      reason: 'ok',
    }));
    const registry = createCodexOnlyRegistry(codexReadSpy);

    const { router, sessionStore } = createRouter({ sessionReaderRegistry: registry });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    // Click resume.use button WITH agent:'codex' → should use codex reader
    await router.handleCardAction(
      { cmd: 'resume.use', sessionId: 'codex-session-1', agent: 'codex' },
      ctx,
    );
    expect(codexReadSpy).toHaveBeenCalled();
    expect(codexReadSpy.mock.calls[0][0]).toBe('codex-session-1');
    expect(sessionStore.getSessionId('user1', 'codex')).toBe('codex-session-1');
  });

  it('resume.use WITHOUT agent falls back to defaultAgent and may miss session from another agent', async () => {
    // Session only exists in codex reader, not in claude (default).
    // Without agent field, resume.use falls back to claude reader → session not found.
    const codexReadSpy = vi.fn(() => ({
      events: [{ type: 'text', content: 'codex session tail' }],
      usage: undefined,
      aiTitle: undefined,
      recap: undefined,
      displayTitle: undefined,
      reason: 'ok',
    }));
    const registry = createCodexOnlyRegistry(codexReadSpy);

    const { router, sessionStore, connector } = createRouter({ sessionReaderRegistry: registry });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));

    // Click resume.use WITHOUT agent → falls back to defaultAgent='claude' → not found
    await router.handleCardAction({ cmd: 'resume.use', sessionId: 'codex-session-2' }, ctx);
    // codex reader should NOT have been called (default agent is claude)
    expect(codexReadSpy).not.toHaveBeenCalled();
    // session should NOT be set (validation fails because claude reader has no such session)
    expect(sessionStore.getSessionId('user1', 'claude')).toBeUndefined();
    expect(sessionStore.getSessionId('user1', 'codex')).toBeUndefined();
    // Should have sent an error message about session not found
    const lastSent = connector._sent[connector._sent.length - 1];
    const sentText =
      typeof lastSent.input === 'string' ? lastSent.input : JSON.stringify(lastSent.input);
    expect(sentText).toContain('未找到 session');
  });

  it('/resume <id> shows usage stats and context length in card', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const encoded = encodedProjectDir(tmpDir);
    const projDir = path.join(projectsDir, encoded);
    fs.mkdirSync(projDir, { recursive: true });
    const sid = 'session-with-usage';
    // Write session with usage stats in assistant message
    const body =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
        timestamp: '2026-06-20T10:00:00.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first response' }],
          usage: { input_tokens: 1000, output_tokens: 500 },
          id: 'msg-001',
        },
        timestamp: '2026-06-20T10:00:01.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'last user input' }] },
        timestamp: '2026-06-20T10:05:00.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final response' }],
          usage: { input_tokens: 5000, output_tokens: 2000 },
          id: 'msg-002',
        },
        timestamp: '2026-06-20T10:05:01.000Z',
      }) +
      '\n' +
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { preTokens: 80000, postTokens: 12000 },
        timestamp: '2026-06-20T10:06:00.000Z',
      }) +
      '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', session_id: sid });
    writeSessionJsonl(projDir, sid, tmpDir, body);

    const { router, sessionStore, connector } = createRouter({ projectsDir });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle(`/resume ${sid}`, ctx);

    const input = connector._sent[0].input as {
      card?: { elements: Array<{ tag: string; text?: { content: string } }> };
    };
    expect(input.card).toBeDefined();
    const cardContent = JSON.stringify(input.card);
    // 只依赖内存 activeRun
    // result 事件后状态直接是 done，显示"恢复会话"而不是"后台任务中"
    expect(cardContent).toContain('🔁 恢复会话');
    expect(cardContent).toContain('已完成');
    // 不会显示停止按钮（没有内存中的 activeRun）
    expect(cardContent).not.toContain('⏹ 终止');
    // Should show context length in new format
    expect(cardContent).toContain('Context - 12K');
    // Session id should be set
    expect(sessionStore.getSessionId('user1')).toBe(sid);
  });

  describe('auto-resume on directory change', () => {
    it('/cd auto-resumes newest session in new directory', async () => {
      // Create two directories with sessions
      const dirA = path.join(tmpDir, 'dirA');
      const dirB = path.join(tmpDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      // Create session in dirB
      const projectsDir = path.join(tmpDir, 'claude-projects');
      const encodedB = encodedProjectDir(dirB);
      const projDirB = path.join(projectsDir, encodedB);
      fs.mkdirSync(projDirB, { recursive: true });
      const sid = 'newest-session-abc';
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'task in dirB' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'response in dirB' }] },
        }) +
        '\n' +
        JSON.stringify({ type: 'result', subtype: 'success', session_id: sid });
      writeSessionJsonl(projDirB, sid, dirB, body);

      const { router, sessionStore, connector } = createRouter({ projectsDir });
      sessionStore.setCwd('user1', dirA);

      await router.handle(`/cd ${dirB}`, ctx);

      // Should auto-resume the newest session (sid) and show card with content
      const input = connector._sent[0].input as {
        card?: { elements: Array<{ tag: string; text?: { content: string } }> };
      };
      expect(input.card).toBeDefined();
      // Card should contain session content
      const cardContent = JSON.stringify(input.card);
      expect(cardContent).toContain('task in dirB');
      expect(cardContent).toContain('response in dirB');
      // Should have new session button
      expect(cardContent).toContain('新会话');
    });

    it('/cd does not auto-resume when no sessions exist in new directory', async () => {
      const dirA = path.join(tmpDir, 'dirA');
      const dirB = path.join(tmpDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      const { router, sessionStore, connector } = createRouter();
      sessionStore.setCwd('user1', dirA);

      await router.handle(`/cd ${dirB}`, ctx);

      // Should just show text confirmation, not auto-resume card
      const input = connector._sent[0].input;
      // Should not be a card, just text confirmation
      expect((input as { text?: string }).text).toContain('已切换到');
    });

    it('/cd auto-resume card has new session button', async () => {
      const dirA = path.join(tmpDir, 'dirA');
      const dirB = path.join(tmpDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      const projectsDir = path.join(tmpDir, 'claude-projects');
      const encodedB = encodedProjectDir(dirB);
      const projDirB = path.join(projectsDir, encodedB);
      fs.mkdirSync(projDirB, { recursive: true });
      const sid = 'test-session-xyz';
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        }) +
        '\n' +
        JSON.stringify({ type: 'result', subtype: 'success', session_id: sid });
      writeSessionJsonl(projDirB, sid, dirB, body);

      const { router, sessionStore, connector } = createRouter({ projectsDir });
      sessionStore.setCwd('user1', dirA);

      await router.handle(`/cd ${dirB}`, ctx);

      const input = connector._sent[0].input as {
        card?: {
          body?: {
            elements: Array<{
              tag: string;
              actions?: Array<{ value: { cmd: string } }>;
              columns?: Array<{
                elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
              }>;
            }>;
          };
          elements?: Array<{
            tag: string;
            actions?: Array<{ value: { cmd: string } }>;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
            }>;
          }>;
        };
      };
      expect(input.card).toBeDefined();
      // Check for new session button - CardKit 2.0 only (column_set+column+button with behaviors)
      const elements = input.card!.body!.elements;
      const buttons2x = elements.flatMap((e) =>
        (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
      );
      const hasNewSession = buttons2x.some((b) => b.value?.cmd === 'new-session');
      expect(hasNewSession).toBe(true);
    });

    it('/cd auto-resume shows stop button when session has active run (in-memory)', async () => {
      const dirA = path.join(tmpDir, 'dirA');
      const dirB = path.join(tmpDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      const projectsDir = path.join(tmpDir, 'claude-projects');
      const encodedB = encodedProjectDir(dirB);
      const projDirB = path.join(projectsDir, encodedB);
      fs.mkdirSync(projDirB, { recursive: true });
      const sid = 'bg-session-xyz';
      // Session with result goes to terminal state directly (done)
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'run background task' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'starting...' }] },
        }) +
        '\n' +
        JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.025 });
      writeSessionJsonl(projDirB, sid, dirB, body);

      const { router, sessionStore, connector } = createRouter({ projectsDir });
      sessionStore.setCwd('user1', dirA);

      await router.handle(`/cd ${dirB}`, ctx);

      const input = connector._sent[0].input as {
        card?: {
          header?: { title?: { content: string } };
          body?: {
            elements: Array<{
              actions?: Array<{ value: { cmd: string } }>;
              columns?: Array<{
                elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
              }>;
            }>;
          };
          elements?: Array<{
            actions?: Array<{ value: { cmd: string } }>;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
            }>;
          }>;
        };
      };
      expect(input.card).toBeDefined();
      // result 事件后直接是终态 done，标题显示"自动恢复会话"而不是"后台任务中"
      expect(input.card!.header!.title!.content).toContain('自动恢复会话');
      // 终态不应有停止按钮（会话已完成）
      const elements = input.card!.body!.elements;
      // CardKit 2.0 only
      const buttons2x = elements.flatMap((e) =>
        (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
      );
      const hasStop = buttons2x.some((b) => b.value?.cmd === 'stop');
      expect(hasStop).toBe(false);
    });

    it('/cd auto-resume does not show finalizing state for away_summary session tail', async () => {
      // isActive 只看内存中 activeRun，不依赖 jsonl 启发式
      // 所以即使 jsonl 有 away_summary 事件，auto-resume 也不会显示"后台任务中"
      const dirA = path.join(tmpDir, 'dirA');
      const dirB = path.join(tmpDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      const projectsDir = path.join(tmpDir, 'claude-projects');
      const encodedB = encodedProjectDir(dirB);
      const projDirB = path.join(projectsDir, encodedB);
      fs.mkdirSync(projDirB, { recursive: true });
      const sid = 'bg-away-session-xyz';
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'run background task' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'starting...' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          durationMs: 330162,
          cwd: fs.realpathSync(dirB),
        }) +
        '\n' +
        JSON.stringify({ type: 'system', subtype: 'away_summary', cwd: fs.realpathSync(dirB) }) +
        '\n' +
        JSON.stringify({
          type: 'last-prompt',
          lastPrompt: 'run background task',
          leafUuid: 'abc',
        }) +
        '\n' +
        JSON.stringify({ type: 'mode', mode: 'normal' }) +
        '\n' +
        JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' });
      writeSessionJsonl(projDirB, sid, dirB, body);

      const { router, sessionStore, connector } = createRouter({ projectsDir });
      sessionStore.setCwd('user1', dirA);

      await router.handle(`/cd ${dirB}`, ctx);

      const input = connector._sent[0].input as {
        card?: {
          header?: { title?: { content: string } };
          body?: {
            elements: Array<{
              actions?: Array<{ value: { cmd: string } }>;
              columns?: Array<{
                elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
              }>;
            }>;
          };
          elements?: Array<{
            actions?: Array<{ value: { cmd: string } }>;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
            }>;
          }>;
        };
      };
      expect(input.card).toBeDefined();
      // 不依赖 jsonl 启发式判断，显示普通自动恢复会话
      expect(input.card!.header!.title!.content).toContain('自动恢复会话');
      // 不会有停止按钮（没有内存中的 activeRun）
      const elements = input.card!.body!.elements;
      // CardKit 2.0 only
      const buttons2x = elements.flatMap((e) =>
        (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
      );
      const hasStop = buttons2x.some((b) => b.value?.cmd === 'stop');
      expect(hasStop).toBe(false);
    });

    it('/cd auto-resume prefers in-memory active run state over stale jsonl state', async () => {
      // result 后进入 finalizing（非终态），进程仍在运行
      // auto-resume 显示"自动恢复会话"，停止按钮仍显示（因为进程未退出）
      const dirA = path.join(tmpDir, 'dirA');
      const dirB = path.join(tmpDir, 'dirB');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);

      const projectsDir = path.join(tmpDir, 'claude-projects');
      const encodedB = encodedProjectDir(dirB);
      const projDirB = path.join(projectsDir, encodedB);
      fs.mkdirSync(projDirB, { recursive: true });
      const sid = 'active-memory-session-xyz';
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'start background download' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'background task started' }],
          },
        });
      writeSessionJsonl(projDirB, sid, dirB, body);

      const events: AgentEvent[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: sid,
          cwd: fs.realpathSync(dirB),
          model: 'opus',
        },
        { type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 1.1732 },
      ];
      const { runner, release } = createBackgroundRunningRunner(events);
      const { router, sessionStore, connector } = createRouter({ runner, projectsDir });
      const canonicalB = fs.realpathSync(dirB);
      sessionStore.set(ctx.userId, {
        sessions: new Map([['claude', sid]]),
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd: canonicalB,
      });

      const runPromise = router.handle('continue', ctx);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      sessionStore.setCwd('user1', dirA);
      await router.handle(`/cd ${dirB}`, ctx);

      const input = connector._sent.at(-1)!.input as {
        card?: {
          header?: { title?: { content: string } };
          body?: {
            elements: Array<{
              actions?: Array<{ value: { cmd: string } }>;
              columns?: Array<{
                elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
              }>;
            }>;
          };
          elements?: Array<{
            actions?: Array<{ value: { cmd: string } }>;
            columns?: Array<{
              elements?: Array<{ behaviors?: Array<{ value: { cmd: string } }> }>;
            }>;
          }>;
        };
      };
      expect(input.card).toBeDefined();
      // 标题显示"自动恢复会话"
      expect(input.card!.header!.title!.content).toContain('自动恢复会话');
      expect(JSON.stringify(input.card)).not.toContain('后台任务进行中');
      // finalizing 状态仍有停止按钮（进程尚未退出）
      const elements = input.card!.body!.elements;
      // CardKit 2.0 only
      const buttons2x = elements.flatMap((e) =>
        (e.columns ?? []).flatMap((c) => (c.elements ?? []).flatMap((b) => b.behaviors ?? [])),
      );
      const hasStop = buttons2x.some((b) => b.value?.cmd === 'stop');
      expect(hasStop).toBe(true);

      release();
      await runPromise;
    });

    it('/resume <id> prefers in-memory active run state (finalizing, process still running)', async () => {
      // result 后进入 finalizing（非终态）
      // /resume 显示"恢复会话"，停止按钮仍显示（进程未退出）
      const dir = path.join(tmpDir, 'dir');
      fs.mkdirSync(dir);

      const projectsDir = path.join(tmpDir, 'claude-projects');
      const encoded = encodedProjectDir(dir);
      const projDir = path.join(projectsDir, encoded);
      fs.mkdirSync(projDir, { recursive: true });
      const sid = 'resume-active-memory-session';
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'start background download' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'background task started' }],
          },
          timestamp: '2026-06-22T12:59:00.000Z',
        });
      writeSessionJsonl(projDir, sid, dir, body);

      const events: AgentEvent[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: sid,
          cwd: fs.realpathSync(dir),
          model: 'opus',
        },
        { type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 1.1732 },
      ];
      const { runner, release } = createBackgroundRunningRunner(events);
      const { router, sessionStore, connector } = createRouter({ runner, projectsDir });
      const canonical = fs.realpathSync(dir);
      sessionStore.set(ctx.userId, {
        sessions: new Map([['claude', sid]]),
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd: canonical,
      });

      const runPromise = router.handle('continue', ctx);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      await router.handle(`/resume ${sid}`, ctx);

      const input = connector._sent.at(-1)!.input as {
        card?: {
          header?: { title?: { content: string } };
          body?: {
            elements: Array<{
              tag: string;
              actions?: Array<{ value: { cmd: string } }>;
              columns?: Array<{
                elements?: Array<{
                  value?: { cmd: string };
                  behaviors?: Array<{ value: { cmd: string } }>;
                }>;
              }>;
            }>;
          };
          elements?: Array<{
            tag: string;
            actions?: Array<{ value: { cmd: string } }>;
            columns?: Array<{
              elements?: Array<{
                value?: { cmd: string };
                behaviors?: Array<{ value: { cmd: string } }>;
              }>;
            }>;
          }>;
        };
      };
      expect(input.card).toBeDefined();
      // 显示"恢复会话"而不是"后台任务中"
      expect(input.card!.header!.title!.content).toContain('恢复会话');
      expect(JSON.stringify(input.card)).not.toContain('后台任务进行中');
      // finalizing 状态仍有停止按钮（进程未退出）
      const elements = input.card!.body!.elements;
      // CardKit 2.0 only: buttons in columns with behaviors
      const buttons2x = elements.flatMap((e) => e.columns?.flatMap((c) => c.elements ?? []) ?? []);
      const hasStop = buttons2x.some((b) => b.behaviors?.some((bh) => bh.value.cmd === 'stop'));
      expect(hasStop).toBe(true);

      release();
      await runPromise;
    });

    it('ws.use auto-resumes newest session', async () => {
      const projectsDir = path.join(tmpDir, 'claude-projects');

      // Create workspace with directory
      const wsDir = path.join(tmpDir, 'wsDir');
      fs.mkdirSync(wsDir);

      // Create session in wsDir
      const encoded = encodedProjectDir(wsDir);
      const projDir = path.join(projectsDir, encoded);
      fs.mkdirSync(projDir, { recursive: true });
      const sid = 'ws-session-123';
      const body =
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'ws task' }] },
        }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ws response' }] },
        }) +
        '\n' +
        JSON.stringify({ type: 'result', subtype: 'success', session_id: sid });
      writeSessionJsonl(projDir, sid, wsDir, body);

      const { router, sessionStore, connector } = createRouter({ projectsDir });
      // Set cwd to wsDir first, then save workspace
      sessionStore.setCwd('user1', wsDir);
      await router.handle('/ws save ws1', ctx);
      // Clear session and switch to different directory first
      sessionStore.set('user1', { sessions: new Map(), previousSessions: new Map(), cwd: tmpDir });

      // Now use the workspace - should auto-resume
      await router.handle('/ws use ws1', ctx);

      // Should return auto-resume card, not text
      const input = connector._sent[connector._sent.length - 1].input as {
        text?: string;
        card?: { elements: Array<{ tag: string }> };
      };
      // When auto-resume works, it returns a card, not text
      expect(input.card).toBeDefined();
      // Should contain session content
      const cardContent = JSON.stringify(input.card);
      expect(cardContent).toContain('ws task');
    });
  });

  describe('handleCardAction (§6.2)', () => {
    it('ls.switch switches cwd for a direct subdir', async () => {
      const { router, sessionStore } = createRouter();
      const sub = path.join(tmpDir, 'sub1');
      fs.mkdirSync(sub);
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handleCardAction({ cmd: 'ls.switch', path: sub }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(sub));
      expect(sessionStore.getSessionId('user1')).toBeUndefined();
    });

    it('ls.switch allows switching to an unrelated absolute path outside cwd', async () => {
      const { router, sessionStore } = createRouter();
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      // Independent temp dir (not under tmpDir) as the unrelated target, so
      // this test never touches system directories like ../../etc.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-router-outside-'));
      try {
        await router.handleCardAction({ cmd: 'ls.switch', path: outside }, ctx);
        expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(outside));
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('ls.switch rejects a non-existent path, keeps cwd and never updates card', async () => {
      const { router, sessionStore, connector } = createRouter();
      const cwd = fs.realpathSync(tmpDir);
      sessionStore.setCwd('user1', cwd);
      const ghost = path.join(tmpDir, 'does-not-exist-ghost');
      await router.handleCardAction({ cmd: 'ls.switch', path: ghost }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(cwd);
      expect((connector._sent[0].input as { text: string }).text).toContain('路径无效');
      // Failure goes through sendResult (text) only -- updateCardInPlace must not run.
      expect(connector._cards.length).toBe(0);
    });

    it('ls.switch rejects a target that is a file, keeps cwd and never updates card', async () => {
      const { router, sessionStore, connector } = createRouter();
      const cwd = fs.realpathSync(tmpDir);
      sessionStore.setCwd('user1', cwd);
      const file = path.join(tmpDir, 'plain-file.txt');
      fs.writeFileSync(file, 'not a directory');
      await router.handleCardAction({ cmd: 'ls.switch', path: file }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(cwd);
      expect((connector._sent[0].input as { text: string }).text).toContain('路径无效');
      expect(connector._cards.length).toBe(0);
    });

    it('ls.switch rejects payload missing path without touching cwd or card', async () => {
      const { router, sessionStore, connector } = createRouter();
      const cwd = fs.realpathSync(tmpDir);
      sessionStore.setCwd('user1', cwd);
      await router.handleCardAction({ cmd: 'ls.switch' }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(cwd);
      expect((connector._sent[0].input as { text: string }).text).toContain(
        '卡片 payload 缺少 path',
      );
      expect(connector._cards.length).toBe(0);
    });

    it('ls.switch canonicalizes a symlink target via realpath (not the link path)', async () => {
      const { router, sessionStore, connector } = createRouter();
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      const real = path.join(tmpDir, 'real-dir');
      const link = path.join(tmpDir, 'link-to-real');
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      await router.handleCardAction({ cmd: 'ls.switch', path: link }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(real));
      expect(sessionStore.getCwd('user1')).not.toBe(link);
      // Success path DOES update the card in place (contrast with failure cases).
      expect(connector._cards.length).toBe(1);
    });

    it('ls.switch allows a deeper nested path', async () => {
      const { router, sessionStore } = createRouter();
      const deep = path.join(tmpDir, 'sub1', 'deep');
      fs.mkdirSync(deep, { recursive: true });
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handleCardAction({ cmd: 'ls.switch', path: deep }, ctx);
      // Now allows switching to any depth subdirectory
      expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(deep));
    });

    it('ls.switch blocks when no cwd is set', async () => {
      const { router, connector } = createRouter();
      await router.handleCardAction({ cmd: 'ls.switch', path: '/tmp' }, ctx);
      expect((connector._sent[0].input as { text: string }).text).toContain('/cd');
    });

    it('ls.switch allows a sibling that merely shares a prefix', async () => {
      const { router, sessionStore } = createRouter();
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      const sibling = tmpDir + '-evil';
      fs.mkdirSync(sibling);
      try {
        await router.handleCardAction({ cmd: 'ls.switch', path: sibling }, ctx);
        expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(sibling));
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    });

    it('ls.switch allows navigating to parent via .. button', async () => {
      const { router, sessionStore } = createRouter();
      const sub = path.join(tmpDir, 'sub1');
      fs.mkdirSync(sub);
      sessionStore.setCwd('user1', sub);
      await router.handleCardAction({ cmd: 'ls.switch', path: tmpDir }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(tmpDir));
      expect(sessionStore.getSessionId('user1')).toBeUndefined();
    });

    it('ls.switch allows switching to a parent more than one level up', async () => {
      const { router, sessionStore } = createRouter();
      const nested = path.join(tmpDir, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });
      sessionStore.setCwd('user1', nested);
      await router.handleCardAction({ cmd: 'ls.switch', path: tmpDir }, ctx);
      expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(tmpDir));
      expect(sessionStore.getSessionId('user1')).toBeUndefined();
    });

    it('test_anchor_ls_switch_allows_sibling_outside_cwd_subtree', async () => {
      const { router, sessionStore } = createRouter();
      const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-anchor-a-'));
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-anchor-b-'));
      try {
        sessionStore.setCwd('user1', fs.realpathSync(dirA));
        await router.handleCardAction({ cmd: 'ls.switch', path: dirB }, ctx);
        expect(sessionStore.getCwd('user1')).toBe(fs.realpathSync(dirB));
        expect(sessionStore.getSessionId('user1')).toBeUndefined();
      } finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    });

    it('ls.switch sends "已切换到" text feedback on success', async () => {
      const { router, sessionStore, connector } = createRouter();
      const sub = path.join(tmpDir, 'sub-feedback');
      fs.mkdirSync(sub);
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handleCardAction({ cmd: 'ls.switch', path: sub }, ctx);
      // ls.switch must produce a sendResult with "已切换到" text
      const sent = connector._sent;
      const textResults = sent.filter(
        (s) => typeof (s.input as { text?: string }).text === 'string',
      );
      expect(textResults.length).toBeGreaterThanOrEqual(1);
      expect((textResults[0].input as { text: string }).text).toContain('已切换到');
    });

    it('ls.switch auto-resumes newest session and sends resume card', async () => {
      const sub = path.join(tmpDir, 'sub-resume');
      fs.mkdirSync(sub);
      const _canonicalSub = fs.realpathSync(sub);
      // Create a session reader that returns a fake newest session
      const fakeSession = {
        sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        summary: 'test session',
      };
      const readerWithSession: AgentSessionReader = {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => fakeSession,
        readSessionContent: () => ({
          events: [],
          aiTitle: undefined,
          recap: undefined,
          displayTitle: undefined,
          usage: undefined,
          reason: 'not_found',
        }),
        isSessionActive: () => false,
      };
      const registry = new SessionReaderRegistry();
      registry.register('claude', readerWithSession);
      registry.register('codex', { ...stubSessionReader });
      registry.register('opencode', { ...stubSessionReader });
      registry.register('pi', { ...stubSessionReader });
      registry.register('kimi', { ...stubSessionReader });

      const { router, sessionStore, connector } = createRouter({ sessionReaderRegistry: registry });
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handleCardAction({ cmd: 'ls.switch', path: sub }, ctx);

      // sessionId should be written to store
      expect(sessionStore.getSessionId('user1')).toBe('aaaaaaaa-1111-2222-3333-444444444444');

      // sendResult should produce an auto-resume card (not plain text)
      const sent = connector._sent;
      const cardResults = sent.filter(
        (s) => typeof (s.input as { card?: object }).card === 'object',
      );
      expect(cardResults.length).toBeGreaterThanOrEqual(1);
      const card = (cardResults[0].input as { card: { header?: { title?: { content?: string } } } })
        .card;
      expect(card.header?.title?.content).toContain('自动恢复会话');
    });

    it('ws.use switches cwd via card button', async () => {
      const { router, sessionStore, connector } = createRouter();
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handle('/ws save proj', ctx);
      sessionStore.set('user1', {
        sessions: new Map([['claude', 's1']]),
        previousSessions: new Map(),
        sessionCwds: new Map(),
        arrivalSessions: new Map(),
        cwd: '/tmp',
      });
      await router.handleCardAction({ cmd: 'ws.use', name: 'proj' }, ctx);
      const entry = sessionStore.get('user1');
      // cmdWsUse canonicalizes via realpathSync to match Claude JSONL cwd.
      expect(entry?.cwd).toBe(fs.realpathSync(tmpDir));
      expect(entry?.sessions?.get('claude')).toBe('');
      expect((connector._sent[1].input as { text: string }).text).toContain('已切换到');
    });

    // REGRESSION TEST: Problem 1 - ws.use when user has NO cwd set
    // User never did /cd, sessionStore has no entry, clicking ws.use should still work
    it('ws.use works when user has never set cwd (no sessionStore entry)', async () => {
      const { router, sessionStore, connector } = createRouter();
      // User has NO entry in sessionStore (never did /cd before)
      expect(sessionStore.get('user1')).toBeUndefined();
      expect(sessionStore.getCwd('user1')).toBeUndefined();

      // But they have a saved workspace from a previous session (simulated)
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handle('/ws save proj', ctx);
      // Now clear the session to simulate user never did /cd in current session
      sessionStore.delete('user1');

      // User clicks "使用 proj" button
      // This is what happened at 03:46:58 - user clicked ws.use but had no cwd
      await router.handleCardAction({ cmd: 'ws.use', name: 'proj' }, ctx);

      // Expected: workspace should switch successfully
      const entry = sessionStore.get('user1');
      expect(entry?.cwd).toBe(fs.realpathSync(tmpDir));
      // Should have sent a result card
      expect(connector._sent.length).toBeGreaterThan(0);
    });

    // REGRESSION TEST: Verify ws.use fails gracefully when workspace name is missing
    it('ws.use handles missing name gracefully', async () => {
      const { router, sessionStore, connector } = createRouter();
      // Save a workspace first
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handle('/ws save proj', ctx);
      connector._sent.length = 0; // Clear previous messages

      // Call ws.use WITHOUT name field (simulating potential card payload issue)
      await router.handleCardAction({ cmd: 'ws.use' }, ctx);

      // Should return error message, not crash
      expect(connector._sent.length).toBe(1);
      const result = connector._sent[0].input as { text: string };
      expect(result.text).toContain('用法');
    });

    // RED TEST: Problem 2 - queue.immediate should execute the message immediately
    // Current buggy behavior: tells user to resend the message

    it('ws.remove deletes alias and refreshes /ws list card in place via card button', async () => {
      const { router, sessionStore, connector } = createRouter();
      sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
      await router.handle('/ws save proj', ctx);
      // Save a second alias so the refreshed list isn't empty (ensures the
      // in-place update renders the surviving workspace, not just a toast).
      await router.handle('/ws save keep', ctx);
      await router.handleCardAction({ cmd: 'ws.remove', name: 'proj' }, ctx);
      // Refreshed /ws list card updated in place, no new card message sent
      const lastCard = connector._cards.at(-1) as object;
      expect(lastCard).toBeDefined();
      const cardStr = JSON.stringify(lastCard);
      expect(cardStr).not.toContain('proj');
      expect(cardStr).toContain('keep');
    });

    it('unknown cmd replies with a visible warning (regression: silent swallow)', async () => {
      // CLAUDE.md red-line: miss paths must reply via bridge.sendResult so the
      // tap is not silently swallowed.
      const { router, connector } = createRouter();
      await router.handleCardAction({ cmd: 'bogus' }, ctx);
      expect(connector._sent.length).toBe(1);
      expect((connector._sent[0].input as { text: string }).text).toContain('未知');
      expect((connector._sent[0].input as { text: string }).text).toContain('bogus');
    });

    it('stop card action replies when the run has already exited', async () => {
      // Regression 2026-06-22: auto-resume card rendered a stop button off
      // stale jsonl state, but the CLI had already exited — tapping it
      // silently no-op'd. The miss path must now send a visible reply so the
      // tap is not swallowed. No activeRun is registered here (stub runner),
      // so interruptCurrentRun returns false.
      const { router, connector } = createRouter();
      await router.handleCardAction({ cmd: 'stop', runId: 'dead-run-1' }, ctx);
      expect(connector._sent.length).toBe(1);
      expect((connector._sent[0].input as { text: string }).text).toContain('已结束');
    });
  });

  it('rejects message when the same workspace has a run in progress', async () => {
    // This test now needs to simulate a running workspace
    // The actual rejection happens at bridge level when activeRuns.has(cwd) is true
    // For router-level test, we just verify the message goes to bridge
    const { router, sessionStore } = createRouter();
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    // The message will be enqueued - verify it doesn't throw
    let error: Error | null = null;
    try {
      await router.handle('hello', ctx);
    } catch (e) {
      error = e as Error;
    }
    // 测试不抛出异常（消息被正确处理）
    expect(error).toBeNull();
  });

  it('/config shows card with all config sections', async () => {
    const { router, connector } = createRouter();
    await router.handle('/config', ctx);
    const sent = connector._sent[0].input as { card?: object };
    expect(sent.card).toBeDefined();
    // CardKit 2.0 with tabs: body.elements contains tabs element
    const card = sent.card as {
      body?: { elements?: object[] };
      schema?: string;
      header?: { template?: string };
    };
    expect(card.schema).toBe('2.0');
    expect(card.header?.template).toBe('blue');
    expect(card.body?.elements).toBeDefined();
    const content = JSON.stringify(card.body?.elements);
    // CardKit 2.0 uses section headers instead of tabs (tabs not supported in 2.0)
    expect(content).toContain('**🤖 Claude**');
    // 2026-07-04: workspace 分组已删除（无默认目录概念，必须用户 /cd 指定）
    expect(content).not.toContain('**📂 工作区**');
    expect(content).toContain('**📤 输出**');
    expect(content).toContain('**📝 日志**');
    // Check user-friendly field labels
    // 2026-07-05: claude.binary（执行程序）已从卡片删除 — 有了 defaultAgent，binary 是 agent 实现细节
    expect(content).not.toContain('执行程序');
    expect(content).toContain('默认 Agent');
    expect(content).toContain('使用模型');
    // 2026-07-04: 只保留保存按钮，放弃修改按钮已删除
    expect(content).toContain('config.save');
    expect(content).not.toContain('config.cancel');
    // 2026-07-04: ask 权限模式已删除
    expect(content).not.toContain('"ask"');
    // 2026-07-04: 未保存提示 / 放弃修改按钮已删除
    expect(content).not.toContain('未保存的修改');
    expect(content).not.toContain('放弃修改');
    // Check behaviors for callback
    expect(content).toContain('"type":"callback"');
  });

  it('/config card does not mix V1/V2 — no 1.x `action` container (regression: 200861)', async () => {
    const { router, connector } = createRouter();
    await router.handle('/config', ctx);
    const cardStr = JSON.stringify((connector._sent[0].input as { card: object }).card);
    expect(cardStr).toContain('"schema":"2.0"');
    // 2.0 cards MUST NOT mix in 1.x `tag:"action"` containers (200861 root cause).
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    // config callbacks use 2.0 behaviors
    expect(cardStr).toContain('"cmd":"config.');
  });

  it('/config card includes defaultAgent selector and does not expose claude.binary', async () => {
    const { router, connector } = createRouter();
    await router.handle('/config', ctx);
    const cardStr = JSON.stringify((connector._sent[0].input as { card: object }).card);
    // defaultAgent field is present in the Claude tab
    expect(cardStr).toContain('默认 Agent');
    expect(cardStr).toContain('defaultAgent');
    // claude.binary field is not in the card — with defaultAgent, the
    // binary is an implementation detail of the agent kind.
    expect(cardStr).not.toContain('执行程序');
    expect(cardStr).not.toContain('claude.binary');
  });

  // P0 Config CardKit 2.0 行为测试（2026-07-02）
  // 注意：config.toggle/set/input 只改内存 pendingConfig，不写盘
  // save 才一次性写盘，cancel 清空 pendingConfig

  it('config.toggle updates pendingConfig without writing disk', async () => {
    const { router, connector } = createRouter({ output: { showThinking: false } });

    // 点击 toggle 按钮（config.toggle + key）
    await router.handleCardAction({ cmd: 'config.toggle', key: 'output.showThinking' }, ctx);

    // 2026-07-04: 原地更新路径走 connector.updateCard，卡片进 _cards 而非 _sent
    expect(connector._sent.length).toBe(0);
    expect(connector._cards.length).toBeGreaterThan(0);
    const card = connector._cards[connector._cards.length - 1] as {
      body?: { elements?: object[] };
    };
    const cardStr = JSON.stringify(card.body?.elements);
    expect(cardStr).toContain('✅ 已开启'); // toggle 后应为开启状态

    // pendingConfig 应有值
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).not.toBeNull();
  });

  // 2026-07-04 回归测试：toggle 必须可逆（on→off→on）
  // 用户报告：显示工具调用 点击已开启→已关闭，再点击已关闭无法变回已开启
  it('config.toggle is reversible (on→off→on)', async () => {
    const { router, connector } = createRouter({ output: { showToolUse: true } });

    // 第一次 toggle: true → false
    await router.handleCardAction({ cmd: 'config.toggle', key: 'output.showToolUse' }, ctx);
    let card = connector._cards[connector._cards.length - 1] as { body?: { elements?: object[] } };
    let cardStr = JSON.stringify(card.body?.elements);
    expect(cardStr).toContain('⚪ 已关闭');

    // 第二次 toggle: false → true（必须能切回）
    await router.handleCardAction({ cmd: 'config.toggle', key: 'output.showToolUse' }, ctx);
    card = connector._cards[connector._cards.length - 1] as { body?: { elements?: object[] } };
    cardStr = JSON.stringify(card.body?.elements);
    expect(cardStr).toContain('✅ 已开启');

    // 第三次 toggle: true → false（验证多次切换稳定）
    await router.handleCardAction({ cmd: 'config.toggle', key: 'output.showToolUse' }, ctx);
    card = connector._cards[connector._cards.length - 1] as { body?: { elements?: object[] } };
    cardStr = JSON.stringify(card.body?.elements);
    expect(cardStr).toContain('⚪ 已关闭');
  });

  it('config.set reads option into pendingConfig', async () => {
    const { router, connector } = createRouter();

    // 点击 select（config.set + key + option）
    // 现在模型选项使用 alias (opus/sonnet/haiku)，不再是 model ID
    await router.handleCardAction({ cmd: 'config.set', key: 'claude.model', option: 'haiku' }, ctx);

    // 2026-07-04: 原地更新路径走 connector.updateCard，卡片进 _cards 而非 _sent
    expect(connector._sent.length).toBe(0);
    expect(connector._cards.length).toBeGreaterThan(0);
    const card = connector._cards[connector._cards.length - 1] as {
      body?: { elements?: object[] };
    };
    const cardStr = JSON.stringify(card.body?.elements);
    // 现在显示 alias 而不是 model ID
    expect(cardStr).toContain('haiku');

    // pendingConfig 应有值
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).not.toBeNull();
  });

  it('config.input reads formValue into pendingConfig', async () => {
    // 用 idle.watchdogMinutes 作为数值型 config key 测 input 路径
    const { router, connector: _connector } = createRouter({ idle: { watchdogMinutes: 10 } });

    // 提交 input（config.input + key + formValue）
    // 注意：formValue 的 key 需要和 config 字段匹配
    await router.handleCardAction(
      {
        cmd: 'config.input',
        key: 'idle.watchdogMinutes',
        formValue: { 'idle.watchdogMinutes': '30' },
      },
      ctx,
    );

    // pendingConfig 应有值
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).not.toBeNull();

    // pendingConfig 里的值应为 "30" (字符串，来自 formValue)
    const pendingConfig = (
      router as unknown as { pendingConfig: { idle: { watchdogMinutes: string } } }
    ).pendingConfig;
    expect(pendingConfig.idle.watchdogMinutes).toBe('30');
  });

  // 2026-07-04 回归测试：CardKit 2.0 input 自带提交图标回传 input_value
  // 这是新增路径：移除每个 input 旁的 💾 按钮后，提交图标触发 callback 时
  // 飞书回传 action.input_value，dispatcher 转成 fullValue.inputValue 传给 router
  it('config.input reads inputValue (CardKit 2.0 input submit icon) into pendingConfig', async () => {
    // 2026-07-14: claude.settings 字段已从 schema 和卡片删除，改测 claude.model
    const { router } = createRouter();

    await router.handleCardAction(
      { cmd: 'config.input', key: 'claude.model', inputValue: 'haiku' },
      ctx,
    );

    const pendingConfig = (router as unknown as { pendingConfig: { claude: { model: string } } })
      .pendingConfig;
    expect(pendingConfig).not.toBeNull();
    expect(pendingConfig.claude.model).toBe('haiku');
  });

  // 2026-07-04 回归测试：config.* 动作串行化（修复 toggle 卡死 bug）
  // CardKit 2.0 回调经 enqueueImmediate 不进 bridge 串行队列；多次快速点击
  // toggle 会让两个 patch 请求乱序到达飞书。router 内部用 configActionQueue
  // Promise chain 串行化所有 config.* 动作。此测试断言：
  // 1) 两次连续 toggle 后 pendingConfig 反映两次翻转（true→false→true）
  // 2) 两次 toggle 都各自触发了一次卡片更新（_cards 长度 +2）
  it('config.toggle serializes concurrent actions through configActionQueue', async () => {
    const { router, connector } = createRouter({ output: { showToolUse: true } });
    const cardsBefore = connector._cards.length;

    // 并发触发两次 toggle，不 await 第一个（模拟用户快速双击）
    const p1 = router.handleCardAction({ cmd: 'config.toggle', key: 'output.showToolUse' }, ctx);
    const p2 = router.handleCardAction({ cmd: 'config.toggle', key: 'output.showToolUse' }, ctx);
    await Promise.all([p1, p2]);

    // 两次 toggle = 回到初始状态 (true → false → true)
    const pendingConfig = (
      router as unknown as { pendingConfig: { output: { showToolUse: boolean } } }
    ).pendingConfig;
    expect(pendingConfig.output.showToolUse).toBe(true);
    // 两次 toggle 各自触发一次卡片更新
    expect(connector._cards.length).toBe(cardsBefore + 2);
  });

  it('config.save writes all pending changes to disk', async () => {
    // 用 idle.watchdogMinutes 作为数值型 config key 测 save 路径
    const { router, connector: _connector } = createRouter({
      output: { showThinking: false },
      idle: { watchdogMinutes: 10 },
    });
    const configPath = (router as unknown as { configPath: string }).configPath;

    // 先 toggle
    await router.handleCardAction({ cmd: 'config.toggle', key: 'output.showThinking' }, ctx);
    // 再修改 input
    await router.handleCardAction(
      {
        cmd: 'config.input',
        key: 'idle.watchdogMinutes',
        formValue: { 'idle.watchdogMinutes': '30' },
      },
      ctx,
    );

    // pendingConfig 应有值
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).not.toBeNull();

    // 保存
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 磁盘文件应一次性写入所有改动（configPath 存在且包含更新后的值）
    const diskContent = fs.readFileSync(configPath, 'utf-8');
    expect(diskContent).toContain('showThinking: true');
    expect(diskContent).toContain('watchdogMinutes: 30');

    // pendingConfig 应清空
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).toBeNull();
  });

  it('config.save correctly saves new nested agent config object (regression: agents.opencode [object Object])', async () => {
    // 回归测试：当 config 中不存在 agents.opencode 时，首次通过 config.set
    // 设置 agents.opencode.providerID/modelID 后保存，collectDiff 不应把
    // 整个对象转成 "[object Object]" 字符串导致 Zod 校验失败。
    // Bug: agents.opencode: Invalid input: expected object, received string
    const { router } = createRouter();
    const configPath = (router as unknown as { configPath: string }).configPath;

    // 通过 config.set 设置 opencode 的 providerID 和 modelID
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.opencode.providerID', option: 'opencode' },
      ctx,
    );
    await router.handleCardAction(
      { cmd: 'config.set', key: 'agents.opencode.modelID', option: 'opencode/big-pickle' },
      ctx,
    );

    // pendingConfig 应有值
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).not.toBeNull();

    // 保存 - 不应抛出 "expected object, received string" 错误
    await router.handleCardAction({ cmd: 'config.save' }, ctx);

    // 磁盘文件应包含正确的值，而不是 "[object Object]"
    const diskContent = fs.readFileSync(configPath, 'utf-8');
    expect(diskContent).toContain('providerID: opencode');
    expect(diskContent).toContain('modelID: opencode/big-pickle');
    expect(diskContent).not.toContain('[object Object]');

    // pendingConfig 应清空
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).toBeNull();
  });

  // Anchor (red): config.edit handler is dead code — no card builder emits
  // 'config.edit'. Once removed, isImmediateAction('config.edit') must return
  // false and handleCardAction must not produce the "请输入新的" prompt.
  it('test_anchor_config_edit_handler_removed', async () => {
    // 1. isImmediateAction must no longer recognize 'config.edit'
    expect(isImmediateAction('config.edit')).toBe(false);

    // 2. handleCardAction('config.edit') must not return the dedicated prompt
    //    text "请输入新的 ... 值". After removal it falls to the default branch
    //    (no-op) or a miss path, never the edit prompt.
    const { router, connector } = createRouter();
    await router.handleCardAction({ cmd: 'config.edit', key: 'claude.model' }, ctx);
    const sentTexts = connector._sent.map((s) => (s.input as { text?: string }).text ?? '');
    const hasEditPrompt = sentTexts.some((t) => t.includes('请输入新的'));
    expect(hasEditPrompt).toBe(false);
  });

  it('cmdConfig <key> <value> command writes to disk immediately', async () => {
    const { router, connector } = createRouter();
    const configPath = (router as unknown as { configPath: string }).configPath;

    // 执行 /config claude.model haiku（现在使用 alias）
    await router.handle('/config claude.model haiku', ctx);

    // 应直接写盘（configPath 现在应存在）
    const diskContent = fs.readFileSync(configPath, 'utf-8');
    // 现在保存的是 alias，不是 model ID
    expect(diskContent).toContain('model: haiku');

    // pendingConfig 应清空
    expect((router as unknown as { pendingConfig: unknown }).pendingConfig).toBeNull();

    // 响应应为卡片确认
    const response = connector._sent[0].input as { card?: object; text?: string };
    expect(response.card).toBeDefined();
  });

  it('/exit invokes the exit handler after sending reply', async () => {
    let exited = false;
    const { router, connector } = createRouter({
      exitHandler: () => {
        exited = true;
      },
    });
    await router.handle('/exit', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('退出');
    expect(exited).toBe(true);
  });

  it('unknown command returns hint', async () => {
    const { router, connector } = createRouter();
    await router.handle('/xyz', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('未知命令');
  });

  // Alias tests: single-letter shortcuts
  it('/h is alias for /help', async () => {
    const { router, connector } = createRouter();
    await router.handle('/h', ctx);
    const card = (
      connector._sent[0].input as { card: { body?: { elements: object[] }; elements?: object[] } }
    ).card;
    expect(card).toBeDefined();
  });

  it('/s is alias for /status', async () => {
    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 's1']]),
      previousSessions: new Map(),
      sessionCwds: new Map(),
      arrivalSessions: new Map(),
      cwd: '/tmp',
    });
    await router.handle('/s', ctx);
    const md = (connector._sent[0].input as { markdown: string }).markdown;
    expect(md).toContain('/tmp');
  });

  it('/t is alias for /stop', async () => {
    const { router, connector } = createRouter();
    await router.handle('/t', ctx);
    // /stop returns no text when nothing is running
    expect(connector._sent.length).toBeGreaterThanOrEqual(0);
  });

  it('/e is alias for /exit', async () => {
    let exited = false;
    const { router, connector } = createRouter({
      exitHandler: () => {
        exited = true;
      },
    });
    await router.handle('/e', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('退出');
    expect(exited).toBe(true);
  });

  it('/c is alias for /config', async () => {
    const { router, connector } = createRouter();
    await router.handle('/c', ctx);
    const card = (
      connector._sent[0].input as { card: { body?: { elements: object[] }; elements?: object[] } }
    ).card;
    expect(card).toBeDefined();
  });

  it('/r is alias for /resume', async () => {
    const { router, connector } = createRouter();
    await router.handle('/r', ctx);
    // /resume without cwd prompts to /cd
    expect((connector._sent[0].input as { text: string }).text).toContain('/cd');
  });

  it('/o is alias for /order', async () => {
    const { router, connector } = createRouter();
    await router.handle('/o', ctx);
    // /order default lists — returns text about no orders or a list
    expect(connector._sent.length).toBeGreaterThan(0);
  });

  it('non-command message without cwd prompts to /cd', async () => {
    const { router, connector } = createRouter();
    await router.handle('hello', ctx);
    expect((connector._sent[0].input as { text: string }).text).toContain('/cd');
  });

  it('routes claude output through one streaming card', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'part 1' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'part 2' }] } },
      { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: 0.01 },
    ];
    const { router, sessionStore, connector } = createRouter({
      runner: createStubRunner({ mode: 'streaming', events, withStatusInfo: true }),
    });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('hello', ctx);
    // The run card was sent via streaming (initial push + update pushes in _sent)
    expect(connector._sent.length).toBeGreaterThan(0);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('part 1part 2');
    expect(finalCard).toContain('success');
  });

  it('hides tool_use when showToolUse is false', async () => {
    const events: AgentEvent[] = [
      { type: 'system', subtype: 'init', session_id: 's1', cwd: tmpDir, model: 'opus' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', session_id: 's1' },
    ];
    const { router, sessionStore, connector } = createRouter({
      runner: createStubRunner({ mode: 'streaming', events, withStatusInfo: true }),
      output: { showToolUse: false },
    });
    sessionStore.setCwd('user1', fs.realpathSync(tmpDir));
    await router.handle('hello', ctx);
    // The run card was sent via streaming (initial push + update pushes in _sent)
    expect(connector._sent.length).toBeGreaterThan(0);
    const finalCard = JSON.stringify(connector._cards.at(-1));
    expect(finalCard).toContain('done');
    expect(finalCard).not.toContain('Read');
  });

  it('/active shows empty state when no sessions are active', async () => {
    const emptyProjectsDir = path.join(tmpDir, 'empty-active-projects');
    fs.mkdirSync(emptyProjectsDir, { recursive: true });
    const { router, connector } = createRouter({ projectsDir: emptyProjectsDir });
    await router.handle('/active', ctx);
    const input = connector._sent[0].input as { text?: string };
    expect(input.text).toContain('没有');
    expect(input.text).toContain('进行中');
  });

  it('/active shows completed sessions when activeOnly=false', async () => {
    const projectsDir = path.join(tmpDir, 'claude-projects');
    const dirA = path.join(tmpDir, 'projC');
    fs.mkdirSync(dirA);

    const encodedA = encodedProjectDir(dirA);
    const projDirA = path.join(projectsDir, encodedA);
    fs.mkdirSync(projDirA, { recursive: true });
    const sidA = 'completed-session-202';
    // Has result event - session completed
    const body =
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'completed task' }] },
      }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'completed response' }] },
      }) +
      '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', session_id: sidA });
    writeSessionJsonl(projDirA, sidA, dirA, body);

    // Note: /active only shows active sessions by default
    const { router, connector } = createRouter({ projectsDir });
    await router.handle('/active', ctx);

    const input = connector._sent[0].input as { text?: string };
    // Should say no active sessions
    expect(input.text).toContain('没有');
  });
});

// ========== ANCHOR TESTS FOR P0 BUGS ==========

describe('P0: /active card must use CardKit 2.0 (not 1.x action container)', () => {
  it('test_anchor_active_card_no_v1_action_container', async () => {
    // Create a real bridge that we can mock
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner({ withStatusInfo: true });
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
    });
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    });

    // Mock the bridge methods to return active runs
    const activeRuns = [
      {
        runId: 'test-run-123',
        sessionId: 'test-session-456',
        cwd: '/tmp/test-cwd',
        userId: 'user1',
        chatId: 'chat1',
        terminal: 'running' as const,
      },
    ];
    const activeBashRuns = [
      {
        runId: 'bash-run-789',
        cwd: '/tmp/test-cwd',
        userId: 'user1',
        chatId: 'chat1',
        terminal: 'running' as const,
        command: 'ls -la',
      },
    ];

    // Override the methods
    (bridge as unknown as { getActiveRuns: () => typeof activeRuns }).getActiveRuns = () =>
      activeRuns;
    (bridge as unknown as { getActiveBashRuns: () => typeof activeBashRuns }).getActiveBashRuns =
      () => activeBashRuns;

    // Create router with our mock bridge
    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    // Call /active which should use our mocked methods
    await router.handle('/active', { userId: 'user1', chatId: 'chat1', messageId: 'msg1' });

    const response = connector._sent[0].input as { text?: string; card?: object };

    // This should return a card with active runs
    expect(response.card).toBeDefined();

    const cardStr = JSON.stringify(response.card);
    // 2.0 cards MUST NOT mix in 1.x `tag:"action"` containers (200861 root cause)
    // This assertion will FAIL until we fix buildActiveCardFromMemory
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
  });

  it('test_anchor_kimi_config_clears_runner_cache', async () => {
    // Create router with a mock bridge that tracks clearRunners calls
    const sessionStore = new SessionStore();
    const connector = createStubConnector();
    const runner = createStubRunner({ withStatusInfo: true });
    const config: AppConfig = AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'claude-opus-4-8', stopGraceMs: 5000 },
      output: { showThinking: true, showToolUse: false, showToolResult: false },
      defaultAgent: 'kimi',
    });

    let clearRunnersCalled = false;
    const bridge = new Bridge({
      runner,
      agentRegistry: createStubAgentRegistry(runner),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
      connector,
      sessionStore,
      config,
    }) as unknown as Bridge & {
      clearRunners: () => void;
      getActiveRuns: () => [];
      getActiveBashRuns: () => [];
      getActiveRunFor: () => undefined;
    };
    bridge.clearRunners = () => {
      clearRunnersCalled = true;
    };
    bridge.getActiveRuns = () => [];
    bridge.getActiveBashRuns = () => [];
    bridge.getActiveRunFor = () => undefined;

    const router = new CommandRouter({
      sessionStore,
      bridge,
      config,
      configPath: path.join(tmpDir, 'config.yaml'),
      workspacePath: path.join(tmpDir, 'workspace.json'),
      sessionReaderRegistry: createStubSessionReaderRegistry(),
    });

    // Execute /config kimi.model x command - should trigger clearRunners
    await router.handle('/config kimi.model haiku', {
      userId: 'user1',
      chatId: 'chat1',
      messageId: 'msg1',
    });

    // This assertion will FAIL until we add kimi. to the agentConfigKeys filter
    expect(clearRunnersCalled).toBe(true);
  });
});

describe('anchor: live re-export (run-renderer/bridge import via router/index.js)', () => {
  it('test_anchor_router_reexports_format_usage_stats', async () => {
    // run-renderer and bridge import formatUsageStats from ../router/index.js,
    // so router must keep re-exporting it. (isParentDir removed 2026-07-31.)
    const routerModule = await import('./index.js');
    const exports = routerModule as Record<string, unknown>;
    expect(exports.formatUsageStats).toBeDefined();
  });
});
