/**
 * CodexConfigSchema reasoningEffort schema validation anchors.
 *
 * Split from codex-reasoning-effort.test.ts (merged 2026-08-04, Phase 4;
 * re-split 2026-08-29 cleanup): schema checks need no mocks.
 */
import { describe, it, expect } from 'vitest';
import { CodexConfigSchema } from '../../../src/config/index.js';

// ---------------------------------------------------------------------------
// 1. CodexConfigSchema reasoningEffort (Round 3 — no mocks needed)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 3 - Anchor
 *
 * Target: CodexConfigSchema 应包含 reasoningEffort 字段（z.string().optional()）
 *
 * Importance: 这是将 reasoningEffort 存储到 config.yaml 的必要步骤。
 * 只有在 schema 中声明了该字段，config 卡片才能保存和读取该值。
 *
 * Spec basis: Codex OpenAI provider + config extension 方案 §4.2
 */
describe('CodexConfigSchema reasoningEffort - anchor', () => {
  it('test_anchor_codex_config_schema_has_reasoning_effort', () => {
    const configWithEffort = {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'high',
      stopGraceMs: 5000,
    };

    const result = CodexConfigSchema.safeParse(configWithEffort);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningEffort).toBe('high');
    }
  });

  it('test_anchor_codex_config_schema_reasoning_effort_optional', () => {
    const configWithoutEffort = {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      stopGraceMs: 5000,
    };

    const result = CodexConfigSchema.safeParse(configWithoutEffort);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoningEffort).toBeUndefined();
    }
  });

  it('test_anchor_codex_config_schema_reasoning_effort_accepts_valid_values', () => {
    const validValues = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

    for (const value of validValues) {
      const config = {
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: value,
        stopGraceMs: 5000,
      };

      const result = CodexConfigSchema.safeParse(config);
      expect(result.success, `Failed for value: ${value}`).toBe(true);
      if (result.success) {
        expect(result.data.reasoningEffort).toBe(value);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P3-1: CodexConfigSchema reasoningEffort validation (custom values)
// ---------------------------------------------------------------------------

/**
 * Red Agent - Round 3 - Anchor (Bug 模式)
 *
 * Target: CodexConfigSchema.reasoningEffort 接受标准档位与自定义档位。
 *   codex ReasoningEffort 除标准档位外还有 Custom(String)——目录声明什么档位就存什么，
 *   收紧为 enum 会拒绝目录声明的自定义档位（P2-5）。
 *
 * Importance: 卡片档位下拉按模型 supported_reasoning_levels 原样透传；
 *   自定义档位存不进 config.yaml 会导致"选了但保存失败"。
 *
 * Spec basis: P2-5（codex-y review）+ codex-rs/protocol/src/openai_models.rs
 *   ReasoningEffort::Custom。
 */
describe('P3-1: CodexConfigSchema reasoningEffort validation', () => {
  it('test_anchor_codex_reasoningEffort_accepts_valid_values', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const result = CodexConfigSchema.safeParse({
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        reasoningEffort: effort,
      });
      expect(result.success, `effort="${effort}" should be valid`).toBe(true);
    }
  });

  it('test_anchor_codex_reasoningEffort_optional', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
    });
    expect(result.success).toBe(true);
  });

  it('test_anchor_codex_reasoningEffort_accepts_custom_value', () => {
    const result = CodexConfigSchema.safeParse({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'super-extreme',
    });
    expect(result.success).toBe(true);
  });
});
