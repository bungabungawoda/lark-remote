import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  vi.restoreAllMocks();
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

  it('lists saved aliases with new structure', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('a', '/tmp/a');
    store.save('b', '/tmp/b');
    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name).sort()).toEqual(['a', 'b']);
    // Each entry has path and lastUsedAt (save 即视为使用，时间戳应为当前时刻)
    expect(entries[0].path).toBe('/tmp/a');
    expect(entries[0].lastUsedAt).toBeGreaterThan(0);
    expect(entries[1].path).toBe('/tmp/b');
    expect(entries[1].lastUsedAt).toBeGreaterThan(0);
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

  // --- Migration tests ---

  it('migrates old string format to new object format with lastUsedAt=0', () => {
    // Write old format: { "wx": "/tmp/wx" }
    fs.writeFileSync(workspaceFile, JSON.stringify({ wx: '/tmp/wx' }), 'utf-8');

    const store = new WorkspaceStore(workspaceFile);
    expect(store.get('wx')).toBe('/tmp/wx');
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ name: 'wx', path: '/tmp/wx', lastUsedAt: 0 });

    // Migration should persist the new format to disk
    const disk = JSON.parse(fs.readFileSync(workspaceFile, 'utf-8'));
    expect(disk.wx).toEqual({ path: '/tmp/wx', lastUsedAt: 0 });
  });

  it('migrates mixed old and new format entries', () => {
    // Write mixed: one old string, one new object missing lastUsedAt
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify({
        old: '/tmp/old',
        partial: { path: '/tmp/partial' },
      }),
      'utf-8',
    );

    const store = new WorkspaceStore(workspaceFile);
    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === 'old')).toEqual({
      name: 'old',
      path: '/tmp/old',
      lastUsedAt: 0,
    });
    expect(entries.find((e) => e.name === 'partial')).toEqual({
      name: 'partial',
      path: '/tmp/partial',
      lastUsedAt: 0,
    });

    // Both migrated and persisted
    const disk = JSON.parse(fs.readFileSync(workspaceFile, 'utf-8'));
    expect(disk.old).toEqual({ path: '/tmp/old', lastUsedAt: 0 });
    expect(disk.partial).toEqual({ path: '/tmp/partial', lastUsedAt: 0 });
  });

  it('preserves lastUsedAt when loading new format with existing value', () => {
    const ts = 1755123456789;
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify({
        proj: { path: '/tmp/proj', lastUsedAt: ts },
      }),
      'utf-8',
    );

    const store = new WorkspaceStore(workspaceFile);
    const entries = store.list();
    expect(entries[0].lastUsedAt).toBe(ts);
  });

  it('no migration write-back when all entries already in new format', () => {
    const ts = 1755123456789;
    const content = JSON.stringify({ proj: { path: '/tmp/proj', lastUsedAt: ts } });
    fs.writeFileSync(workspaceFile, content, 'utf-8');

    // Record mtime before load
    const mtimeBefore = fs.statSync(workspaceFile).mtimeMs;

    // Small delay to ensure mtime would differ if file was rewritten
    const store = new WorkspaceStore(workspaceFile);
    // Access store to suppress unused warning
    expect(store.get('proj')).toBe('/tmp/proj');

    const mtimeAfter = fs.statSync(workspaceFile).mtimeMs;
    // File should NOT be rewritten when no migration needed
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  // --- touch() tests ---

  it('touch() updates lastUsedAt and persists', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('proj', '/tmp/proj');

    const before = Date.now();
    store.touch('proj');
    const after = Date.now();

    const entries = store.list();
    const touched = entries.find((e) => e.name === 'proj');
    expect(touched!.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(touched!.lastUsedAt).toBeLessThanOrEqual(after);
  });

  it('touch() persists lastUsedAt across restart', () => {
    const store1 = new WorkspaceStore(workspaceFile);
    store1.save('proj', '/tmp/proj');
    store1.touch('proj');

    const entries1 = store1.list();
    const ts1 = entries1.find((e) => e.name === 'proj')!.lastUsedAt;
    expect(ts1).toBeGreaterThan(0);

    // Simulate restart
    const store2 = new WorkspaceStore(workspaceFile);
    const entries2 = store2.list();
    const ts2 = entries2.find((e) => e.name === 'proj')!.lastUsedAt;
    expect(ts2).toBe(ts1);
  });

  it('touch() on non-existent name is a no-op', () => {
    const store = new WorkspaceStore(workspaceFile);
    // Should not throw
    expect(() => store.touch('nonexistent')).not.toThrow();
  });

  it('keeps recent order strict when saves happen in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1750000000000);
    const store = new WorkspaceStore(workspaceFile);
    store.save('alpha', '/tmp/alpha');
    store.save('first', '/tmp/first');
    store.save('second', '/tmp/second');

    const byName = new Map(store.list().map((e) => [e.name, e.lastUsedAt]));
    expect(byName.get('second')!).toBeGreaterThan(byName.get('first')!);
    expect(byName.get('first')!).toBeGreaterThan(byName.get('alpha')!);

    // Use "first" in the same millisecond — it should become strictly most recent.
    store.touch('first');
    const afterTouch = new Map(store.list().map((e) => [e.name, e.lastUsedAt]));
    expect(afterTouch.get('first')!).toBeGreaterThan(afterTouch.get('second')!);
  });

  it('save() stamps lastUsedAt (save 即视为使用)', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('proj', '/tmp/proj');
    const entries = store.list();
    expect(entries[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('save() over existing entry bumps lastUsedAt (re-save 也算使用)', () => {
    const store = new WorkspaceStore(workspaceFile);
    store.save('proj', '/tmp/proj');
    const first = store.list()[0].lastUsedAt;

    // 稍等片刻再覆盖保存，时间戳应前进
    const store2 = new WorkspaceStore(workspaceFile);
    store2.save('proj', '/tmp/proj-updated');
    const second = store2.list()[0].lastUsedAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
