import { describe, it, expect } from 'vitest';
import { reduceRunState, createInitialRunState } from '../../src/card/run-state.js';
import type { PlanEvent, FileChangeEvent } from '../../src/runner/index.js';

describe('reduceRunState - PlanEvent', () => {
  it('should store a single plan snapshot verbatim', () => {
    const state = createInitialRunState('run-1');
    const planEvent: PlanEvent = {
      type: 'plan',
      plan: '✅ #1 Analyze\n⬜ #2 Implement',
      timestamp: '2026-07-05T10:00:00Z',
    };

    const result = reduceRunState(state, planEvent);

    expect(result.plan).toBe('✅ #1 Analyze\n⬜ #2 Implement');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      kind: 'plan',
      content: '✅ #1 Analyze\n⬜ #2 Implement',
      active: true,
      timestamp: '2026-07-05T10:00:00Z',
    });
  });

  it('should keep only the latest full snapshot after status changes', () => {
    let state = createInitialRunState('run-1');
    const snapshots = [
      ['✅ #1 A', '✅ #2 B', '⬜ #3 C', '⬜ #4 D', '⬜ #5 E'].join('\n'),
      ['✅ #1 A', '✅ #2 B', '🔄 #3 C', '⬜ #4 D', '⬜ #5 E'].join('\n'),
      ['✅ #1 A', '✅ #2 B', '✅ #3 C', '🔄 #4 D', '⬜ #5 E'].join('\n'),
    ];

    for (const plan of snapshots) {
      state = reduceRunState(state, { type: 'plan', plan });
    }

    expect(state.plan).toBe(snapshots[2]);
    expect(state.blocks).toHaveLength(1);
    const planBlock = state.blocks[0] as { kind: 'plan'; content: string };
    expect(planBlock.content).toBe(snapshots[2]);
    // Whole-list snapshots must not stack up in the plan panel.
    expect(planBlock.content.match(/#1 A/g)).toHaveLength(1);
    expect(planBlock.content).not.toContain('🔄 #3 C');
  });

  it('should not duplicate repeated identical snapshots', () => {
    let state = createInitialRunState('run-1');
    const snapshot = [
      '✅ #1 A',
      '✅ #2 B',
      '🔄 #3 C',
      '⬜ #4 D',
      '⬜ #5 E',
      '⬜ #6 F',
      '⬜ #7 G',
      '⬜ #8 H',
      '⬜ #9 I',
    ].join('\n');

    for (let i = 0; i < 5; i++) {
      state = reduceRunState(state, { type: 'plan', plan: snapshot });
    }

    expect(state.plan).toBe(snapshot);
    expect(state.blocks).toHaveLength(1);
    expect((state.plan ?? '').match(/#1 A/g)).toHaveLength(1);
  });

  it('should truncate long plan text', () => {
    const state = createInitialRunState('run-1');
    const planEvent: PlanEvent = {
      type: 'plan',
      plan: 'A'.repeat(10000),
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

    // MAX_BLOCKS = 24，keepLatestBlocks 保最新弃最旧：被淘汰的是 file0–file5，
    // 窗口内最早的 file6 仍在首位，最新写入的 file29 留在末位。
    expect(state.blocks.length).toBe(24);
    const paths = state.blocks.map((b) => (b as { path: string }).path);
    expect(paths[0]).toBe('/src/file6.ts');
    expect(paths[paths.length - 1]).toBe('/src/file29.ts');
  });
});
