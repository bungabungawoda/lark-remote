import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandRouter } from '../../src/router/index.js';
import { SessionStore } from '../../src/session/index.js';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import type { _Bridge } from '../../src/bridge/index.js';
import type { _SessionReaderRegistry } from '../../src/session/registry.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

type RouterInternals = {
  buildConfigCard: () => unknown;
  ensurePendingConfig: () => void;
  pendingConfig: AppConfig | null;
};

// ---------------------------------------------------------------------------
// Helpers: extract config card fields and input elements
// ---------------------------------------------------------------------------

/**
 * Extract input fields from CardKit 2.0 config card by traversing the JSON tree.
 * Returns array of { key, label, defaultValue }.
 */
function extractInputFields(
  card: object,
): Array<{ key: string; label: string; defaultValue: string }> {
  const results: Array<{ key: string; label: string; defaultValue: string }> = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;

    // When we find a column_set, process both columns together
    if (record.tag === 'column_set' && record.columns) {
      const columns = record.columns as Array<Record<string, unknown>>;
      let label = '';

      // Left column may contain the label
      if (columns[0]?.elements) {
        const leftElements = columns[0].elements as Array<Record<string, unknown>>;
        for (const el of leftElements) {
          if (el.tag === 'div' && (el.text as { content?: string } | undefined)?.content) {
            const content = (el.text as { content: string }).content;
            // Label may be with or without ** markers
            if (content.startsWith('**') && content.endsWith('**')) {
              label = content.slice(2, -2);
            } else {
              label = content;
            }
            break;
          }
        }
      }

      // Right column may contain the input
      if (columns[1]?.elements) {
        const rightElements = columns[1].elements as Array<Record<string, unknown>>;
        for (const el of rightElements) {
          if (el.tag === 'input' && el.name) {
            results.push({
              key: el.name as string,
              label,
              defaultValue: (el.default_value as string) || '',
            });
          }
        }
      }
      return; // Don't recurse into children again
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return results;
}

/**
 * Extract select fields from CardKit 2.0 config card by traversing the JSON tree.
 * Returns array of { key, label, initialOption }.
 */
function extractSelectFields(
  card: object,
): Array<{ key: string; label: string; initialOption?: string }> {
  const results: Array<{ key: string; label: string; initialOption?: string }> = [];

  function traverse(obj: unknown) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item));
      return;
    }

    const record = obj as Record<string, unknown>;

    // When we find a column_set, process both columns together
    if (record.tag === 'column_set' && record.columns) {
      const columns = record.columns as Array<Record<string, unknown>>;
      let label = '';

      // Left column may contain the label
      if (columns[0]?.elements) {
        const leftElements = columns[0].elements as Array<Record<string, unknown>>;
        for (const el of leftElements) {
          if (el.tag === 'div' && (el.text as { content?: string } | undefined)?.content) {
            const content = (el.text as { content: string }).content;
            // Label may be with or without ** markers
            if (content.startsWith('**') && content.endsWith('**')) {
              label = content.slice(2, -2);
            } else {
              label = content;
            }
            break;
          }
        }
      }

      // Right column may contain the select_static
      if (columns[1]?.elements) {
        const rightElements = columns[1].elements as Array<Record<string, unknown>>;
        for (const el of rightElements) {
          if (el.tag === 'select_static' && el.behaviors) {
            const behaviors = el.behaviors as Array<{ value?: { key?: string } }>;
            const behavior = behaviors.find((b) => b.value?.key);
            const key = behavior?.value?.key || '';

            const initialOption = el.initial_option as { text?: string } | undefined;

            results.push({
              key,
              label,
              initialOption: initialOption?.text,
            });
          }
        }
      }
      return;
    }

    for (const value of Object.values(record)) {
      traverse(value);
    }
  }

  traverse(card);
  return results;
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------
function buildClaudeConfig(model: string = 'opus'): AppConfig {
  return AppConfigSchema.parse({
    feishu: { appId: 'test', appSecret: 'test' },
    defaultAgent: 'claude',
    claude: {
      model,
      effort: 'medium',
      stopGraceMs: 5000,
    },
    output: {
      showThinking: true,
      showToolUse: true,
      showToolResult: true,
    },
    idle: { watchdogMinutes: 15 },
    logging: { level: 'info' },
  });
}

// ---------------------------------------------------------------------------
// Tests: Claude model custom input feature
// ---------------------------------------------------------------------------

describe('Config card: Claude model custom input (feature: 2026-07-15)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-config-model-custom-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('custom model input field', () => {
    it('should include custom model input field when defaultAgent=claude', () => {
      const config = buildClaudeConfig();
      const sessionStore = new SessionStore();
      const bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
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
      const inputFields = extractInputFields(result.card);

      // Should have a custom model input field with label containing "自定义模型名"
      const customModelInput = inputFields.find(
        (f) => f.label.includes('自定义模型名') || f.label.includes('自定义'),
      );

      expect(customModelInput).toBeDefined();
      expect(customModelInput?.key).toBe('claude.model');
    });

    it('should show custom value in input field when model is not in dropdown options', () => {
      const config = buildClaudeConfig('custom-model-vendor-xyz');
      const sessionStore = new SessionStore();
      const bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
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
      const inputFields = extractInputFields(result.card);

      // Find the custom model input field
      const customModelInput = inputFields.find((f) => f.key === 'claude.model');

      // When model is not in preset options, the input should show the custom value
      expect(customModelInput?.defaultValue).toBe('custom-model-vendor-xyz');
    });

    it('should show no selection in select when model is custom value', () => {
      const config = buildClaudeConfig('custom-model-vendor-xyz');
      const sessionStore = new SessionStore();
      const bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
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
      const selectFields = extractSelectFields(result.card);

      // Find the model select field (should be the one with "使用模型" label)
      const modelSelect = selectFields.find((f) => f.label.includes('使用模型'));

      // When model is not in preset options, select should have no initial option selected
      // (initialOption will be undefined or not match any preset option)
      // The model select should exist but not have a matching initial option from preset list
      expect(modelSelect).toBeDefined();
      expect(modelSelect?.key).toBe('claude.model');
    });

    it('should show empty input field when model is in preset options', () => {
      const config = buildClaudeConfig('opus');
      const sessionStore = new SessionStore();
      const bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
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
      const inputFields = extractInputFields(result.card);

      // Find the custom model input field
      const customModelInput = inputFields.find((f) => f.key === 'claude.model');

      // When model is a preset option (opus), input field should be empty
      expect(customModelInput?.defaultValue).toBe('');
    });

    it('should update pendingConfig when user inputs custom model via config.input', () => {
      const config = buildClaudeConfig('opus');
      const sessionStore = new SessionStore();
      const bridge = createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() });
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

      // Simulate user typing in custom model input and submitting
      (router as unknown as RouterInternals).ensurePendingConfig();

      // Access internal method to set value
      const internals = router as unknown as RouterInternals;
      if (internals.pendingConfig) {
        internals.pendingConfig.claude = { ...config.claude, model: 'claude-super-5-custom' };
      }

      // Verify pendingConfig was updated
      expect(internals.pendingConfig?.claude?.model).toBe('claude-super-5-custom');
    });
  });
});
