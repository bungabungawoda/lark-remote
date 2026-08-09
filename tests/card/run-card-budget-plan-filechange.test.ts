import { describe, it, expect } from 'vitest';
import { renderRunCard } from '../../src/card/run-renderer.js';
import { createInitialRunState } from '../../src/card/run-state.js';
import type { PlanEvent, FileChangeEvent } from '../../src/runner/index.js';

describe('run card 28KB budget - plan/file_change', () => {
  it('should fit within 28KB with 20 file changes', () => {
    const state = createInitialRunState('run-1');

    // Add 20 file change events
    for (let i = 0; i < 20; i++) {
      const fileEvent: FileChangeEvent = {
        type: 'file_change',
        path: `/src/components/Component${i}.tsx`,
        operation: 'edit',
        diff: `--- a/src/components/Component${i}.tsx\n+++ b/src/components/Component${i}.tsx\n@@ -1,5 +1,7 @@\n+// Added import\n import { useState } from 'react';\n \n export function Component${i}() {\n-  return <div>Old</div>;\n+  return <div>New</div>;\n }\n`,
      };
      state.blocks.push({
        kind: 'file_change',
        path: fileEvent.path,
        operation: fileEvent.operation,
        diff: fileEvent.diff,
      });
    }

    const card = renderRunCard(state, { agentKind: 'claude' });
    const json = JSON.stringify(card);
    const bytes = Buffer.byteLength(json, 'utf8');

    // Should fit within 28KB budget even with 20 file changes (collapsed)
    expect(bytes).toBeLessThanOrEqual(28_000);
  });

  it('should fit within 28KB with multiple plan events', () => {
    const state = createInitialRunState('run-1');

    // Add 10 plan events
    for (let i = 0; i < 10; i++) {
      const planEvent: PlanEvent = {
        type: 'plan',
        plan: `Step ${i + 1}: Perform some analysis and make decisions about the codebase structure.\nThis is a detailed plan step that explains what the agent will do.`,
      };
      state.blocks.push({
        kind: 'plan',
        content: state.plan ? state.plan + planEvent.plan : planEvent.plan,
        active: false,
      });
      state.plan = state.plan ? state.plan + planEvent.plan : planEvent.plan;
    }

    const card = renderRunCard(state, { agentKind: 'codex' });
    const json = JSON.stringify(card);
    const bytes = Buffer.byteLength(json, 'utf8');

    expect(bytes).toBeLessThanOrEqual(28_000);
  });
});
