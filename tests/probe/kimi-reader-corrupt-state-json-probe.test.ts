/**
 * Probe: KimiSessionReader 遇损坏 state.json 不应把异常抛给 router 卡片路径
 *
 * 攻击点（方向 3：reader 异常路径穿透）：src/session/kimi/sessions.ts
 * readSessionContent 在 try/catch（L249 才开启）之外执行两处可抛操作：
 *   L236  JSON.parse(fs.readFileSync(statePath))   — state.json 截断/损坏即抛 SyntaxError
 *   L237  fs.realpathSync(cwd)                     — cwd 被删除即抛 ENOENT
 * 调用侧后果（卡片口径一致性，spec「所有卡片的显示一致性」范围）：
 *   - router cmdResume（router/index.ts:2617）与 readSessionDisplayState
 *     （router/index.ts:1965，/resume 卡与 auto-resume 卡）均无 catch，
 *     executeCommand（router/index.ts:1492）dispatch 亦无 catch → /resume 直接
 *     崩掉，整张卡片（含 wire.jsonl 里完好无损的 session 聚合 usage）无法渲染；
 *   - bridge resolveFinalUsage（bridge/index.ts:1261）与
 *     sendCompletionNotificationCard（bridge/index.ts:1274）有 catch → 同类卡片幸存。
 *   同一 session、同一份 wire.jsonl，终态卡能显示全 session 聚合，/resume 卡却
 *   崩溃——这正是 spec 要消灭的卡片间自相矛盾（A 卡显示总量、B 卡直接消失）。
 *
 * 文件内自证契约：同文件 listSessions（sessions.ts:164）解析 state.json 时包在
 * 逐条 try/catch 里；readSessionContent 自身的错误契约（sessions.ts:410-413）也是
 * 「返回 reason: 'export_corrupt'，绝不 throw」，且 router 侧已有
 * buildExportCorruptCard（router/index.ts:2637）承接该降级。唯独 L234-241 的
 * cwd 校验段漏在保护之外。
 *
 * fixture：wire.jsonl 完全合法（2 条 usage.record + 1 条文本事件），
 * state.json 为 CLI 崩溃半截写入的截断 JSON。
 *
 * 期望（不指定 green 修复形态，只锁定降级契约）：
 *   1. readSessionContent 不 throw；
 *   2. 返回 SessionContent 形态（events 为数组）；
 *   3. 要么 wire 聚合幸存（outputTokens === 300），要么按既有契约
 *      reason === 'export_corrupt' 降级。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KimiSessionReader } from '../../src/session/kimi/sessions.js';
import type { SessionContent } from '../../src/runner/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

describe('KimiSessionReader with corrupt state.json (truncated CLI write)', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-corrupt-state-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-corrupt-state-cwd-'));
    sessionDir = path.join(kimiDir, 'session_x');
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });

    const realCwd = fs.realpathSync(cwd);

    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_x', sessionDir, workDir: realCwd }) + '\n',
    );
    // 损坏形态：kimi CLI 崩溃/被杀时 state.json 半截写入的截断 JSON
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      '{"createdAt":"2026-07-18T00:00:00.000Z","workDir":"/',
    );

    // wire.jsonl 完好：session 聚合数据本身没有任何问题
    const wireLines = [
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
        time: 1784380436258,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'hello' } },
        time: 1784380436259,
      }),
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: { inputOther: 2000, output: 200, inputCacheRead: 6000, inputCacheCreation: 400 },
        time: 1784380436260,
      }),
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      wireLines.join('\n') + '\n',
    );

    reader = new KimiSessionReader(kimiDir);
  });

  afterEach(() => {
    fs.rmSync(kimiDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test_probe_kimi_reader_corrupt_state_json_does_not_throw_into_router_card_path', () => {
    let thrown: unknown;
    let content: SessionContent | undefined;
    try {
      content = reader.readSessionContent('session_x', cwd);
    } catch (err) {
      thrown = err;
    }

    // 主钉：reader 契约是「降级，不 throw」（同文件 listSessions 与 L410-413 自证）。
    // 一旦 throw，无 catch 的 /resume 与 auto-resume 卡片路径整体崩溃。
    expect(
      thrown,
      `readSessionContent 不应把 ${String((thrown as Error)?.name)} 抛给 router 卡片路径（/resume、auto-resume 卡会因无关的 state.json 损坏而丢失整张卡片）`,
    ).toBeUndefined();
    expect(content, 'readSessionContent 必须返回 SessionContent').toBeDefined();
    expect(Array.isArray(content!.events), 'events 必须为数组').toBe(true);

    // 降级契约：跳过损坏的 state.json 继续读 wire -> 全 session 聚合幸存。
    // （export_corrupt 降级路径与 reason 字段已于 2026-07-20 移除。）
    const wireAggregateSurvived = content!.usage?.outputTokens === 300; // 100+200
    expect(
      wireAggregateSurvived,
      `损坏 state.json 下应保留 wire 聚合（outputTokens=300）；实际 usage=${JSON.stringify(content!.usage)}`,
    ).toBe(true);
  });
});
