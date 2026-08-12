import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandRouter } from '../../../src/router/index.js';
import { SessionStore } from '../../../src/session/index.js';
import { Bridge } from '../../../src/bridge/index.js';
import { AppConfigSchema } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/index.js';
import type { _AgentEvent, Runner } from '../../../src/runner/index.js';
import { SessionReaderRegistry } from '../../../src/session/registry.js';

import {
  createStubAgentRegistry,
  createStubSessionReaderRegistry,
  createStubConnector,
  createStubRunner,
} from '../../lib/bridge-stubs.js';
let tmpDir: string;
let workspacePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-ws-remove-test-'));
  workspacePath = path.join(tmpDir, 'workspace.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Stubs (structured seam stubs, not mocks of internal classes) ---
function createRouter() {
  const sessionStore = new SessionStore();
  const connector = createStubConnector();
  const runner: Runner = createStubRunner({ mode: 'streaming' });
  const config: AppConfig = AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    claude: {
      model: 'claude-opus-4-8',
      effort: 'medium',
      stopGraceMs: 5000,
    },
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

  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath,
    ordersPath: path.join(tmpDir, 'orders.json'),
    exitHandler: () => {},
    sessionReaderRegistry: new SessionReaderRegistry(),
  });

  return { router, sessionStore, connector, bridge };
}

const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

describe('Anchor: ws.remove updates card in place', () => {
  it('test_anchor_ws_remove_updates_card_in_place', async () => {
    /**
     * 验证行为：点击 /ws 列表卡上的「删除」按钮后，原卡片应原地刷新为
     *   删除后的 /ws 列表（CardKit 2.0），而非只回一条文本消息、把已删
     *   别名继续留在旧卡片上。
     * 缺失后果：用户点「删除」后卡片仍显示已删 workspace，与 order.delete
     *   的原地刷新体验不一致，且误导用户以为删除未生效。
     * 依据：src/router/index.ts:301-306 ws.use/ws.remove 只 sendResult 文本，
     *   对比 handleOrderDelete (line 1015-1038) 删完调 cmdOrder 重建列表卡 +
     *   updateCardInPlace + 返回 toast。
     */
    // Fixture: pre-populate workspace.json with a removable alias.
    //   WorkspaceStore loads a flat Record<string,string> (see src/workspace/index.ts).
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      workspacePath,
      JSON.stringify({ 'tmp-ws': projectDir, 'keep-ws': projectDir }),
    );

    const { router, sessionStore, connector } = createRouter();
    sessionStore.set('user1', {
      sessions: new Map([['claude', 'session-1']]),
      previousSessions: new Map(),
      cwd: projectDir,
    });

    // Act: trigger the「删除」button card action for tmp-ws.
    await router.handleCardAction(
      { cmd: 'ws.remove', name: 'tmp-ws' } as { cmd: string; name: string },
      ctx,
    );

    // Assert 1: connector received an in-place card update (updateCard),
    //   i.e. connector._cards holds the refreshed /ws list card.
    const updatedCards = connector._cards;
    expect(updatedCards.length).toBeGreaterThanOrEqual(1);

    // Assert 2: the refreshed card no longer contains the removed alias,
    //   but still shows the surviving one.
    const lastCard = updatedCards[updatedCards.length - 1] as object;
    const cardStr = JSON.stringify(lastCard);
    expect(cardStr).not.toContain('tmp-ws');
    expect(cardStr).toContain('keep-ws');

    // Assert 3: the refreshed card is CardKit 2.0 (schema/body), and obeys
    //   the 200861 red line: no V1 `tag:"action"` container with `actions`.
    //   (wide_screen_mode is a legitimate 2.0 config field — /ls and /order
    //   cards use it under schema:"2.0" — so it is NOT V1 residue.)
    expect(cardStr).toMatch(/"schema"\s*:\s*"2\.0"/);
    expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);

    // Assert 4: the refreshed /ws list card must NOT be sent as a brand-new
    //   message via sendWithRetry (that would duplicate the card instead of
    //   refreshing in place). Only the toast / no new card payload expected.
    const sentCards = connector._sent
      .map((s) => (s.input as { card?: object }).card)
      .filter(Boolean);
    expect(sentCards.length).toBe(0);
  }, 10000);
});
