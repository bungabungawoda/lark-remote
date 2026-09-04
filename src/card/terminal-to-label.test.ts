import { describe, expect, it } from 'vitest';
import { terminalToLabel } from './card-shared.js';

describe('terminalToLabel', () => {
  // background_running 已移除，映射到默认"运行中"
  it('maps every known terminal state to its label', () => {
    const expected: Array<[string, string]> = [
      ['done', '已完成'],
      ['error', '出错'],
      ['interrupted', '已终止'],
      ['idle_timeout', '已超时'],
      ['running', '运行中'],
      ['finalizing', '完成中'],
    ];
    for (const [terminal, label] of expected) {
      expect(terminalToLabel(terminal), `terminal=${terminal}`).toBe(label);
    }
  });
});
