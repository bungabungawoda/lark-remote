import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { makeBridge } from '../lib/bridge-stubs.js';
import { setupTwoTaskQueueScenario } from '../lib/queue-scenario.js';
import { waitForOrThrow } from '../lib/wait-for.js';
import { mockLogger } from '../lib/logger-mock.js';
import { cardButtons, cardHeaderTitle, type Card } from '../lib/card-tree.js';

vi.mock('../../src/logger/index.js', async () =>
  (await import('../lib/logger-mock.js')).loggerModuleMock(),
);

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
    const updatesBeforeRelease = updateCardCalls.length;
    release1();

    // Wait for task2 to actually start executing
    await waitForOrThrow(() => updateCardCalls.length > updatesBeforeRelease);

    // CRITICAL ASSERTION: When task2 starts, the queue card should be UPDATED
    // Expected behavior: connector.updateCard should be called with updated card
    // - header.template: 'green'
    // - header.title contains "已开始执行"
    // - buttons have disabled: true

    expect(updateCardCalls.length).toBeGreaterThan(updatesBeforeRelease);

    // Verify the update has correct properties
    const updatedCard = updateCardCalls[updateCardCalls.length - 1].card;
    expect((updatedCard as { header?: { template?: string } }).header?.template).toBe('green');
    expect(cardHeaderTitle(updatedCard)).toContain('已开始执行');

    // Check buttons are disabled
    const buttons = cardButtons(updatedCard as Card);
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
    }

    restoreUpdateCard();
  });
});
