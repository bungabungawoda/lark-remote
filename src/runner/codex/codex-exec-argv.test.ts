import { describe, it, expect } from 'vitest';
import { buildCodexExecArgs } from './argv.js';

describe('buildCodexExecArgs', () => {
  it('builds new-session args without threadId', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project' });
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--skip-git-repo-check',
      '-C',
      '/tmp/project',
      '-',
    ]);
  });

  it('builds resume args with threadId', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project', threadId: 'thread-abc123' });
    expect(args).toEqual([
      'exec',
      '--sandbox',
      'danger-full-access',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--skip-git-repo-check',
      '-C',
      '/tmp/project',
      'resume',
      '--json',
      'thread-abc123',
      '-',
    ]);
  });

  it('includes -m flag when model is provided', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project', model: 'glm-5.2' });
    expect(args).toContain('-m');
    expect(args).toContain('glm-5.2');
  });

  it('does not include -m flag when model is omitted', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project' });
    expect(args).not.toContain('-m');
  });

  it('always includes approval_policy=never', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project' });
    const idx = args.indexOf('-c');
    expect(args[idx + 1]).toBe('approval_policy="never"');
  });

  it('always includes stdin dash for prompt', () => {
    const newArgs = buildCodexExecArgs({ cwd: '/tmp/project' });
    expect(newArgs[newArgs.length - 1]).toBe('-');

    const resumeArgs = buildCodexExecArgs({ cwd: '/tmp/project', threadId: 'tid' });
    expect(resumeArgs[resumeArgs.length - 1]).toBe('-');
  });

  it('includes -c model_provider when modelProvider is provided', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project', modelProvider: 'anthropic' });
    expect(args).toContain('-c');
    expect(args).toContain('model_provider="anthropic"');
  });

  it('does not include model_provider when modelProvider is omitted', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project' });
    expect(args).not.toContain('model_provider=');
  });

  it('includes -c model_reasoning_effort when reasoningEffort is provided', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project', reasoningEffort: 'high' });
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it('does not include model_reasoning_effort when reasoningEffort is omitted', () => {
    const args = buildCodexExecArgs({ cwd: '/tmp/project' });
    expect(args).not.toContain('model_reasoning_effort=');
  });

  it('includes all optional flags together', () => {
    const args = buildCodexExecArgs({
      cwd: '/tmp/project',
      model: 'o3',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      threadId: 'thread-xyz',
    });
    expect(args).toContain('-m');
    expect(args).toContain('o3');
    expect(args).toContain('model_provider="openai"');
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('resume');
    expect(args).toContain('thread-xyz');
  });
});
