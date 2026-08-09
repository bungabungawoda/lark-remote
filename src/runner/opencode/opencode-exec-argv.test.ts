import { describe, it, expect } from 'vitest';
import { buildOpencodeRunArgs } from './argv.js';

describe('buildOpencodeRunArgs', () => {
  it('new session: outputs base args without sessionId', () => {
    const args = buildOpencodeRunArgs({});
    expect(args).toEqual(['run', '--format', 'json', '--auto']);
  });

  it('new session with model: includes -m', () => {
    const args = buildOpencodeRunArgs({ model: 'anthropic/claude-sonnet-4-20250514' });
    expect(args).toContain('-m');
    expect(args).toContain('anthropic/claude-sonnet-4-20250514');
  });

  it('resume session: includes -s with sessionId', () => {
    const args = buildOpencodeRunArgs({ sessionId: 'ses_123abc' });
    expect(args).toContain('-s');
    expect(args).toContain('ses_123abc');
  });

  it('all options together', () => {
    const args = buildOpencodeRunArgs({
      model: 'anthropic/claude-sonnet-4-20250514',
      sessionId: 'ses_123abc',
    });
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '-m',
      'anthropic/claude-sonnet-4-20250514',
      '-s',
      'ses_123abc',
    ]);
  });

  it('no model: does not include -m', () => {
    const args = buildOpencodeRunArgs({});
    expect(args).not.toContain('-m');
  });

  it('no agent: does not include --agent', () => {
    const args = buildOpencodeRunArgs({ model: 'anthropic/claude-sonnet-4-20250514' });
    expect(args).not.toContain('--agent');
  });
});
