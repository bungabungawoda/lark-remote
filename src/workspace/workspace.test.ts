import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceStore } from './index.js';

let tmpDir: string;
let workspaceFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-workspace-test-'));
  workspaceFile = path.join(tmpDir, 'workspace.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WorkspaceStore', () => {
  it('saves and retrieves an alias', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('proj', '/tmp/proj');
    expect(store.get('proj')).toBe('/tmp/proj');
    expect(store.has('proj')).toBe(true);
  });

  it('removes an alias', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('proj', '/tmp/proj');
    store.remove('proj');
    expect(store.has('proj')).toBe(false);
    expect(store.get('proj')).toBeUndefined();
  });

  it('lists saved aliases', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('a', '/tmp/a');
    store.save('b', '/tmp/b');
    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries.map(([k]) => k).sort()).toEqual(['a', 'b']);
  });

  it('persists across instances (simulates restart)', () => {
    const store1 = new WorkspaceStore(workspaceFile);
    store1.save('proj', '/tmp/proj');

    const store2 = new WorkspaceStore(workspaceFile);
    expect(store2.get('proj')).toBe('/tmp/proj');
  });

  it('corrupt file is reset and still usable (§9.10)', () => {
    fs.writeFileSync(workspaceFile, '{ broken json', 'utf-8');
    // Should not throw, treats as empty
    const store = new WorkspaceStore(workspaceFile);
    expect(store.list()).toHaveLength(0);

    // Can still save after corruption
    store.save('x', '/tmp');
    expect(store.has('x')).toBe(true);

    // Reloads fine now
    const store2 = new WorkspaceStore(workspaceFile);
    expect(store2.get('x')).toBe('/tmp');
  });

  it('missing file starts empty', () => {
    const store = new WorkspaceStore(workspaceFile);
    expect(store.list()).toHaveLength(0);
    expect(store.has('anything')).toBe(false);
  });
});
