#!/usr/bin/env node
/**
 * Test session resumption with threadId.
 *
 * Prerequisite: run `bun run build` first (this script imports from dist/).
 */

import { CodexExecRunner } from '../dist/runner/codex/index.js';
import { CodexSessionReader } from '../dist/session/codex/index.js';

async function main() {
  console.log('=== CodexExecRunner Resume Test ===\n');

  const sessionReader = new CodexSessionReader();
  const runner = new CodexExecRunner({
    binary: 'codex',
    model: 'glm-5.2',
    stopGraceMs: 30000,
    sessionReader,
  });

  // First turn: create a session
  console.log('=== Turn 1: Initial message ===\n');
  const startTime = Date.now();
  let sessionId = '';

  for await (const event of runner.run('Remember this number: 42', { cwd: process.cwd() })) {
    if (event.type === 'system' && event.subtype === 'init') {
      sessionId = event.session_id;
      console.log(`Session created: ${sessionId}`);
    }
    if (event.type === 'result') {
      console.log(`Turn 1 complete: ${event.subtype}, elapsed=${Date.now() - startTime}ms`);
    }
  }

  if (!sessionId) {
    console.error('❌ FAIL: No session ID obtained');
    process.exit(1);
  }

  // Second turn: resume the session
  console.log('\n=== Turn 2: Resume with threadId ===\n');
  const startTime2 = Date.now();
  let foundReference = false;

  for await (const event of runner.run('What number did I ask you to remember?', {
    cwd: process.cwd(),
    sessionId,
  })) {
    if (event.type === 'assistant') {
      const text = event.message?.content?.find((c) => c.type === 'text')?.text;
      if (text && text.includes('42')) {
        foundReference = true;
        console.log(`Found reference to 42: "${text}"`);
      }
    }
    if (event.type === 'result') {
      console.log(`Turn 2 complete: ${event.subtype}, elapsed=${Date.now() - startTime2}ms`);
    }
  }

  if (!foundReference) {
    console.error('❌ FAIL: Session did not resume properly (did not reference previous context)');
    process.exit(1);
  }

  console.log('\n✅ PASS: Session resume works correctly');
  process.exit(0);
}

main();
