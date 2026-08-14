import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

type RouterInternals = {
  buildConfigCard: () => unknown;
  ensurePendingConfig: () => void;
  setNestedValue: (obj: unknown, key: string, value: unknown) => void;
  pendingConfig: Record<string, unknown>;
};

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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // FIXED 2026-07-12: now includes agents.codex.model (was codex.model before)
      expect(fieldKeys).toContain('agents.codex.model');
    });

    it('test_anchor_codex_exec_mode_hides_approval_and_sandbox_fields', () => {
      // 验证什么：codex 默认 exec（命令行）模式时，/config 卡片不出现
      // 「审批策略」与「沙箱模式」字段（运行模式 select 仍保留）。
      // 错误会导致命令行模式用户看到不可用/误导的 app-server 专属选项。
      // 依据：需求「如果是命令行模式，不应该出现这两个选项」。
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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).not.toContain('agents.codex.sandbox');
      expect(fieldKeys).toContain('agents.codex.serviceMode');
      expect(fieldKeys).toContain('agents.codex.model');
    });

    it('test_anchor_codex_appserver_mode_shows_approval_and_sandbox_fields', () => {
      // 验证什么：codex 且 serviceMode=app-server 时，/config 卡片出现
      // 「审批策略」「沙箱模式」与「运行模式」三个字段。
      // 错误会导致 app-server 用户无法在卡片上配置审批/沙箱。
      // 依据：需求「只有在选了 AppServer 的时候，才应该出现审批模式还有 sandbox 这两个选项」。
      const config: AppConfig = {
        ...buildCodexConfig(),
        agents: { codex: { serviceMode: 'app-server' } },
      };
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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');
      expect(fieldKeys).toContain('agents.codex.serviceMode');
    });

    it('test_anchor_codex_service_mode_switch_toggles_approval_and_sandbox_fields', () => {
      // 验证什么：在 /config 卡片把运行模式从 exec 切到 app-server 时，
      // 审批/沙箱字段出现；切回 exec 时消失（门控跟随 pendingConfig 动态渲染）。
      // 错误会导致切换后字段不联动，卡片停留在旧模式。
      // 依据：需求「只有在选了 AppServer 的时候才应该出现」。
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
      const internals = router as unknown as RouterInternals;
      internals.ensurePendingConfig();
      internals.setNestedValue(internals.pendingConfig, 'agents.codex.serviceMode', 'app-server');

      let fieldKeys = extractConfigFieldKeys(
        (internals.buildConfigCard() as { card: object }).card,
      );
      expect(fieldKeys).toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).toContain('agents.codex.sandbox');

      internals.setNestedValue(internals.pendingConfig, 'agents.codex.serviceMode', 'exec');
      fieldKeys = extractConfigFieldKeys((internals.buildConfigCard() as { card: object }).card);
      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).not.toContain('agents.codex.sandbox');
    });

    it('test_anchor_codex_exec_mode_card_states_default_semantics', () => {
      // 验证什么：exec（命令行）模式下卡片明示默认语义——完全访问
      // （danger-full-access）且无需审批（never），与 runner argv 硬编码一致。
      // 错误会导致用户对命令行模式的权限边界没有可见说明。
      // 依据：需求「命令行模式默认就是 Dangerous for Access，还有不需要审批，Never approval」。
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

      const cardStr = JSON.stringify(
        (router as unknown as RouterInternals).buildConfigCard() as { card: object },
      );
      expect(cardStr).toContain('danger-full-access');
      expect(cardStr).toContain('never');
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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // Claude agent should have these fields
      expect(fieldKeys).toContain('defaultAgent');
      expect(fieldKeys).toContain('claude.model');
      expect(fieldKeys).toContain('claude.effort');
      // 2026-07-12: permissionMode hardcoded, not configurable in card
      expect(fieldKeys).not.toContain('claude.permissionMode');
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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
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

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
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
      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'pi',
      );

      // Rebuild card — should now show pi fields, not claude fields
      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
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

      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'pi',
      );

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const label = extractAgentTabLabel(result.card);

      expect(label).toContain('Pi');
      expect(label).not.toContain('Claude');
    });

    it('claude → codex: card shows codex fields, not claude fields', () => {
      const { router } = createRouterWithClaudeDefault();

      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'codex',
      );

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      // FIXED 2026-07-12: uses agents.codex.xxx keys
      expect(fieldKeys).toContain('agents.codex.model');
      // 2026-08-12: 切到 codex 默认 exec 模式，审批/沙箱字段不显示
      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).not.toContain('agents.codex.sandbox');
      expect(fieldKeys).toContain('agents.codex.serviceMode');

      expect(fieldKeys).not.toContain('claude.model');
      expect(fieldKeys).not.toContain('claude.settings');
      // 2026-07-12: permissionMode hardcoded, not in card
      expect(fieldKeys).not.toContain('claude.permissionMode');
    });

    it('claude → opencode: card shows opencode fields, not claude fields', () => {
      const { router } = createRouterWithClaudeDefault();

      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'opencode',
      );

      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
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
      let result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      let fieldKeys = extractConfigFieldKeys(result.card);
      expect(fieldKeys).toContain('agents.pi.model');
      expect(fieldKeys).toContain('agents.pi.thinking');

      // Switch to codex
      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'codex',
      );

      result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      fieldKeys = extractConfigFieldKeys(result.card);

      // Now codex fields, not pi fields (FIXED 2026-07-12: uses agents.codex.xxx keys)
      expect(fieldKeys).toContain('agents.codex.model');
      // 2026-08-12: 切到 codex 默认 exec 模式，审批字段不显示
      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).not.toContain('agents.codex.sandbox');
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
      let result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      let fieldKeys = extractConfigFieldKeys(result.card);
      expect(fieldKeys).toContain('agents.codex.model');
      // 2026-08-12: codex 默认 exec 模式，审批字段不显示
      expect(fieldKeys).not.toContain('agents.codex.approvalPolicy');
      expect(fieldKeys).not.toContain('agents.codex.sandbox');

      // Switch to pi
      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'pi',
      );

      result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
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
      let result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      expect(extractAgentTabLabel(result.card)).toContain('Opencode');

      // Switch to pi
      (router as unknown as RouterInternals).ensurePendingConfig();
      (router as unknown as RouterInternals).setNestedValue(
        (router as unknown as RouterInternals).pendingConfig,
        'defaultAgent',
        'pi',
      );

      result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      expect(extractAgentTabLabel(result.card)).toContain('Pi');
      expect(extractAgentTabLabel(result.card)).not.toContain('Opencode');
    });

    it('no pendingConfig: falls back to this.config.defaultAgent (no regression)', () => {
      const { router } = createRouterWithClaudeDefault();

      // Don't set pendingConfig — should use this.config.defaultAgent = 'claude'
      const result = (router as unknown as RouterInternals).buildConfigCard() as { card: object };
      const fieldKeys = extractConfigFieldKeys(result.card);

      expect(fieldKeys).toContain('claude.model');
      // 2026-07-12: permissionMode hardcoded to bypassPermissions, not configurable in card
      expect(fieldKeys).not.toContain('claude.permissionMode');
      expect(extractAgentTabLabel(result.card)).toContain('Claude');
    });
  });
});
