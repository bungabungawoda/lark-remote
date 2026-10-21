/**
 * 共享 `/resume` 测试 harness。
 *
 * - `buildResumeRouter`：最小 router harness（sessionStore + stub connector +
 *   Bridge + CommandRouter），供需要自定义 registry/config 的锚点使用。
 * - `buildResumeHarness`：在 tmpDir 下造 N 个真实 claude session，接真实
 *   ClaudeSessionReader，其余 agent 用空 reader stub。
 *
 * 按钮投影：resumePageButtons / resumeUseButtons / countResumeButtons。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../../src/session/index.js';
import { CommandRouter } from '../../src/router/index.js';
import { Bridge } from '../../src/bridge/index.js';
import type { AppConfig } from '../../src/config/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import { SessionReaderRegistry } from '../../src/session/registry.js';
import { ClaudeSessionReader } from '../../src/session/claude/index.js';
import { encodedProjectDir, writeSessionJsonl } from './session-fixtures.js';
import {
  createStubAgentRegistry,
  createStubConnector,
  createStubRunner,
  createStubSessionReaderRegistry,
} from './bridge-stubs.js';
import { flattenElements } from './card-tree.js';
import type { Card, CardElement } from './card-tree.js';

export interface ResumeRouterOpts {
  tmpDir: string;
  registry: SessionReaderRegistry;
  config?: AppConfig;
  sessionStore?: SessionStore;
  connector?: ReturnType<typeof createStubConnector>;
  bridge?: Bridge;
}

/** 构造接好 registry 的 CommandRouter（configPath 指向 tmpDir）。 */
export function buildResumeRouter(opts: ResumeRouterOpts) {
  const { tmpDir, registry } = opts;
  const sessionStore = opts.sessionStore ?? new SessionStore();
  const connector = opts.connector ?? createStubConnector();
  const runner = createStubRunner({ mode: 'empty' });
  const config =
    opts.config ??
    AppConfigSchema.parse({
      feishu: { appId: 'test', appSecret: 'test' },
      claude: { model: 'opus', stopGraceMs: 5000 },
      defaultAgent: 'claude',
    });

  const bridge =
    opts.bridge ??
    new Bridge({
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
    sessionReaderRegistry: registry,
  });

  const ctx = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };
  const cardOf = (index: number) => (connector._sent[index].input as { card: Card }).card;
  return { router, sessionStore, connector, config, bridge, ctx, cardOf, registry };
}

export interface ResumeHarnessOpts {
  /** 每条 user message 的填充长度（`task ` + 'x'*msgLen）。 */
  msgLen?: number;
  /** 自定义第 i 个 session 的 JSONL 内容（覆盖默认 `task N`）。 */
  bodyFor?: (i: number) => string;
}

function emptyReader() {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [], reason: 'not_found' }),
    isSessionActive: () => false,
  };
}

/**
 * Build a full router harness wired to a real ClaudeSessionReader over the
 * given projectsDir, with sessionCount fixture sessions (distinct mtimes).
 */
export function buildResumeHarness(
  tmpDir: string,
  projectsDir: string,
  sessionCount: number,
  opts: ResumeHarnessOpts = {},
) {
  const canonicalCwd = fs.realpathSync(tmpDir);
  const projDir = path.join(projectsDir, encodedProjectDir(canonicalCwd));
  fs.mkdirSync(projDir, { recursive: true });

  const baseSec = Math.floor(Date.now() / 1000) - 86400;
  const message = 'task ' + 'x'.repeat(Math.max(0, opts.msgLen ?? 0));
  for (let i = 0; i < sessionCount; i++) {
    const sid = `session-${String(i).padStart(2, '0')}`;
    writeSessionJsonl(
      projDir,
      sid,
      canonicalCwd,
      opts.bodyFor?.(i) ??
        `{"type":"user","message":{"role":"user","content":"${message || `task ${i}`}"}}`,
    );
    fs.utimesSync(path.join(projDir, `${sid}.jsonl`), baseSec + i, baseSec + i);
  }

  const registry = new SessionReaderRegistry();
  registry.register('claude', new ClaudeSessionReader({ projectsDir }));
  const stubReader = emptyReader();
  registry.register('codex', stubReader);
  registry.register('opencode', stubReader);
  registry.register('pi', stubReader);
  registry.register('kimi', stubReader);

  const harness = buildResumeRouter({ tmpDir, registry });
  harness.sessionStore.setCwd('user1', canonicalCwd);
  return harness;
}

export function resumePageButtons(elements: CardElement[]): CardElement[] {
  return elements.filter(
    (el) => el.tag === 'button' && el.behaviors?.[0]?.value?.cmd === 'resume.page',
  );
}

export function resumeUseButtons(elements: CardElement[]): CardElement[] {
  return elements.filter((el) => el.behaviors?.[0]?.value?.cmd === 'resume.use');
}

export function countResumeButtons(card: Card): number {
  return resumeUseButtons(flattenElements(card)).length;
}
