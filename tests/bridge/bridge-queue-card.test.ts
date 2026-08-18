import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { makeBridge } from '../lib/bridge-stubs.js';
import { setupTwoTaskQueueScenario } from '../lib/queue-scenario.js';
// 直接在模块顶层定义 mock（兼容 bun 的 vitest）
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  // 重置 mock
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Queue card update when task starts executing', () => {
  it('test_anchor_queue_card_updates_when_task_starts_executing', async () => {
    const { bridge, connector } = makeBridge();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();

    const { updateCardCalls, initialCards, release1, restoreUpdateCard } =
      await setupTwoTaskQueueScenario(bridge, connector, tmpDir, {
        secondMessagePreview: 'quick task',
      });
    expect(initialCards.length).toBeGreaterThan(0);

    // Now release task1 - task2 starts executing
    release1();

    // Wait for task2 to actually start executing
    await new Promise((r) => setTimeout(r, 100));

    // CRITICAL ASSERTION: When task2 starts, the queue card should be UPDATED
    // Expected behavior: connector.updateCard should be called with updated card
    // - header.template: 'green'
    // - header.title contains "已开始执行"
    // - buttons have disabled: true

    expect(updateCardCalls.length).toBeGreaterThan(0);

    // Verify the update has correct properties
    const updatedCard = updateCardCalls[updateCardCalls.length - 1].card as Record<string, unknown>;
    const header = updatedCard.header as Record<string, unknown>;
    const title = header?.title as Record<string, unknown>;

    expect(header?.template).toBe('green');
    expect(String(title?.content)).toContain('已开始执行');

    // Check buttons are disabled
    const body = updatedCard.body as Record<string, unknown>;
    const elements = body?.elements as Array<Record<string, unknown>>;
    const buttons = elements?.filter((el: Record<string, unknown>) => el.tag === 'button');
    for (const btn of buttons ?? []) {
      expect(btn.disabled).toBe(true);
    }

    restoreUpdateCard();
  });
});
