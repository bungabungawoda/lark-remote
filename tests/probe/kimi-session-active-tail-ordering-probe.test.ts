/**
 * Probe: 已完成 turn（step.end 后追加 usage.record）不得被判定为「后台任务进行中」
 *
 * kimi 每完成一个 turn，wire.jsonl 的尾部固定为
 *   ... content.part → context.append_loop_event/step.end → usage.record
 * 即 usage.record 永远写在 step.end **之后**（已完成 session 尾部一致如此）。
 *
 * 缺陷（src/session/kimi/sessions.ts isSessionActive）：
 *   启发式只解析 wire.jsonl 的**最后一行**——「末行是 step.end ⇒ 会话已完成」。
 *   但真实末行是 usage.record（不是 context.append_loop_event），判断永不命中，
 *   函数在 STALE_MS（1h）窗口内对所有已完成 session 一律返回 true。
 *   函数自身注释即意图：「we'll consider it inactive if there's a step.end」——
 *   该意图因事件序假设错误而成为死代码。
 *
 * 用户可见后果（jsonl 驱动的卡片显示不一致，spec 范围）：
 *   bridge sendCompletionNotificationCard 读 session reader 的 isSessionActive
 *   来决定完成通知卡的渲染状态。run 刚结束（mtime 必新鲜）→ 误判 active →
 *   完成通知卡与刚显示 ✅ done 的 run 卡自相矛盾。
 *   （router 已改为只看内存 activeRun，不受影响。）
 *
 * 本 probe 用真实事件序 fixture 锁定：turn 完成（step.end + 尾随 usage.record）
 *   ⇒ isSessionActive === false 且 usage 聚合数据正常返回。
 * 双锁：尾随的 usage.record 仍是有效聚合数据（usage 正常返回），
 * 防止绿实现用「丢弃末行/忽略 usage.record」误伤 R1-R6 聚合语义。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KimiSessionReader } from '../../src/session/kimi/sessions.js';
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

describe('KimiSessionReader completed-turn tail ordering (step.end → usage.record)', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-tail-order-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-tail-order-cwd-'));
    sessionDir = path.join(kimiDir, 'session_x');
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });

    // reader 校验 state.workDir === fs.realpathSync(cwd)
    const realCwd = fs.realpathSync(cwd);

    fs.writeFileSync(
      path.join(kimiDir, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_x', sessionDir, workDir: realCwd }) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T01:00:00.000Z',
        title: 't',
        isCustomTitle: false,
        workDir: realCwd,
      }),
    );
    reader = new KimiSessionReader(kimiDir);
  });

  afterEach(() => {
    fs.rmSync(kimiDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('test_probe_kimi_completed_turn_trailing_usage_record_not_reported_as_finalizing', () => {
    // 已完成 turn 的事件序尾部：
    // turn.prompt → step.begin → content.part → step.end → usage.record（末行）
    const base = 1784380436258;
    const wireLines = [
      JSON.stringify({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'hello' }],
        origin: { kind: 'user' },
        time: base,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', step: 1 },
        time: base + 1,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'content.part', step: 1, part: { type: 'text', text: 'answer' } },
        time: base + 2,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          step: 1,
          usage: { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
        },
        time: base + 3,
      }),
      // 末行：usage.record —— kimi 在 step.end 之后落账
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
        usageScope: 'turn',
        time: base + 4,
      }),
    ];
    // 文件刚写入 → mtime 新鲜（< STALE_MS 1h），复现「run 刚结束就发完成通知卡」场景
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      wireLines.join('\n') + '\n',
    );

    // 主断言：turn 已完成（step.end 已落盘），session 不得报告为后台运行中
    expect(
      reader.isSessionActive('session_x', cwd),
      'step.end 已落盘的 session 应判定为已完成（末行尾随 usage.record 不代表仍在运行）',
    ).toBe(false);

    const content = reader.readSessionContent('session_x', cwd);

    // 双锁：尾随 usage.record 仍是有效数据，R1 聚合语义不受影响
    expect(content.usage?.inputTokens, '尾随 usage.record 必须仍计入聚合').toBe(3000);
    expect(content.usage?.totalTokens).toBe(3000 + 300 + 7000 + 400);
  });
});
