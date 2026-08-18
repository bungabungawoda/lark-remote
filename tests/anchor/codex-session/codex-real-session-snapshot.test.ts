/**
 * Integration anchor (L2, real-data snapshot): 用多线程会话的
 * rollout 文件快照验证修复后的主线程解析与 token 口径。
 *
 * 验证什么行为：
 *   `readCodexSessionContent` / `listCodexRollouts` 对同一 sessionId 的多个
 *   rollout 文件（主线程 + subagent A + subagent B）解析到**主线程文件**：
 *   usage per-turn = 主文件末条 `last_token_usage` 推导、
 *   累计 = 主文件末条 `total_token_usage` 推导、
 *   displayTitle 来自主文件用户消息；列表只出该 sessionId 一条主线程条目。
 *
 * 缺失/错误会导致什么：
 *   修复前 `getSessionIndex` 后写覆盖 + readdir 顺序漂移，会解析到 subagent
 *   文件——done 卡出现"累计 < 当前"且 Context 显示子代理线程错值。
 *   本测试用快照锁定"必须解析主线程文件"的契约，防止该缺陷回归。
 *
 * 说明：
 *   fixture 中 token 数值为真实值，逐字保留（脱敏红线的显式豁免，
 *   见测试约定）；其余字段已重写为合成数据。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  readCodexSessionContent,
  listCodexRollouts,
  clearSessionIndexCache,
} from '../../../src/session/codex/rollout-reader.js';

const FIXTURE_ROOT = path.resolve(process.cwd(), 'tests', 'fixtures', 'codex-token-scope');
const DAY_DIR = path.join(FIXTURE_ROOT, 'sessions', '2026', '01', '15');

const MAIN_FILE = 'rollout-2026-01-15T08-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl';
const SUBAGENT_A_FILE = 'rollout-2026-01-15T08-50-35-bbbbbbbb-5555-6666-7777-888888888888.jsonl';
const SUBAGENT_B_FILE = 'rollout-2026-01-15T08-53-04-cccccccc-9999-aaaa-bbbb-cccccccccccc.jsonl';

const MAIN_SID = 'aaaaaaaa-1111-2222-3333-444444444444';
// Must match the cwd embedded in the fixture JSONL files
const MAIN_CWD = '/home/user/project';

interface ParsedRollout {
  threadSource?: string;
  sessionId?: string;
  userMessages: string[];
  lastTokenUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  lastTotalUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

/** Parse a fixture rollout file the same way the reader consumes it. */
function parseFixture(fileName: string): ParsedRollout {
  const raw = fs.readFileSync(path.join(DAY_DIR, fileName), 'utf8');
  const out: ParsedRollout = { userMessages: [] };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as {
      type: string;
      payload?: {
        type?: string;
        session_id?: string;
        thread_source?: string;
        message?: string;
        info?: Record<string, unknown>;
      };
    };
    if (o.type === 'session_meta' && o.payload) {
      out.threadSource = o.payload.thread_source;
      out.sessionId = o.payload.session_id;
    } else if (o.type === 'event_msg' && o.payload?.type === 'user_message') {
      out.userMessages.push(String(o.payload.message));
    } else if (o.type === 'event_msg' && o.payload?.type === 'token_count') {
      const info = o.payload.info ?? {};
      const last = info.last_token_usage as ParsedRollout['lastTokenUsage'];
      const total = info.total_token_usage as ParsedRollout['lastTotalUsage'];
      if (last) out.lastTokenUsage = last;
      if (total) out.lastTotalUsage = total;
    }
  }
  return out;
}

describe('codex 真实长会话快照：主线程解析与 token 口径（L2 集成）', () => {
  beforeEach(() => {
    clearSessionIndexCache();
  });
  afterEach(() => {
    clearSessionIndexCache();
  });

  it('test_anchor_codex_real_session_read_resolves_main_thread_file', () => {
    const main = parseFixture(MAIN_FILE);
    const subagentA = parseFixture(SUBAGENT_A_FILE);
    const subagentB = parseFixture(SUBAGENT_B_FILE);

    // fixture 自证：三个文件共享 sessionId，且 subagent 文件携带线程标记
    expect(subagentA.sessionId).toBe(MAIN_SID);
    expect(subagentB.sessionId).toBe(MAIN_SID);
    expect(main.threadSource).toBe('user');
    expect(subagentA.threadSource).toBe('subagent');
    expect(subagentB.threadSource).toBe('subagent');

    const content = readCodexSessionContent(MAIN_SID, { codexHome: FIXTURE_ROOT });
    const u = content.usage;

    // per-turn 来自主文件末条 last_token_usage（fixture 值：
    // input 471150 - cached 470912 = 238 / output 660 / total 471810）
    expect(u?.inputTokens).toBe(238);
    expect(u?.outputTokens).toBe(660);
    expect(u?.cacheReadTokens).toBe(470912);
    expect(u?.totalTokens).toBe(471810);
    expect(u?.contextLength).toBe(471150);

    // 累计来自主文件末条 total_token_usage（input 120076868 - cached 119504896
    // = 571972），而不是 subagent 的冻结快照
    expect(u?.cumulativeInputTokens).toBe(571972);
    expect(u?.cumulativeOutputTokens).toBe(274449);
    expect(u?.cumulativeCacheReadTokens).toBe(119504896);
    expect(u?.cumulativeTotalTokens).toBe(120351317);
    expect(u?.cumulativeTotalTokens).not.toBe(subagentA.lastTotalUsage!.total_tokens);
    expect(u?.cumulativeTotalTokens).not.toBe(subagentB.lastTotalUsage!.total_tokens);

    // displayTitle 来自主文件最后一条真实用户消息（reader 不截断，消费侧统一截断）
    const lastUserMsg = main.userMessages[main.userMessages.length - 1];
    expect(lastUserMsg).toBeTruthy();
    expect(content.displayTitle).toBe(lastUserMsg);
  });

  it('test_anchor_codex_real_session_list_dedupes_to_main_thread', () => {
    const main = parseFixture(MAIN_FILE);
    const result = listCodexRollouts({
      codexHome: FIXTURE_ROOT,
      cwd: MAIN_CWD,
      limit: 50,
    });

    // 该 sessionId 只出 1 条主线程条目（subagent 文件被排除，不因 cwd 相同而混入）
    const matches = result.entries.filter((e) => e.threadId === MAIN_SID);
    expect(matches).toHaveLength(1);
    expect(matches[0].firstUserMessage).toBe(main.userMessages[0].slice(0, 200));
  });
});
