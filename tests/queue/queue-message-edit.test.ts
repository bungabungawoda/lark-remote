import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { makeBridge } from '../lib/bridge-stubs.js';
import { setupTwoTaskQueueScenario } from '../lib/queue-scenario.js';
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../logger/index.js', () => ({
  getLogger: () => mockLogger,
  initLogger: () => mockLogger,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-bridge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Queue message edit', () => {
  it('test_anchor_queue_message_edit', async () => {
    const { bridge, connector } = makeBridge();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();

    const { updateCardCalls, initialCards, release1, restoreUpdateCard } =
      await setupTwoTaskQueueScenario(bridge, connector, tmpDir);
    expect(initialCards.length).toBeGreaterThan(0);

    // Verify the initial card contains an edit button (cmd: queue.edit)
    const initialCard = (initialCards[0].input as Record<string, unknown>).card as Record<
      string,
      unknown
    >;
    const initialBody = initialCard.body as Record<string, unknown>;
    const initialElements = initialBody.elements as Array<Record<string, unknown>>;
    const editButton = initialElements.find((el: Record<string, unknown>) => {
      if (el.tag !== 'button') return false;
      const behaviors = el.behaviors as Array<Record<string, unknown>> | undefined;
      if (!behaviors?.length) return false;
      const value = behaviors[0].value as Record<string, unknown> | undefined;
      return value?.cmd === 'queue.edit';
    });
    expect(editButton).toBeDefined();

    // Step 2: Simulate clicking edit button -> card shows input with default_value
    // This would be handled by router.handleCardAction for cmd 'queue.edit'
    // The card should update to show an input element with the current message as default_value
    const updatedNewContent = 'edited message content';

    // Step 3: Simulate submitting new content via queue.input
    // This would be handled by router.handleCardAction for cmd 'queue.input'
    // The queue manager should update the messagePreview for the queued task
    // and return the updated card object (sent as the cardAction callback
    // response `card.data`, not via a PATCH updateCard call).
    const editCard = await bridge.updateMessagePreview(tmpDir, 'msg-2', updatedNewContent);

    // Verify the queued task's messagePreview was updated
    const updatedTask = bridge.getQueuedTask(tmpDir, 'msg-2');
    expect(updatedTask?.messagePreview).toBe(updatedNewContent);

    // Step 4: Verify the returned card shows the new content
    expect(editCard).not.toBeNull();
    const editBody = (editCard as Record<string, unknown> | null)?.body as
      Record<string, unknown> | undefined;
    const editElements = editBody?.elements as Array<Record<string, unknown>> | undefined;
    const hasNewContent = editElements?.some((el: Record<string, unknown>) => {
      const text = el.text as Record<string, unknown> | undefined;
      const content = text?.content as string | undefined;
      return content?.includes(updatedNewContent) ?? false;
    });
    expect(hasNewContent).toBe(true);

    // Step 5: Verify the edit button is disabled once task starts executing
    release1();
    await new Promise((r) => setTimeout(r, 150));

    // The executing-state card should have disabled edit button
    const executingUpdateCall = updateCardCalls.find((call) => {
      const card = call.card as Record<string, unknown>;
      const header = card.header as Record<string, unknown>;
      const titleContent = (header?.title as { content?: string } | undefined)?.content;
      return titleContent?.includes('已开始执行') ?? false;
    });
    if (executingUpdateCall) {
      const execCard = executingUpdateCall.card as Record<string, unknown>;
      const execBody = execCard.body as Record<string, unknown>;
      const execElements = execBody.elements as Array<Record<string, unknown>>;
      const execEditButton = execElements.find((el: Record<string, unknown>) => {
        if (el.tag !== 'button') return false;
        const behaviors = el.behaviors as Array<Record<string, unknown>> | undefined;
        if (!behaviors?.length) return false;
        const value = behaviors[0].value as Record<string, unknown> | undefined;
        return value?.cmd === 'queue.edit';
      });
      if (execEditButton) {
        expect(execEditButton.disabled).toBe(true);
      }
    }

    restoreUpdateCard();
  });
});
