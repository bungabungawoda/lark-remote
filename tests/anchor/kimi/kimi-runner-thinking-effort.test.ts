/**
 * Anchor Test: KimiRunner thinkingEffort 配置正确存储
 *
 * 验证 thinkingEffort 配置被正确存储和传递
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KimiRunner } from '../../../src/runner/kimi/index.js';

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

describe('KimiRunner thinkingEffort configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test_anchor_kimi_thinking_effort_stored_in_runner', () => {
    const runner = new KimiRunner({ workspace: 'test', thinkingEffort: 'max' });

    // Verify config is stored
    expect((runner as any).thinkingEffort).toBe('max');
  });

  it('test_anchor_kimi_thinking_effort_included_in_status_info', () => {
    const runner = new KimiRunner({ workspace: 'test', thinkingEffort: 'on' });

    const status = runner.getStatusInfo();

    // Verify status includes thinking effort
    expect(status.reasoning).toBe('on');
  });

  it('test_anchor_kimi_thinking_effort_default_is_max', () => {
    const runner = new KimiRunner({ workspace: 'test' });

    // Default should be 'max'
    expect((runner as any).thinkingEffort).toBe('max');
    expect(runner.getStatusInfo().reasoning).toBe('max');
  });
});
