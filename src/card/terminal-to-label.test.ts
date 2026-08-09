import { describe, it, expect } from 'vitest';
import { terminalToLabel } from './card-shared.js';

describe('terminalToLabel', () => {
  it('maps done to 已完成', () => {
    expect(terminalToLabel('done')).toBe('已完成');
  });

  it('maps error to 出错', () => {
    expect(terminalToLabel('error')).toBe('出错');
  });

  it('maps interrupted to 已终止', () => {
    expect(terminalToLabel('interrupted')).toBe('已终止');
  });

  it('maps idle_timeout to 已超时', () => {
    expect(terminalToLabel('idle_timeout')).toBe('已超时');
  });

  // background_running 已移除，映射到默认"运行中"
  it('maps running to 运行中', () => {
    expect(terminalToLabel('running')).toBe('运行中');
  });

  it('maps finalizing to 完成中', () => {
    expect(terminalToLabel('finalizing')).toBe('完成中');
  });

  it('accepts prefix parameter for header style', () => {
    expect(terminalToLabel('done', { prefix: 'Claude · ' })).toBe('Claude · 已完成');
    expect(terminalToLabel('error', { prefix: 'Claude · ' })).toBe('Claude · 出错');
    expect(terminalToLabel('running', { prefix: '🏃 ' })).toBe('🏃 运行中');
  });
});
