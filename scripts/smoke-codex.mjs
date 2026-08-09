#!/usr/bin/env node
/**
 * Quick smoke test for CodexExecRunner.
 * Run with: node scripts/smoke-codex.mjs
 *
 * Prerequisite: run `bun run build` first (this script imports from dist/).
 */

import { CodexExecRunner } from '../dist/runner/codex/index.js';
import { CodexSessionReader } from '../dist/session/codex/index.js';

async function main() {
  console.log('=== CodexExecRunner Smoke Test ===\n');

  const sessionReader = new CodexSessionReader();
  const runner = new CodexExecRunner({
    binary: 'codex',
    model: 'glm-5.2',
    stopGraceMs: 30000,
    sessionReader,
  });

  console.log('1. Runner kind:', runner.kind);
  console.log('2. Testing simple prompt...\n');

  const startTime = Date.now();

  try {
    let eventCount = 0;
    let hasSystemInit = false;
    let hasResult = false;
    let sawText = false;

    for await (const event of runner.run('Say "hello world" in exactly 3 words', {
      cwd: process.cwd(),
    })) {
      eventCount++;

      if (event.type === 'system' && event.subtype === 'init') {
        hasSystemInit = true;
        console.log(
          `[${new Date().toISOString()}] SYSTEM init: session_id=${event.session_id}, cwd=${event.cwd}, model=${event.model}`,
        );
      }

      if (event.type === 'assistant') {
        const text = event.message?.content?.find((c) => c.type === 'text')?.text;
        if (text) {
          sawText = true;
          console.log(`[${new Date().toISOString()}] ASSISTANT: ${text.slice(0, 100)}...`);
        }
        const toolUse = event.message?.content?.find((c) => c.type === 'tool_use');
        if (toolUse) {
          console.log(
            `[${new Date().toISOString()}] TOOL_USE: ${toolUse.name} - ${JSON.stringify(toolUse.input).slice(0, 50)}`,
          );
        }
      }

      if (event.type === 'user') {
        const toolResult = event.message?.content?.find((c) => c.type === 'tool_result');
        if (toolResult) {
          const content =
            typeof toolResult.content === 'string'
              ? toolResult.content.slice(0, 100)
              : JSON.stringify(toolResult.content).slice(0, 100);
          console.log(
            `[${new Date().toISOString()}] TOOL_RESULT: is_error=${toolResult.is_error}, content=${content}...`,
          );
        }
      }

      if (event.type === 'result') {
        hasResult = true;
        const elapsed = Date.now() - startTime;
        console.log(
          `[${new Date().toISOString()}] RESULT: subtype=${event.subtype}, session_id=${event.session_id}, elapsed=${elapsed}ms`,
        );
        if (event.errorMessage) {
          console.log(`  ERROR: ${event.errorMessage}`);
        }
        if (event.usage) {
          console.log(
            `  USAGE: input=${event.usage.input_tokens}, output=${event.usage.output_tokens}`,
          );
        }
      }

      // Safety: don't iterate forever
      if (eventCount > 100) {
        console.log(' SAFETY: Too many events, stopping iteration');
        break;
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`\n=== Results ===`);
    console.log(`Total events: ${eventCount}`);
    console.log(`Has system init: ${hasSystemInit}`);
    console.log(`Has text output: ${sawText}`);
    console.log(`Has result: ${hasResult}`);
    console.log(`Total elapsed: ${elapsed}ms`);

    // Validation
    if (!hasSystemInit) {
      console.error('\n❌ FAIL: No system init event');
      process.exit(1);
    }
    if (!hasResult) {
      console.error('\n❌ FAIL: No result event');
      process.exit(1);
    }
    if (elapsed > 60000) {
      console.error('\n❌ FAIL: Took more than 60 seconds');
      process.exit(1);
    }

    console.log('\n✅ PASS: All checks passed');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ ERROR:', err);
    process.exit(1);
  }
}

main();
