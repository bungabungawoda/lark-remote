import { describe, it, expect } from 'vitest';
import { reduceRunState, createInitialRunState } from '../../src/card/run-state.js';
import type { PlanEvent, FileChangeEvent } from '../../src/runner/index.js';

describe('reduceRunState - PlanEvent', () => {
  it('should accumulate plan text', () => {
    const state = createInitialRunState('run-1');
    const planEvent: PlanEvent = {
      type: 'plan',
      plan: 'Step 1: Analyze the codebase',
      timestamp: '2026-07-05T10:00:00Z',
    };

    const result = reduceRunState(state, planEvent);

    expect(result.plan).toContain('Step 1: Analyze the codebase');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      kind: 'plan',
      content: expect.stringContaining('Step 1'),
      active: true,
      timestamp: '2026-07-05T10:00:00Z',
    });
  });

  it('should accumulate multiple plan deltas', () => {
    let state = createInitialRunState('run-1');
    const planEvent1: PlanEvent = {
      type: 'plan',
      plan: 'Step 1: Analyze',
    };
    const planEvent2: PlanEvent = {
      type: 'plan',
      plan: '\nStep 2: Implement',
    };
    const planEvent3: PlanEvent = {
      type: 'plan',
      plan: '\nStep 3: Test',
    };

    state = reduceRunState(state, planEvent1);
    state = reduceRunState(state, planEvent2);
    state = reduceRunState(state, planEvent3);

    expect(state.plan).toContain('Step 1: Analyze');
    expect(state.plan).toContain('Step 2: Implement');
    expect(state.plan).toContain('Step 3: Test');
    // Plan is a single evolving document - one block, not one per delta.
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].kind).toBe('plan');
    const planBlock = state.blocks[0] as { kind: 'plan'; content: string };
    expect(planBlock.content).toContain('Step 1: Analyze');
    expect(planBlock.content).toContain('Step 2: Implement');
    expect(planBlock.content).toContain('Step 3: Test');
  });

  it('should truncate long plan text', () => {
    const state = createInitialRunState('run-1');
    const longPlan = 'A'.repeat(10000);
    const planEvent: PlanEvent = {
      type: 'plan',
      plan: longPlan,
    };

    const result = reduceRunState(state, planEvent);

    // MAX_REASONING_CHARS * 2 = 8000, should be truncated
    expect(result.plan!.length).toBeLessThanOrEqual(8000);
  });
});

describe('reduceRunState - FileChangeEvent', () => {
  it('should track file changes', () => {
    const state = createInitialRunState('run-1');
    const fileEvent: FileChangeEvent = {
      type: 'file_change',
      path: '/src/index.ts',
      operation: 'edit',
      diff: '```diff\n-old\n+new\n```',
      timestamp: '2026-07-05T10:00:00Z',
    };

    const result = reduceRunState(state, fileEvent);

    expect(result.blocks[0]).toEqual({
      kind: 'file_change',
      path: '/src/index.ts',
      operation: 'edit',
      diff: '```diff\n-old\n+new\n```',
      timestamp: '2026-07-05T10:00:00Z',
    });
  });

  it('should track multiple file changes', () => {
    let state = createInitialRunState('run-1');
    const fileEvent1: FileChangeEvent = {
      type: 'file_change',
      path: '/src/a.ts',
      operation: 'create',
    };
    const fileEvent2: FileChangeEvent = {
      type: 'file_change',
      path: '/src/b.ts',
      operation: 'edit',
    };
    const fileEvent3: FileChangeEvent = {
      type: 'file_change',
      path: '/src/c.ts',
      operation: 'delete',
    };

    state = reduceRunState(state, fileEvent1);
    state = reduceRunState(state, fileEvent2);
    state = reduceRunState(state, fileEvent3);

    expect(state.blocks).toHaveLength(3);
  });

  it('should keep only latest N file changes', () => {
    let state = createInitialRunState('run-1');
    for (let i = 0; i < 30; i++) {
      const fileEvent: FileChangeEvent = {
        type: 'file_change',
        path: `/src/file${i}.ts`,
        operation: 'edit',
      };
      state = reduceRunState(state, fileEvent);
    }

    // MAX_BLOCKS = 24
    expect(state.blocks.length).toBe(24);
  });
});
