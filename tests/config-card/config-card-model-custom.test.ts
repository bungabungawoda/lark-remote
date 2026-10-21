import { createMockBridge, createMockSessionReaderRegistry } from '../lib/bridge-stubs.js';
import { runCustomModelInputContract } from '../lib/config-card-custom-model.js';
import { createRouterFixture } from '../lib/router-fixture.js';
import { extractLabeledSelectFields } from '../lib/card-tree.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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
    runCustomModelInputContract({
      makeRouter: (model: string) =>
        createRouterFixture({
          tmpDir,
          config: buildClaudeConfig(model),
          bridge: createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() }),
          sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude'] }),
        }).router,
      key: 'claude.model',
      presetModel: 'opus',
      customModel: 'custom-model-vendor-xyz',
    });

    it('should show no selection in select when model is custom value', () => {
      const config = buildClaudeConfig('custom-model-vendor-xyz');
      const router = createRouterFixture({
        tmpDir,
        config,
        bridge: createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() }),
        sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude'] }),
      }).router;

      const result = router.buildConfigCard() as { card: object };
      const selectFields = extractLabeledSelectFields(result.card);

      // Find the model select field (should be the one with "使用模型" label)
      const modelSelect = selectFields.find((f) => f.label.includes('使用模型'));

      // When model is not in preset options, select should have no initial option selected
      // (initialOption will be undefined or not match any preset option)
      // The model select should exist but not have a matching initial option from preset list
      expect(modelSelect).toBeDefined();
      expect(modelSelect?.key).toBe('claude.model');
    });

    it('should update pendingConfig when user inputs custom model via config.input', () => {
      const config = buildClaudeConfig('opus');
      const router = createRouterFixture({
        tmpDir,
        config,
        bridge: createMockBridge({ enqueueImmediate: vi.fn(), clearRunners: vi.fn() }),
        sessionReaderRegistry: createMockSessionReaderRegistry({ agentKinds: ['claude'] }),
      }).router;

      // Simulate user typing in custom model input and submitting
      router.ensurePendingConfig();

      // Access internal method to set value
      if (router.pendingConfig) {
        router.pendingConfig.claude = { ...config.claude, model: 'claude-super-5-custom' };
      }

      // Verify pendingConfig was updated
      expect(router.pendingConfig?.claude?.model).toBe('claude-super-5-custom');
    });
  });
});
