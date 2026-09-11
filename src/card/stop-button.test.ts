import { describe, it, expect } from 'vitest';
import { stopButton } from './card-shared.js';

describe('stopButton factories', () => {
  it('stopButton returns button with behaviors callback', () => {
    const result = stopButton('run-456');
    expect(result).toEqual({
      tag: 'button',
      // cardButton() 统一显式 plain_text（SDK normalizer 原本会补全，渲染等价）
      text: { tag: 'plain_text', content: '⏹ 停止' },
      type: 'danger',
      behaviors: [{ type: 'callback', value: { cmd: 'stop', runId: 'run-456' } }],
    });
  });
});
