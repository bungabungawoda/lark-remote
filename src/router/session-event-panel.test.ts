import { describe, it, expect } from 'vitest';
import { sessionEventPanel } from './card-helpers.js';

type PanelResult = {
  header?: { title?: { content?: string } };
  expanded?: boolean;
};

describe('sessionEventPanel', () => {
  it('creates collapsible with user label', () => {
    const ev = { type: 'user', content: 'hello' };
    const result = sessionEventPanel(ev, 0, 1, 2) as PanelResult;
    expect(result.header!.title!.content).toContain('👤 你');
  });

  it('creates collapsible with assistant label', () => {
    const ev = { type: 'assistant', content: 'hi there' };
    const result = sessionEventPanel(ev, 0, 1, 2) as PanelResult;
    expect(result.header!.title!.content).toContain('🤖 Claude');
  });

  it('handles tail expanded count', () => {
    const ev = { type: 'user', content: 'test' };
    // Last 2 events expanded, others collapsed
    expect((sessionEventPanel(ev, 0, 3, 2) as PanelResult).expanded).toBe(false); // index 0, total 3, last 2 are indices 1,2
    expect((sessionEventPanel(ev, 1, 3, 2) as PanelResult).expanded).toBe(true); // index 1
    expect((sessionEventPanel(ev, 2, 3, 2) as PanelResult).expanded).toBe(true); // index 2
  });
});
