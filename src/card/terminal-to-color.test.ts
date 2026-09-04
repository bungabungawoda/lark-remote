import { describe, expect, it } from 'vitest';
import { terminalToColor } from './card-shared.js';

describe('terminalToColor', () => {
  // background_running 已移除，映射到默认色
  it('maps every known terminal state to its color', () => {
    const expected: Array<[string, string]> = [
      ['done', 'green'],
      ['error', 'red'],
      ['interrupted', 'grey'],
      ['idle_timeout', 'orange'],
      ['running', 'blue'],
      ['finalizing', 'orange'],
    ];
    for (const [terminal, color] of expected) {
      expect(terminalToColor(terminal), `terminal=${terminal}`).toBe(color);
    }
  });
});
