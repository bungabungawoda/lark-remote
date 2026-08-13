/**
 * Shared helpers for agent-switch anchor tests.
 *
 * After 2026-08-13, config.save agent switch sends a Resume card instead of
 * plain text. These helpers extract notification text from either format.
 */

/** Extract all text content from a CardKit 2.0 card (header + body) */
export function extractCardTexts(card: unknown): string {
  if (!card || typeof card !== 'object') return '';
  const c = card as { header?: { title?: { content?: string } }; body?: { elements?: unknown[] } };
  const parts: string[] = [];
  if (c.header?.title?.content) parts.push(c.header.title.content);
  if (c.body?.elements && Array.isArray(c.body.elements)) {
    for (const el of c.body.elements) {
      const e = el as { text?: { content?: string }; columns?: Array<{ elements?: unknown[] }> };
      if (e.text?.content) parts.push(e.text.content);
      for (const col of e.columns ?? []) {
        const colEl = col as { elements?: unknown[] };
        if (colEl.elements) {
          for (const child of colEl.elements) {
            const ch = child as { text?: { content?: string } };
            if (ch.text?.content) parts.push(ch.text.content);
          }
        }
      }
    }
  }
  return parts.join(' ');
}

/** Get the last sendResult call's content as concatenated card text (or raw text) */
export function lastNotice(sendResultMock: ReturnType<typeof import('vitest').vi.fn>): string {
  const calls = sendResultMock.mock.calls;
  // Find the last call that contains a card or text about agent switch
  for (let i = calls.length - 1; i >= 0; i--) {
    const arg = calls[i][0] as { text?: string; card?: unknown };
    if (arg.card) return extractCardTexts(arg.card);
    if (arg.text) return arg.text;
  }
  return '';
}

/** Get all sendResult call contents (card text or raw text) */
export function allNotices(sendResultMock: ReturnType<typeof import('vitest').vi.fn>): string[] {
  return sendResultMock.mock.calls.map((call) => {
    const arg = call[0] as { text?: string; card?: unknown };
    if (arg.card) return extractCardTexts(arg.card);
    if (arg.text) return arg.text;
    return '';
  });
}
