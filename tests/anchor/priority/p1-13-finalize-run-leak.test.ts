import { describe, it, expect, afterEach, vi } from 'vitest';
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
} from '../../lib/bridge-stubs.js';
const { mockLogger, renderCalls } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  renderCalls: { n: 0 },
}));

vi.mock('../../../src/logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

// Error-injection seam (review.md §P1-13): the ONLY unguarded expression in
// finalizeRun is the renderRunCard(...) argument evaluation at the sendResult
// call site. Calls 1-2 are cardSession.start() initial render and the
// stream-end finish() render (both pre-finalize); call 3 is finalizeRun's
// sendResult argument. Throw only at call 3 so the crash lands inside
// finalizeRun — the exact P1-13 failure path.
vi.mock('../../../src/card/run-renderer.js', () => ({
  renderRunCard: () => {
    renderCalls.n += 1;
    if (renderCalls.n >= 3) {
      throw new Error('boom: renderRunCard crashed inside finalizeRun');
    }
    return { schema: '2.0', body: { elements: [] } };
  },
}));

function createStreamRejectingConnector() {
  return {
    sendWithRetry: async () => 'msg-id',
    sendFile: async () => 'file-msg-id',
    reconnect: async () => {},
    addReaction: async () => {},
    // streamCard rejects: stream unavailable -> settle() returns 'unsent' ->
    // finalizeRun takes the sendResult(renderRunCard(...)) branch.
    streamCard: async () => {
      throw new Error('stream unavailable');
    },
    updateCard: async () => {},
    connected: true,
  };
}

function createEmptyStreamingRunner(): Runner {
  return {
    isRunning: false,
    stop: async () => {},
    killOrphan: () => {},
    registerExitHandlers: () => {},
    run: async function* () {
      // Empty stream: ends immediately, finalizeRun is still reached.
    },
  };
}

describe('P1-13 finalizeRun cleanup', () => {
  afterEach(() => {
    renderCalls.n = 0;
  });

  it('test_anchor_finalize_run_error_does_not_leak_active_runs', async () => {
    // ① 验证什么行为：finalizeRun 中途抛错（renderRunCard 崩溃）后，workspace
    //    不得永久假忙 —— activeRuns 清理必须不受 render 异常影响。
    // ② 缺失/错误会导致什么：activeRuns.delete(cwd) 被跳过，后续消息全部被
    //    busy-drop「此 workspace 正在处理中，请 /stop 后重试」，只能靠用户
    //    手动 /stop 自愈 —— 确定性状态损坏。
    // ③ 依据：review.md §P1-13「finalizeRun 无 try/finally：中途抛错则
    //    activeRuns 泄漏，workspace 永久假忙」「唯一无保护的是
    //    renderRunCard(...)（index.ts:1182，在 sendResult 调用点之外求值）」。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-13-leak-'));
    try {
      const config: AppConfig = AppConfigSchema.parse({
        feishu: { appId: 'test', appSecret: 'test' },
        claude: { model: 'opus', stopGraceMs: 5000 },
        workspace: { default: '' },
        output: { showThinking: true, showToolUse: false, showToolResult: false },
      });
      const sessionStore = new SessionStore();
      sessionStore.setCwd('u1', tmpDir);

      const bridgeRunner = createEmptyStreamingRunner();
      const bridge = new Bridge({
        agentRegistry: createStubAgentRegistry(bridgeRunner),
        sessionReaderRegistry: createStubSessionReaderRegistry(),
        connector: createStreamRejectingConnector(),
        sessionStore,
        config,
      });

      const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };
      // renderRunCard throws at finalizeRun -> forwardToClaude rejects. The
      // rejection itself is expected; what must NOT happen is the leak.
      await bridge.forwardToClaude('hi', ctx).catch(() => {});

      expect(bridge.isBusyFor(tmpDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
