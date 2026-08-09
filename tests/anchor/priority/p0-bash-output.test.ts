/**
 * Anchor Tests: P0-2 — `!` bash 输出四层修复
 *
 * B1: BashCardSession 在 store 时截断 output/stderr（内存无界 → 有界）
 * B2: 高频 update 合批（PATCH 风暴 → 100ms coalesce）
 * B3: BashProcessRunner 背压（stdout/stderr 队列有界，pause/resume）
 * B4: bridge 全流程集成（patch 数 < 100 且终态 output 有界）
 *
 * Spec 依据：review.md §P0-2「! bash 输出：内存无界 + CPU O(n²) + 飞书 PATCH 风暴 +
 * runner 队列无背压」；修复建议四处联动：store-time 截断（24~64KB，保留尾部）、
 * BashCardSession 合批（同 RunCardSession 100ms）、runner pause/resume 背压
 * （参照 jsonl-stream.ts）、bridge 侧 output 有界。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CardStreamController } from '@larksuite/channel';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  BashCardSession,
  capBashOutput,
  BASH_OUTPUT_STORE_CAP,
} from '../../../src/card/bash-card-session.js';
import { renderBashCard } from '../../../src/card/bash-renderer.js';

const { mockSpawn, mockLogger } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { BashProcessRunner } from '../../../src/runner/bash/index.js';

/**
 * Fake ChildProcess：stdout/stderr 用真实 PassThrough（有 isPaused/pause/resume 语义），
 * proc 本身是 EventEmitter（exit/error 事件）。与 tests/anchor/bash-card/bash-runner-event-driven.test.ts 的
 * EventEmitter 版不同——背压断言需要真实 Readable 的 pause 状态。
 */
function createFakeProcWithStreams(pid = 12345) {
  const proc = new EventEmitter() as unknown as {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => true;
  return proc;
}

function emitExit(
  proc: ReturnType<typeof createFakeProcWithStreams>,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  proc.exitCode = code;
  proc.signalCode = signal;
  proc.emit('exit', code, signal);
}

async function nextWithTimeout(
  gen: AsyncGenerator<unknown>,
  ms: number,
): Promise<IteratorResult<unknown> | 'timeout'> {
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));
  return Promise.race([gen.next(), timeout]);
}

function makeController(capture: { updates: object[] }): CardStreamController {
  return {
    messageId: 'card-1',
    current: {},
    update: async (card) => {
      capture.updates.push(typeof card === 'function' ? card({}) : card);
    },
  };
}

function makeConnector(controller: CardStreamController) {
  return {
    streamCard: async (
      _chatId: string,
      _initial: object,
      producer: (ctrl: CardStreamController) => Promise<void>,
    ) => {
      await producer(controller);
      return 'card-1';
    },
    updateCard: async () => {},
  };
}

describe('P0-2 B1: bash 输出 store-time 截断', () => {
  it('test_anchor_bash_output_capped_at_store_time', async () => {
    // ① 验证什么行为：`session.update({ output: 1MB })` 后 currentState.output 必须
    //    ≤ 24_000 字符；finish 的 meta.output/meta.stderr（bridge 结束路径再次传入）
    //    同样被截断。② 缺失后果：!yes / !cat 大文件每秒数百 MB 全量驻留 session state
    //    + bridge 本地变量，几十秒 V8 OOM（进程崩溃 → 单例锁释放 → watchdog 重启循环）。
    //    ③ 依据：review.md §P0-2 层①「内存无界」+ 修复建议①「store-time 截断，
    //    保留尾部，上限如 24~64KB」（契约值取区间下界 24_000 字符）。
    const capture = { updates: [] as object[] };
    const connector = makeConnector(makeController(capture));
    const session = new BashCardSession({
      connector,
      chatId: 'c',
      replyTo: 'm',
      runId: 'r',
      command: 'yes',
    });
    const big = 'x'.repeat(1_000_000);
    await session.update({ output: big });
    expect(session.currentState.output.length).toBeLessThanOrEqual(24_000);

    // bridge 结束时 finish({ output, stderr }) 会再次传入全量字符串，同样必须截断
    await session.finish('done', { exitCode: 0, output: big, stderr: big });
    expect(session.currentState.output.length).toBeLessThanOrEqual(24_000);
    expect(session.currentState.stderr.length).toBeLessThanOrEqual(24_000);
    await session.settle();
  });
});

describe('P0-2 B2: bash 高频输出合批', () => {
  it('test_anchor_bash_high_frequency_updates_coalesce_patches', async () => {
    // ① 验证什么行为：同一 coalesce 窗口内 100 次连续 update 只触发少量 controller
    //    update（< 100）。② 缺失后果：BashCardSession.update 每 chunk 立即 patch——
    //    SDK 侧 throttle「100ms 或 ≥50 chars 立即 fire」，输出洪峰几乎每个 chunk
    //    立即 PATCH（实际 10+/s），叠加 99991400 限流即 PATCH 风暴；对照 RunCardSession
    //    有 100ms 合批窗口。③ 依据：review.md §P0-2 层③「PATCH 风暴：BashCardSession.update
    //    没有 RunCardSession 的 100ms 合批」+ 修复建议②「给 BashCardSession 加与
    //    RunCardSession 相同的 coalesce 窗口」。
    const capture = { updates: [] as object[] };
    const connector = makeConnector(makeController(capture));
    const session = new BashCardSession({
      connector,
      chatId: 'c',
      replyTo: 'm',
      runId: 'r',
      command: 'yes',
    });
    await session.start();
    for (let i = 0; i < 100; i++) {
      await session.update({ output: `chunk-${i}\n` });
    }
    await session.finish('done', { exitCode: 0, output: 'done' });
    await session.settle();
    expect(capture.updates.length).toBeLessThan(100); // 现状 == 100（+initial/finish）
  });
});

describe('P0-2 B3: bash runner 背压', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_bash_runner_pauses_stdout_when_queue_exceeds_high_water', async () => {
    // ① 验证什么行为：快生产者（!yes 级别）在消费者不拉取时，stdout 队列超过高水位
    //    后必须 proc.stdout.pause()——内存有界；消费者 drain 到低水位后 resume。
    //    ② 缺失后果：data 事件持续 push 无界队列（消费速度受卡片更新节流/网络 RTT
    //    限制，两者解耦），!yes 每秒数百 MB，几十秒 V8 OOM。对比 claude 路径有
    //    jsonl-stream 的 pause/resume 背压（jsonl-stream.ts:105-119）。
    //    ③ 依据：review.md §P0-2 层④「生产侧无背压」+ 修复建议③「bash runner 参照
    //    jsonl-stream.ts 加 pause/resume：队列深度超阈值 pause，drain 到低水位 resume」。
    const proc = createFakeProcWithStreams();
    mockSpawn.mockReturnValue(proc);
    const runner = new BashProcessRunner();
    const gen = runner.run('yes', { cwd: '/tmp' });

    // 启动生成器（挂在 data/exit race 上），等首个 chunk 产出
    const firstP = gen.next();
    for (let i = 0; i < 100; i++) {
      proc.stdout.write(Buffer.from('x'.repeat(1024)));
    }
    const first = await Promise.race([
      firstP,
      new Promise<never>((_, r) =>
        setTimeout(() => r(new Error('timeout waiting first chunk')), 1000),
      ),
    ]);
    expect(first).toMatchObject({ value: { type: 'stdout' } });

    // 消费者暂停拉取（生成器挂在下一次 yield），queue 已远超高水位
    await new Promise((r) => setTimeout(r, 50));
    expect(proc.stdout.isPaused()).toBe(true); // 现状：永不 pause → false

    // drain 到低水位后 resume（生成器每次 next 消耗一个 chunk；queue=99 需消耗到 ≤16）
    for (let i = 0; i < 120 && proc.stdout.isPaused(); i++) {
      const r = await nextWithTimeout(gen, 200);
      if (r === 'timeout' || r.done) break;
    }
    expect(proc.stdout.isPaused()).toBe(false);

    // 清理：模拟 exit 让生成器走完（不再拉取剩余队列，直接 return 关闭）
    emitExit(proc, 0, null);
    await gen.return(undefined).catch(() => {});
  });
});

describe('P0-2 B6: bash 渲染显示尾部（store 截断语义一致）', () => {
  it('test_anchor_bash_renderer_shows_output_tail_when_truncated', () => {
    // ① 验证什么行为：大输出（> 12KB 渲染预算）被截断时，卡片显示的是输出**尾部**
    //    （最新内容），而非开头——与 store-time 截断（B1 保留尾部）语义一致。
    //    ② 缺失/错误会导致什么问题：store 已保留尾部，渲染层若仍显示头部（现状
    //    fromEnd=false），用户看到的是首块旧内容的开头，永远看不到最新输出——
    //    对 !yes / 日志类命令毫无用处；且 review §P0-2 明确声称「渲染层本就只展示
    //    尾部 12KB」（实际是头部，属 review 的事实性错误，本 anchor 把正确语义锁定）。
    //    ③ 依据：review.md §P0-2 修复建议①「store-time 截断（保留尾部）...渲染层
    //    本就只展示尾部 12KB，store 截断不影响显示」——按 review 意图，显示与存储
    //    必须同为尾部。
    const output = 'HEAD-MARKER-' + 'a'.repeat(20_000) + 'END-MARKER';
    const card = renderBashCard(
      { runId: 'r', terminal: 'done', output, stderr: '', exitCode: 0, command: 'echo hi' },
      {},
    );
    const json = JSON.stringify(card);
    expect(json).toContain('END-MARKER'); // 尾部（最新内容）必须保留
    expect(json).not.toContain('HEAD-MARKER'); // 头部必须被裁掉
  });
});

describe('P0-2 B5: capBashOutput 保留尾部', () => {
  it('test_probe_bash_output_cap_keeps_tail_not_head', () => {
    // ① 验证什么行为：store-time 截断入口对超限字符串保留**尾部**（最新内容），
    //    长度 ≤ BASH_OUTPUT_STORE_CAP，且小字符串原样通过。
    //    ② 缺失/错误会导致什么问题：若截断保留头部（slice(0, cap)），!yes 洪峰下
    //    session state 里永远是开头内容，用户看不到最新输出，且与 B6 的渲染 tail
    //    语义矛盾。③ 依据：review.md §P0-2 修复建议①「保留尾部」+ run-state
    //    keepLatest 的 slice(-maxChars) 惯例。
    expect(capBashOutput('x'.repeat(100_000)).length).toBeLessThanOrEqual(BASH_OUTPUT_STORE_CAP);

    const s = 'HEAD-' + 'y'.repeat(100_000) + 'TAIL';
    const capped = capBashOutput(s);
    expect(capped.endsWith('TAIL')).toBe(true); // 最新内容保留
    expect(capped.startsWith('HEAD-')).toBe(false); // 旧头部被裁
    expect(capped.length).toBeLessThanOrEqual(BASH_OUTPUT_STORE_CAP);

    // 小字符串原样返回（无截断副作用）
    expect(capBashOutput('small')).toBe('small');
  });
});

describe('P0-2 B7: 合批 finish 顺序（无 stale 帧）', () => {
  it('test_probe_bash_finish_renders_latest_state_no_stale_frame', async () => {
    // ① 验证什么行为：高频 update 后立即 finish（不等合批窗口），终态卡必须包含
    //    最新状态（finish 的 meta.output），且终态卡是最后一张 patch——合批不得让
    //    in-flight 的 pre-terminal 帧覆盖/滞后于终态帧。② 缺失/错误会导致什么问题：
    //    合批实现若不等 in-flight flush 就直接发终态 patch，两条 controller.update
    //    无 FIFO，pre-terminal 可能在 terminal 之后 resolve，用户看到"执行中"终帧
    //    （RunCardSession P2 同型 bug）。③ 依据：review.md §P0-2 修复建议②（与
    //    RunCardSession 相同的 coalesce 窗口——含其 finish 顺序保证）。
    const capture = { updates: [] as object[] };
    const connector = makeConnector(makeController(capture));
    const session = new BashCardSession({
      connector,
      chatId: 'c',
      replyTo: 'm',
      runId: 'r',
      command: 'echo hi',
    });
    await session.start();
    for (let i = 0; i < 100; i++) {
      await session.update({ output: `chunk-${i}\n` });
    }
    await session.finish('done', { exitCode: 0, output: 'FINAL-OUTPUT' });
    await session.settle();

    const last = JSON.stringify(capture.updates.at(-1));
    expect(last).toContain('FINAL-OUTPUT'); // 终态卡包含最新状态
    expect(last).toContain('命令执行完成'); // 终态 header

    // 终态卡必须是最后一张：其后的任何 patch 都不得存在
    let terminalSeen = false;
    for (const u of capture.updates) {
      const j = JSON.stringify(u);
      if (terminalSeen) {
        expect(j).toContain('命令执行完成'); // 若有后续 patch，必须是终态（幂等重复可接受）
      }
      if (j.includes('命令执行完成')) terminalSeen = true;
    }
  });
});
