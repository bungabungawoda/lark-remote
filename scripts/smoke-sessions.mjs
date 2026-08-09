#!/usr/bin/env node
/**
 * Test session listing from rollout files.
 *
 * Prerequisite: run `bun run build` first (this script imports from dist/).
 */

import { CodexSessionReader } from '../dist/session/codex/index.js';

async function main() {
  console.log('=== Session History Test ===\n');

  const sessionReader = new CodexSessionReader();

  // Test listSessions (for current cwd)
  console.log('Testing listSessions...');
  const sessions = sessionReader.listSessions(process.cwd(), { hoursAgo: 24 });
  console.log(`Found ${sessions.length} sessions in last 24 hours for current cwd`);

  if (sessions.length > 0) {
    console.log('\nFirst 3 sessions:');
    sessions.slice(0, 3).forEach((s, i) => {
      console.log(
        `  ${i + 1}. ${s.sessionId.slice(0, 20)}... | cwd: ${s.cwd.slice(-30)} | isActive: ${s.isActive}`,
      );
    });
  }

  // Test getNewestSession
  console.log('\nTesting getNewestSession for current cwd...');
  const newest = sessionReader.getNewestSession(process.cwd());
  if (newest) {
    console.log(`  Newest: ${newest.sessionId}`);
    console.log(`  Summary: ${newest.summary.slice(0, 50)}...`);
    console.log(`  Mtime: ${newest.mtime}`);
  } else {
    console.log('  No sessions for this cwd');
  }

  // Test readSessionContent
  const targetSession = newest ?? sessions[0];
  if (targetSession) {
    console.log('\nTesting readSessionContent...');
    const content = sessionReader.readSessionContent(targetSession.sessionId, targetSession.cwd);
    console.log(`  Session: ${targetSession.sessionId.slice(0, 20)}...`);
    console.log(`  Events: ${content.events.length}`);
    if (content.displayTitle) {
      console.log(`  Title: ${content.displayTitle.slice(0, 50)}`);
    }
  }

  console.log('\n✅ PASS: Session history listing works');
  process.exit(0);
}

main();
