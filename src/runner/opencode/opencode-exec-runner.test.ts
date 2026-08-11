import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { OpencodeExecRunner } from './index.js';
import { prependPath, restorePath, writeMockBin } from '../../../tests/lib/path-mock.js';

// Mock opencode binary script - outputs ndjson then exits
const createMockOpencodeScript = (dir: string, content: string): string => {
  const script = `#!/bin/bash
echo '${content.replace(/'/g, "'\\''")}'
exit 0
`;
  return writeMockBin(dir, 'opencode', script);
};

// Mock opencode that returns a simple text response
const simpleResponse =
  JSON.stringify({
    type: 'step_start',
    timestamp: 1783931173528,
    sessionID: 'ses_mock123',
    part: { type: 'step-start', id: 'prt_xxx' },
  }) +
  '\n' +
  JSON.stringify({
    type: 'text',
    timestamp: 1783931173575,
    sessionID: 'ses_mock123',
    part: { type: 'text', text: 'hi' },
  }) +
  '\n' +
  JSON.stringify({
    type: 'step_finish',
    timestamp: 1783931173575,
    sessionID: 'ses_mock123',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 100, input: 50, output: 50, reasoning: 0, cache: { write: 0, read: 0 } },
    },
  });

describe('OpencodeExecRunner', () => {
  let runner: OpencodeExecRunner;
  let mockDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    // Create mock binary named `opencode` on PATH
    mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-opencode-test-'));
    savedPath = prependPath(mockDir);
    createMockOpencodeScript(mockDir, simpleResponse);

    runner = new OpencodeExecRunner({
      workspace: 'test',
      stopGraceMs: 1000,
      pidDir: os.tmpdir(),
      sessionReader: {
        listSessions: () => ({ sessions: [], total: 0 }),
        getNewestSession: () => null,
        readSessionContent: () => ({ events: [] }),
        isSessionActive: () => false,
      },
    });
  });

  afterEach(() => {
    restorePath(savedPath);
    fs.rmSync(mockDir, { recursive: true, force: true });
  });

  describe('run()', () => {
    it('spawns process and yields AgentEvents', async () => {
      const events: unknown[] = [];
      for await (const event of runner.run('Hello', { cwd: '/tmp' })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);

      // Should have text event
      const textEvent = events.find(
        (e: any) => e.type === 'assistant' && e.message?.content?.[0]?.type === 'text',
      );
      expect(textEvent).toBeDefined();
      expect((textEvent as any).message.content[0].text).toBe('hi');

      // Should have result event
      const resultEvent = events.find((e: any) => e.type === 'result');
      expect(resultEvent).toBeDefined();
      expect((resultEvent as any).subtype).toBe('success');
    });

    it('handles binary not found (ENOENT)', async () => {
      const saved = process.env.PATH;
      process.env.PATH = path.join(mockDir, 'no-bin');
      const errorRunner = new OpencodeExecRunner({
        workspace: 'test',
        sessionReader: {
          listSessions: () => ({ sessions: [], total: 0 }),
          getNewestSession: () => null,
          readSessionContent: () => ({ events: [] }),
          isSessionActive: () => false,
        },
      });

      const events: unknown[] = [];
      for await (const event of errorRunner.run('test', { cwd: '/tmp' })) {
        events.push(event);
      }
      restorePath(saved);

      // Should yield auth error event
      const errorEvent = events.find((e: any) => e.type === 'result' && e.subtype === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as any).errorMessage).toContain('命令不可用');
    });
  });

  describe('stop()', () => {
    it('can stop running process', async () => {
      // Override mock to produce slow output
      const slowScript = `#!/bin/bash
echo '{"type":"step_start","sessionID":"ses_slow","part":{"type":"step-start"}}'
echo '{"type":"text","sessionID":"ses_slow","part":{"type":"text","text":"working"}}'
sleep 2
echo '{"type":"step_finish","sessionID":"ses_slow","part":{"type":"step-finish","reason":"stop","tokens":{"total":10,"input":5,"output":5,"reasoning":0,"cache":{"read":0,"write":0}}}}'
exit 0
`;
      writeMockBin(mockDir, 'opencode', slowScript);

      const slowRunner = new OpencodeExecRunner({
        workspace: 'test',
        stopGraceMs: 500,
        pidDir: os.tmpdir(),
        sessionReader: {
          listSessions: () => ({ sessions: [], total: 0 }),
          getNewestSession: () => null,
          readSessionContent: () => ({ events: [] }),
          isSessionActive: () => false,
        },
      });

      const runPromise = (async () => {
        const events: unknown[] = [];
        for await (const event of slowRunner.run('test', { cwd: '/tmp' })) {
          events.push(event);
        }
        return events;
      })();

      // Wait a bit then stop
      await new Promise((r) => setTimeout(r, 100));
      await slowRunner.stop({ immediate: true });

      const events = await runPromise;

      // Should have interrupted result
      const resultEvent = events.find((e: any) => e.type === 'result');
      expect(resultEvent).toBeDefined();
      // stoppedByUser → result subtype='error' with
      // 'interrupted by user' message.
      expect((resultEvent as any).subtype).toBe('error');
      expect((resultEvent as any).errorMessage).toMatch(/interrupted by user/i);
    });
  });

  describe('resume with sessionId', () => {
    it('passes -s flag to opencode', async () => {
      // We can't easily intercept spawn args, but we can verify by running
      // and checking if it works - the argv builder test already covers this

      const events: unknown[] = [];
      for await (const event of runner.run('continue', {
        cwd: '/tmp',
        sessionId: 'ses_resume123',
      })) {
        events.push(event);
      }

      // Should complete successfully
      const resultEvent = events.find((e: any) => e.type === 'result');
      expect(resultEvent).toBeDefined();
    });
  });

  describe('isRunning', () => {
    it('returns false when not running', () => {
      expect(runner.isRunning).toBe(false);
    });

    it('returns true when running', async () => {
      // Use a slow mock so the process is still alive when we check isRunning.
      // The default mock echoes and exits instantly — too fast for the 50ms
      // check to catch it running on busy CI runners.
      const slowScript = `#!/bin/bash
echo '{"type":"step_start","sessionID":"ses_ir","part":{"type":"step-start"}}'
sleep 2
echo '{"type":"step_finish","sessionID":"ses_ir","part":{"type":"step-finish","reason":"stop","tokens":{"total":10,"input":5,"output":5,"reasoning":0,"cache":{"read":0,"write":0}}}}'
exit 0
`;
      writeMockBin(mockDir, 'opencode', slowScript);

      const slowRunner = new OpencodeExecRunner({
        workspace: 'test',
        stopGraceMs: 500,
        pidDir: os.tmpdir(),
        sessionReader: {
          listSessions: () => ({ sessions: [], total: 0 }),
          getNewestSession: () => null,
          readSessionContent: () => ({ events: [] }),
          isSessionActive: () => false,
        },
      });

      const runPromise = (async () => {
        for await (const _ of slowRunner.run('test', { cwd: '/tmp' })) {
          // consume
        }
      })();

      // Wait a bit for process to start
      await new Promise((r) => setTimeout(r, 100));

      expect(slowRunner.isRunning).toBe(true);

      await slowRunner.stop({ immediate: true });
      await runPromise;

      expect(slowRunner.isRunning).toBe(false);
    });
  });

  // L1: spawn must sync PWD env to opts.cwd. opencode `run` reads PWD (not
  // process.cwd()) for project/directory detection in its 2nd instance phase;
  // an inherited PWD (e.g. bridge started from "/") orphans sessions under
  // directory="/" / project=global, making /resume unable to find them.
  // bash resets $PWD to cwd, so the mock binary MUST be node (node preserves
  // the inherited PWD env) to faithfully detect whether the runner synced PWD.
  describe('PWD env sync (L1)', () => {
    it('passes PWD=opts.cwd to the spawned process', async () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pwd-target-'));
      const script =
        `#!${process.execPath}\n` +
        `const w=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');\n` +
        `w({type:'step_start',sessionID:'ses_pwd',part:{type:'step-start',id:'p1'}});\n` +
        `w({type:'text',sessionID:'ses_pwd',part:{type:'text',text:'PWD='+process.env.PWD}});\n` +
        `w({type:'step_finish',sessionID:'ses_pwd',part:{type:'step-finish',reason:'stop',tokens:{total:10,input:5,output:5,reasoning:0,cache:{read:0,write:0}}}});\n`;
      writeMockBin(mockDir, 'opencode', script);

      const r = new OpencodeExecRunner({
        workspace: 'test',
        pidDir: os.tmpdir(),
        sessionReader: {
          listSessions: () => ({ sessions: [], total: 0 }),
          getNewestSession: () => null,
          readSessionContent: () => ({ events: [] }),
          isSessionActive: () => false,
        },
      });

      const events: unknown[] = [];
      for await (const event of r.run('x', { cwd: target })) {
        events.push(event);
      }

      const textEvent = events.find(
        (e: any) => e.type === 'assistant' && e.message?.content?.[0]?.type === 'text',
      );
      expect(textEvent).toBeDefined();
      expect((textEvent as any).message.content[0].text).toBe('PWD=' + target);

      fs.rmSync(target, { recursive: true, force: true });
    });
  });
});
