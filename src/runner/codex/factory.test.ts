/**
 * Tests for createCodexRunner: serviceMode selects the concrete runner.
 */

import { describe, it, expect } from 'vitest';
import type { AgentSessionReader } from '../types.js';
import { createCodexRunner } from './factory.js';
import { CodexExecRunner } from './runner.js';
import { CodexAppServerRunner } from './app-server/runner.js';

function makeSessionReader(): AgentSessionReader {
  return {
    listSessions: () => ({ sessions: [], total: 0 }),
    getNewestSession: () => null,
    readSessionContent: () => ({ events: [] }),
    isSessionActive: () => false,
  };
}

describe('createCodexRunner', () => {
  const base = {
    pidDir: '/tmp/lark-test',
    workspace: '/home/user/project',
    sessionReader: makeSessionReader(),
  };

  it('returns CodexExecRunner by default', () => {
    const runner = createCodexRunner(base);
    expect(runner).toBeInstanceOf(CodexExecRunner);
  });

  it('returns CodexExecRunner for serviceMode exec', () => {
    const runner = createCodexRunner({ ...base, serviceMode: 'exec' });
    expect(runner).toBeInstanceOf(CodexExecRunner);
  });

  it('returns CodexAppServerRunner for serviceMode app-server', () => {
    const runner = createCodexRunner({
      ...base,
      serviceMode: 'app-server',
      sandbox: 'workspace-write',
      approvalPolicy: 'untrusted',
    });
    expect(runner).toBeInstanceOf(CodexAppServerRunner);

    const info = runner.getStatusInfo();
    expect(info.extras?.mode).toBe('app-server');
    expect(info.extras?.sandbox).toBe('workspace-write');
    expect(info.extras?.approvalPolicy).toBe('untrusted');
  });
});
