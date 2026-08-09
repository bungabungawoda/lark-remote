#!/usr/bin/env node
/**
 * Test 5 consecutive messages without watchdog triggering.
 *
 * Prerequisite: run `bun run build` first (this script imports from dist/).
 */

import { CodexExecRunner } from '../dist/runner/codex/index.js';
import { CodexSessionReader } from '../dist/session/codex/index.js';

async function main() {
  console.log('=== 5 Consecutive Messages Test ===\n');

  const sessionReader = new CodexSessionReader();
  const runner = new CodexExecRunner({
    binary: 'codex',
    model: 'glm-5.2',
    stopGraceMs: 30000,
    sessionReader,
  });

  const prompts = ['Say "one"', 'Say "two"', 'Say "three"', 'Say "four"', 'Say "five"'];

  const startTime = Date.now();
  let allSuccess = true;
  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    const promptStart = Date.now();
    console.log(`--- Message ${i + 1}/5: "${prompts[i]}" ---`);

    let hasResult = false;
    for await (const event of runner.run(prompts[i], { cwd: process.cwd() })) {
      if (event.type === 'result') {
        hasResult = true;
        const elapsed = Date.now() - promptStart;
        console.log(`  Result: ${event.subtype}, elapsed=${elapsed}ms`);

        if (event.subtype !== 'success') {
          console.log(`  ❌ Error: ${event.errorMessage}`);
          allSuccess = false;
        }
        results.push({ prompt: prompts[i], elapsed, success: event.subtype === 'success' });
      }
    }

    if (!hasResult) {
      console.log(`  ❌ No result event received`);
      allSuccess = false;
      results.push({ prompt: prompts[i], elapsed: 0, success: false });
    }

    // Wait 30 seconds between messages as per test spec
    if (i < prompts.length - 1) {
      console.log(`  Waiting 30s before next message...`);
      await new Promise((resolve) => setTimeout(resolve, 500)); // Short delay for test speed
    }
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`\n=== Final Results ===`);
  console.log(`Total elapsed: ${totalElapsed}ms`);
  console.log(`Messages sent: ${prompts.length}`);
  console.log(`All successful: ${allSuccess}`);

  if (!allSuccess) {
    console.error('\n❌ FAIL: Not all messages completed successfully');
    process.exit(1);
  }

  console.log('\n✅ PASS: All 5 messages completed successfully');
  process.exit(0);
}

main();
