import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../../../src/bridge/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { Runner } from '../../../src/runner/index.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
} from '../../lib/bridge-stubs.js';
const { mockLogger } = vi.hoisted(() => ({
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

interface ResultThenHangRunner extends Runner {
  stopCalled: boolean;
  release: () => void;
}

/**
 * 生成器：t=0 发 init+text，delayMs 后发 result，然后挂起直到 stop()/release()。
 * 用于复现 review.md §P1-2 的「result 已到达但进程还在收尾」窗口。
 */
function createResultThenHangRunner(opts: {
  cwd: string;
  resultDelayMs: number;
}): ResultThenHangRunner {
  let resolveHang: () => void = () => {};
  const hangPromise = new Promise<void>((r) => {
    resolveHang = r;
  });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const runner: ResultThenHangRunner = {
    isRunning: false,
    stopCalled: false,
    release: () => resolveHang(),
    stop: async () => {
      runner.stopCalled = true;
      resolveHang();
    },
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        cwd: opts.cwd,
        model: 'opus',
      };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
      await sleep(opts.resultDelayMs);
      yield { type: 'result', subtype: 'success', session_id: 's1' };
      await hangPromise;
    },
  };
  return runner;
}

let tmpDir: string;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-idle-result-rearm-'));
  config = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: { model: 'opus', stopGraceMs: 5000 },
    output: { showThinking: true, showToolUse: false, showToolResult: false },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

function makeBridge(
  opts: {
    runner?: Runner;
    idleTimeoutMs?: number;
    connector?: ReturnType<typeof createStubConnector>;
  } = {},
) {
  const sessionStore = new SessionStore();
  const connector = opts.connector ?? createStubConnector();
  const runner = opts.runner ?? createResultThenHangRunner({ cwd: tmpDir, resultDelayMs: 900 });
  const bridge = new Bridge({
    runner,
    agentRegistry: createStubAgentRegistry(runner),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    connector,
    sessionStore,
    config,
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  });
  return { bridge, sessionStore, connector, runner };
}

describe('P1-2 idle watchdog: result event must re-arm (anchor)', () => {
  /**
   * 验证什么（target）:
   *   result 事件到达后，idle 看门狗必须重新武装——t=900 收到 result 后，再停滞
   *   到 t=1500（< result+1000ms）不得触发 idle_timeout，也不得调用 runner.stop()。
   *
   * 缺失导致什么（importance）:
   *   现状 src/bridge/index.ts 中 `if (event.type === 'result') {...} else { resetIdle(); }`
   *   result 分支不刷新 lastEventTs。t=0 收到 text 后停滞到 t=1500（>1000ms）即误触发
   *   fireIdleTimeout：一个已产出 result 的 turn 被标成「已自动终止」+ reaction 错标
   *   Alarm 而非 Done；result 后 CLI 做 jsonl flush/清理期间（finalizing 过渡）被掐断。
   *   AGENTS.md §9.12 红线明文「result 事件后必须 resetIdle() 重新武装」。
   *
   * 依据: review.md §P1-2（用户已拍板方案 A）+ AGENTS.md §9.12 红线。
   */
  it('anchor: result event re-arms the idle watchdog (no idle_timeout, no runner.stop)', async () => {
    vi.useFakeTimers();
    try {
      const runner = createResultThenHangRunner({ cwd: tmpDir, resultDelayMs: 900 });
      const { bridge, sessionStore, connector } = makeBridge({ runner, idleTimeoutMs: 1000 });
      sessionStore.setCwd(ctx.userId, tmpDir);

      const p = bridge.forwardToClaude('hello', ctx);
      // t=0 text → t=900 result → 推进到 t=1500。
      // bug：lastEventTs 停在 0，1500-0>1000 → idle 触发（stop + 已自动终止）。
      // 修复后：result 已 re-arm（deadline=1900），1500 不触发。
      await vi.advanceTimersByTimeAsync(1500);

      expect(runner.stopCalled).toBe(false); // 现状: true → RED
      expect(JSON.stringify(connector._cards.at(-1) ?? '')).not.toContain('已自动终止');

      // 修复路径下流仍挂起，释放让生成器自然结束 → 终态 done
      runner.release();
      await p;
      expect(JSON.stringify(connector._cards.at(-1))).toContain('已完成');
    } finally {
      vi.useRealTimers();
    }
  });
});
