import { describe, it, expect } from 'vitest';
import { stopButton } from './card-shared.js';

describe('stopButton factories', () => {
  it('stopButton returns button with behaviors callback', () => {
    const result = stopButton('run-456');
    expect(result).toEqual({
      tag: 'button',
      text: { content: '⏹ 停止' },
      type: 'danger',
      behaviors: [{ type: 'callback', value: { cmd: 'stop', runId: 'run-456' } }],
    });
  });
});
