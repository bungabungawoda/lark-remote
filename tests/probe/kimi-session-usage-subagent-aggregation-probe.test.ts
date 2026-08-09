/**
 * Probe: kimi session 的 subagent（agents/agent-N/wire.jsonl）token 消耗未计入
 * session 整体 usage —— 卡片只显示 main agent 的用量，严重低估 session 真实成本
 *
 * 攻击点：src/session/kimi/sessions.ts:244 硬编码只读
 *   `<sessionDir>/agents/main/wire.jsonl`（同模式另见 :397、:514）。
 *   但 kimi 的真实 session 目录结构是 `agents/main/` + `agents/agent-0..N/`
 *   （Task 工具派生的 subagent 各自落一份 wire.jsonl，同属一个 sessionDir）。
 *
 * 后果：在 Task 重度 session 中，subagent 消耗未计入会显著低估 session 整体
 *   成本，用户依据卡片判断会话成本会被严重误导——与 R1（只取末条 record）
 *   同属"usage 低估误导计费判断"缺陷类。
 *
 * 假设来源 = spec 精神外推（spec 未明说 subagent 是否计入——spec 缺口）：
 *   subagent 的 wire.jsonl 物理上位于同一 sessionDir 下、由同一 session 的
 *   Task 调用产生、同一计费主体——是"整个 session 整体"的组成部分；ccusage
 *   对 Claude Code transcript 的聚合同样不剔除 sidechain（subagent）消息。
 *   因此 session 级聚合应覆盖 `agents/*\/wire.jsonl` 全体。main 的 usage.record
 *   与 main 的 step.end.usage 一一对应（同值），subagent record 数值独立于
 *   main，不存在 main 已折叠 subagent 成本的情况（已排除双重计数嫌疑）。
 *
 * 期望行为（当前 RED）：
 *   - inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens/totalTokens
 *     = 全 session（main + 所有 agent-N）所有 usage.record 的 Σ；
 *   - contextLength 仍取 **main** 末条 record 的 (inputOther+output+inputCacheRead)
 *     ——上下文占用是"用户对话主窗口"语义，subagent 的上下文是独立窗口，不可混入
 *     （与 R1 锁定的"末条、不可求和"语义一致，只是限定在 main）。
 *   修复落点建议（绿 agent 参考，非强制）：readSessionContent 聚合时枚举
 *   `agents/*\/wire.jsonl`，可求和字段跨文件累加，contextLength 仅取 main；
 *   展示事件（events/displayTitle）维持 main 来源不变（subagent 细节已由 main
 *   流程里的 Task 工具调用呈现）。isSessionActive(:397)/列表(:514) 是否同步
 *   调整由绿 agent 判断，本 probe 只锁定 usage 聚合语义。
 *
 * fixture：tmp 目录构造 main（2 条 record）+ agent-0/agent-1（各 1 条 record），
 *   数值设计为可区分"仅 main"（inputTokens=4000）与"全 session"（=34000）。
 *   用真实 KimiSessionReader 实现而非 mock（同 tests/anchor/kimi/kimi-session-usage-aggregation.test.ts 模式）。
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

function usageRecordLine(
  usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number },
  time: number,
): string {
  return JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/k3',
    usage,
    usageScope: 'turn',
    time,
  });
}

describe('KimiSessionReader usage aggregation must cover subagent wire.jsonl files (probe)', () => {
  let kimiDir: string;
  let cwd: string;
  let sessionDir: string;
  let reader: KimiSessionReader;

  beforeEach(() => {
    kimiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-subagent-agg-kimi-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-subagent-agg-cwd-'));
    sessionDir = path.join(kimiDir, 'session_x');
    // kimi session 结构：agents/main + agents/agent-0 + agents/agent-1
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'agents', 'agent-0'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'agents', 'agent-1'), { recursive: true });

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

  it('test_probe_kimi_usage_aggregates_subagent_wire_files_session_wide', () => {
    // main 末条 record 的 inputOther+inputCacheRead+inputCacheCreation = 3000+7000+400 = 10400，
    // 用于断言 contextLength 只取 main（不混入 subagent、不求和；excludes output，review P2-8）。
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      [
        usageRecordLine(
          { inputOther: 1000, output: 100, inputCacheRead: 5000, inputCacheCreation: 200 },
          1784380436258,
        ),
        usageRecordLine(
          { inputOther: 3000, output: 300, inputCacheRead: 7000, inputCacheCreation: 400 },
          1784380436259,
        ),
      ].join('\n') + '\n',
    );
    // subagent 的 record 同属本 session（Task 工具派生），必须计入整体成本。
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'),
      usageRecordLine(
        { inputOther: 10000, output: 1000, inputCacheRead: 20000, inputCacheCreation: 2000 },
        1784380436300,
      ) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl'),
      usageRecordLine(
        { inputOther: 20000, output: 2000, inputCacheRead: 30000, inputCacheCreation: 3000 },
        1784380436400,
      ) + '\n',
    );

    const content = reader.readSessionContent('session_x', cwd);
    const usage = content.usage;

    expect(usage, 'readSessionContent 应返回 usage').toBeDefined();

    // 核心断言（当前 RED：实现只读 main → inputTokens=4000）：
    // 整个 session 的 token 成本 = main + 所有 subagent 的 Σ。
    expect(
      usage!.inputTokens,
      'inputTokens 应为全 session Σ(main 4000 + agent-0 10000 + agent-1 20000)，' +
        'subagent 消耗同属本 session 计费；仅 main 是低估',
    ).toBe(34000);
    expect(usage!.outputTokens).toBe(3400); // 100+300 + 1000 + 2000
    expect(usage!.cacheReadTokens).toBe(62000); // 5000+7000 + 20000 + 30000
    expect(usage!.cacheCreationTokens).toBe(5600); // 200+400 + 2000 + 3000
    expect(usage!.totalTokens).toBe(105000); // 34000+3400+62000+5600

    // contextLength 语义守卫：上下文占用 = main 末条 record（用户主对话窗口），
    // 不跨 agent 求和、不取 subagent 末条（agent-1 末条会是 20000+2000+30000=52000）。
    expect(
      usage!.contextLength,
      'contextLength 应仍为 main 末条 record 的占用（3000+7000+400），subagent 上下文是独立窗口',
    ).toBe(10400);
  });
});
