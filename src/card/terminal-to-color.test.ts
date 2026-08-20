import { describe, expect, it } from 'vitest';
import { terminalToColor } from './card-shared.js';

describe('terminalToColor', () => {
  it('maps done to green', () => {
    expect(terminalToColor('done')).toBe('green');
  });

  it('maps error to red', () => {
    expect(terminalToColor('error')).toBe('red');
  });

  it('maps interrupted to grey', () => {
    expect(terminalToColor('interrupted')).toBe('grey');
  });

  it('maps idle_timeout to orange', () => {
    expect(terminalToColor('idle_timeout')).toBe('orange');
  });

  // background_running 已移除
  it('maps running to blue', () => {
    expect(terminalToColor('running')).toBe('blue');
  });

  it('maps finalizing to orange', () => {
    expect(terminalToColor('finalizing')).toBe('orange');
  });
});
