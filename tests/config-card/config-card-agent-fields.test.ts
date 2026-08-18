import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// 默认不探测（availability=undefined），让既有用例保持「全部视为可用」的基线；
// 排序用例里再按需 mock 单个 agent 为未安装。
vi.mock('../../src/runner/probe.js', () => ({
  probeAllAgents: vi.fn(async () => new Map()),
  getCachedAvailability: vi.fn(() => undefined),
}));
import { getCachedAvailability } from '../../src/runner/probe.js';
// ---------------------------------------------------------------------------
// Helpers: extract field keys from a CardKit 2.0 config card JSON
// ---------------------------------------------------------------------------

/**
 * Match all config.* commands: config.set, config.toggle, config.input
 * Returns the field keys found in callback behaviors.
 */
function extractConfigFieldKeys(card: object): string[] {
  const keys = new Set<string>();
  const json = JSON.stringify(card);

  // Pattern 1: "cmd":"config.set","key":"<key>"
  const regex = /"cmd"\s*:\s*"config\.\w+"\s*,\s*"key"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(json)) !== null) {
    keys.add(match[1]);
  }
  // Pattern 2: "key":"<key>","cmd":"config.set" (reverse order)
  const regex2 = /"key"\s*:\s*"([^"]+)"\s*,\s*"cmd"\s*:\s*"config\.\w+"/g;
  while ((match = regex2.exec(json)) !== null) {
    keys.add(match[1]);
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------
function buildCodexConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'codex',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    codex: {
      model: 'claude-sonnet-4-20250514',
    },
    workspace: { default: '' },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
  });
}

function buildClaudeConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'claude',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    workspace: { default: '' },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
  });
}

/**
 * Extract the agent tab label (e.g. "**🤖 Claude**") from a config card.
 */
function extractAgentTabLabel(card: object): string {
  const elements = (card as { body?: { elements?: Array<{ text?: { content?: string } }> } })?.body
    ?.elements;
  if (!Array.isArray(elements)) return '';
  for (const el of elements) {
    const content = el?.text?.content ?? '';
    if (content.includes('🤖')) return content;
  }
  return '';
}

interface SelectInfo {
  key: string;
  options: string[];
  initialOption?: string;
}

/** 递归收集卡片中所有 select_static 的 key / options / initial_option。 */
function walkSelects(node: unknown, out: SelectInfo[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkSelects(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'select_static') {
      const behavior = Array.isArray(obj.behaviors)
        ? (obj.behaviors[0] as { value?: { key?: string } } | undefined)
        : undefined;
      const key = behavior?.value?.key ?? '';
      const options = Array.isArray(obj.options)
        ? (obj.options as Array<{ value: unknown }>).map((o) => String(o.value))
        : [];
      out.push({
        key,
        options,
        initialOption: typeof obj.initial_option === 'string' ? obj.initial_option : undefined,
      });
    }
    for (const value of Object.values(obj)) walkSelects(value, out);
  }
}

function extractSelects(card: object): SelectInfo[] {
  const out: SelectInfo[] = [];
  walkSelects(card, out);
  return out;
}

function buildPiConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'pi',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: { pi: { provider: 'Volcano', model: 'glm-5.2', thinking: 'medium' } },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
  });
}

function buildOpencodeConfig(): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'opencode',
    claude: {
      model: 'opus',
      stopGraceMs: 5000,
    },
    agents: { opencode: { password: 'test-pass', baseUrl: 'http://localhost:8080' } },
    output: {
      showThinking: true,
      showToolUse: false,
      showToolResult: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Config card agent-aware fields (design: 2026-07-11)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-config-agent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('defaultAgent = codex', () => {
    it('should NOT show claude.model and claude.settings when defaultAgent=codex', () => {
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // BUG: current implementation shows claude.model and claude.settings
      // even when defaultAgent=codex, which is wrong
      expect(fieldKeys).not.toContain('claude.model');
      expect(fieldKeys).not.toContain('claude.settings');
    });

    it('should show codex.model when defaultAgent=codex', () => {
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // FIXED 2026-07-12: now includes agents.codex.model (was codex.model before)
      expect(fieldKeys).toContain('agents.codex.model');
    });

    it('test_anchor_codex_default_appserver_mode_shows_approval_and_sandbox_fields', () => {
      // 验证什么：codex（app-server 模式）时，/config 卡片出现「审批策略」
      // 「沙箱模式」字段。错误会导致首次启动用户看不到审批/沙箱配置。
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');
      expect(fieldKeys).toContain('agents.codex.model');
    });

    it('test_anchor_codex_default_card_shows_appserver_workspace_write_on_request', () => {
      // 验证什么：首次启动切到 codex（未显式配置 codex 字段）时，卡片默认选中
      // sandbox=workspace-write、approvalPolicy=on-request。
      // 错误会导致首次启动显示 danger-full-access 旧默认值。
      // 依据：需求「用户第一次启动，切换到 Codex，显示的就是这个配置」。
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const selects = extractSelects(result.card);

      expect(selects.find((s) => s.key === 'agents.codex.sandbox')?.initialOption).toBe(
        'workspace-write',
      );
      expect(selects.find((s) => s.key === 'agents.codex.approvalPolicy')?.initialOption).toBe(
        'on-request',
      );
    });

    it('test_anchor_codex_appserver_mode_shows_approval_and_sandbox_fields', () => {
      // 验证什么：codex 的 /config 卡片恒出现「审批策略」「沙箱模式」字段。
      // 错误会导致用户无法在卡片上配置审批/沙箱。
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');
    });
  });

  describe('defaultAgent = claude (baseline)', () => {
    it('should show claude-specific fields when defaultAgent=claude', () => {
      const config = buildClaudeConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // Claude agent should have these fields
      expect(fieldKeys).toContain('defaultAgent');
      expect(fieldKeys).toContain('claude.model');
      expect(fieldKeys).toContain('claude.effort');
      // 2026-08-16: claude 交互式审批落地后，permissionMode 在卡片上可选
      expect(fieldKeys).toContain('claude.permissionMode');
    });

    it('should NOT show codex-specific fields when defaultAgent=claude', () => {
      const config = buildClaudeConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).not.toContain('agents.codex.sandboxPolicy');
      expect(fieldKeys).not.toContain('agents.codex.model');
    });
  });

  describe('CardKit 2.0 schema compliance', () => {
    it('codex config card must not mix V1/V2 action containers (regression: 200861)', () => {
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const sessionReaderRegistry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });

      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry,
      });

      const result = router.buildConfigCard() as { card: object };
      const cardStr = JSON.stringify(result.card);

      expect(cardStr).toContain('"schema":"2.0"');
      expect(cardStr).not.toMatch(/"tag"\s*:\s*"action"[^}]*"actions"/);
    });
  });

  // ==========================================================================
  // CRITICAL: pendingConfig agent switch tests (2026-07-11)
  //
  // These test the core bug: when user selects a different agent in the
  // config card dropdown, buildConfigCard() must reflect the NEW agent's
  // fields and tab label — not the old persisted agent's.
  // ==========================================================================
  describe('pendingConfig agent switch — field structure follows pendingConfig', () => {
    /** Create a router with defaultAgent=claude and a mock registry */
    function createRouterWithClaudeDefault() {
      const config = buildClaudeConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const registry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });
      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry: registry,
      });
      return { router, config };
    }

    it('claude → pi: card shows pi fields, not claude fields, after pendingConfig switch', () => {
      const { router } = createRouterWithClaudeDefault();

      // Simulate user selecting 'pi' in the defaultAgent dropdown
      // (this is what config.set handler does internally)
      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'pi');

      // Rebuild card — should now show pi fields, not claude fields
      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // pi fields must be present
      expect(fieldKeys).toContain('agents.pi.model');
      expect(fieldKeys).toContain('agents.pi.provider');
      expect(fieldKeys).toContain('agents.pi.thinking');

      // claude fields must NOT be present
      expect(fieldKeys).not.toContain('claude.model');
      expect(fieldKeys).not.toContain('claude.settings');
      expect(fieldKeys).not.toContain('claude.permissionMode');
    });

    it('claude → pi: tab label shows 🤖 Pi, not 🤖 Claude', () => {
      const { router } = createRouterWithClaudeDefault();

      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'pi');

      const result = router.buildConfigCard() as { card: object };
      const label = extractAgentTabLabel(result.card);

      expect(label).toContain('Pi');
      expect(label).not.toContain('Claude');
    });

    it('claude → codex: card shows codex fields, not claude fields', () => {
      const { router } = createRouterWithClaudeDefault();

      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'codex');

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // FIXED 2026-07-12: uses agents.codex.xxx keys
      expect(fieldKeys).toContain('agents.codex.model');
      // 2026-08-14: codex 恒为 app-server 模式，审批/沙箱字段显示
      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');

      expect(fieldKeys).not.toContain('claude.model');
      expect(fieldKeys).not.toContain('claude.settings');
      // 2026-08-16: 切到 codex 后不再显示 claude 字段（含 permissionMode）
      expect(fieldKeys).not.toContain('claude.effort');
      expect(fieldKeys).not.toContain('claude.permissionMode');
    });

    it('claude → opencode: card shows opencode fields, not claude fields', () => {
      const { router } = createRouterWithClaudeDefault();

      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'opencode');

      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // FIXED 2026-07-13: now uses agents.opencode.xxx keys (was opencode.xxx before)
      expect(fieldKeys).toContain('agents.opencode.modelID');
      expect(fieldKeys).toContain('agents.opencode.providerID');

      expect(fieldKeys).not.toContain('claude.model');
      expect(fieldKeys).not.toContain('claude.settings');
      expect(fieldKeys).not.toContain('claude.permissionMode');
    });

    it('pi → codex: card switches from pi fields to codex fields', () => {
      const config = buildPiConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const registry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });
      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry: registry,
      });

      // Before switch: pi fields should be visible
      let result = router.buildConfigCard() as { card: object };
      let fieldKeys = extractConfigFieldKeys(result.card);
      expect(fieldKeys).toContain('agents.pi.model');
      expect(fieldKeys).toContain('agents.pi.thinking');

      // Switch to codex
      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'codex');

      result = router.buildConfigCard() as { card: object };
      fieldKeys = extractConfigFieldKeys(result.card);

      // Now codex fields, not pi fields (FIXED 2026-07-12: uses agents.codex.xxx keys)
      expect(fieldKeys).toContain('agents.codex.model');
      // 2026-08-14: codex 恒为 app-server 模式，审批/沙箱字段显示
      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');
      expect(fieldKeys).not.toContain('agents.pi.model');
      expect(fieldKeys).not.toContain('pi.thinking');
    });

    it('codex → pi: card switches from codex fields to pi fields', () => {
      const config = buildCodexConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const registry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });
      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry: registry,
      });

      // Before switch: codex fields should be visible (FIXED 2026-07-12: uses agents.codex.xxx keys)
      let result = router.buildConfigCard() as { card: object };
      let fieldKeys = extractConfigFieldKeys(result.card);
      expect(fieldKeys).toContain('agents.codex.model');
      // 2026-08-14: codex 恒为 app-server 模式，审批/沙箱字段显示
      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');

      // Switch to pi
      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'pi');

      result = router.buildConfigCard() as { card: object };
      fieldKeys = extractConfigFieldKeys(result.card);

      // Now pi fields, not codex fields
      expect(fieldKeys).toContain('agents.pi.model');
      expect(fieldKeys).toContain('agents.pi.thinking');
      expect(fieldKeys).not.toContain('agents.codex.model');
      // After switching to pi, codex fields should not be present
      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
    });

    it('opencode → pi: tab label changes from 🤖 Opencode to 🤖 Pi', () => {
      const config = buildOpencodeConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const registry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });
      const router = new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry: registry,
      });

      // Before switch
      let result = router.buildConfigCard() as { card: object };
      expect(extractAgentTabLabel(result.card)).toContain('Opencode');

      // Switch to pi
      router.ensurePendingConfig();
      router.setNestedValue(router.pendingConfig, 'defaultAgent', 'pi');

      result = router.buildConfigCard() as { card: object };
      expect(extractAgentTabLabel(result.card)).toContain('Pi');
      expect(extractAgentTabLabel(result.card)).not.toContain('Opencode');
    });

    it('no pendingConfig: falls back to this.config.defaultAgent (no regression)', () => {
      const { router } = createRouterWithClaudeDefault();

      // Don't set pendingConfig — should use this.config.defaultAgent = 'claude'
      const result = router.buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).toContain('claude.model');
      // 2026-08-16: claude.permissionMode 由卡片 select 暴露
      expect(fieldKeys).toContain('claude.permissionMode');
      expect(extractAgentTabLabel(result.card)).toContain('Claude');
    });
  });

  describe('defaultAgent selector agent order (first-start)', () => {
    function createRouter() {
      const config = buildClaudeConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge();
      const registry = createMockSessionReaderRegistry({ agentKinds: ['claude'] });
      return new CommandRouter({
        sessionStore,
        bridge,
        config,
        configPath: path.join(tmpDir, 'config.yaml'),
        workspacePath: path.join(tmpDir, 'workspace.json'),
        ordersPath: path.join(tmpDir, 'orders.json'),
        sessionReaderRegistry: registry,
      });
    }

    it('lists agents in canonical order Codex → Claude → OpenCode → Pi → Kimi', () => {
      // 验证什么：首次启动默认 Agent 下拉按 Codex → Claude → OpenCode → Pi → Kimi 排列。
      // 错误会导致首次启动用户看到的 agent 顺序不符合产品默认。
      const router = createRouter();
      const result = router.buildConfigCard() as {
        card: object;
      };
      const options =
        extractSelects(result.card).find((s) => s.key === 'defaultAgent')?.options ?? [];
      expect(options).toEqual(['codex', 'claude', 'opencode', 'pi', 'kimi']);
    });

    it('moves uninstalled agents to the back, preserving canonical order within groups', () => {
      // 验证什么：明确未安装（opencode/kimi）的 agent 排到已安装（codex/claude/pi）之后，
      // 组内仍保持 canonical order。
      // 错误会导致未安装的 agent 插在已安装前面，用户首选被未安装项占据。
      vi.mocked(getCachedAvailability).mockImplementation(
        (kind) => kind !== 'opencode' && kind !== 'kimi',
      );
      try {
        const router = createRouter();
        const result = router.buildConfigCard() as {
          card: object;
        };
        const options =
          extractSelects(result.card).find((s) => s.key === 'defaultAgent')?.options ?? [];
        expect(options).toEqual(['codex', 'claude', 'pi', 'opencode', 'kimi']);
      } finally {
        vi.mocked(getCachedAvailability).mockImplementation(() => undefined);
      }
    });
  });
});
