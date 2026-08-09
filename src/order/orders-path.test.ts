import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { OrderStore } from './index.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-path-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('ordersPath respects configDir', () => {
  it('should write orders.json to the explicitly passed directory', () => {
    const configDir = makeTmpDir();
    const ordersPath = path.join(configDir, 'orders.json');

    const store = new OrderStore(ordersPath);
    store.save('test order');

    // orders.json should exist inside configDir, not in ~/.lark-remote/
    expect(fs.existsSync(ordersPath)).toBe(true);

    const raw = fs.readFileSync(ordersPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('test order');
  });

  it('should use different orders.json files for different configDirs', () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();
    const pathA = path.join(dirA, 'orders.json');
    const pathB = path.join(dirB, 'orders.json');

    const storeA = new OrderStore(pathA);
    const storeB = new OrderStore(pathB);

    storeA.save('order in A');

    // storeB should NOT see storeA's order
    expect(storeB.get()).toHaveLength(0);

    storeB.save('order in B');

    // Each store sees only its own orders
    const ordersA = storeA.get();
    const ordersB = storeB.get();
    expect(ordersA).toHaveLength(1);
    expect(ordersA[0].text).toBe('order in A');
    expect(ordersB).toHaveLength(1);
    expect(ordersB[0].text).toBe('order in B');

    // Files are in separate directories
    expect(fs.existsSync(pathA)).toBe(true);
    expect(fs.existsSync(pathB)).toBe(true);
  });

  it('index.ts should pass configDir-based ordersPath to CommandRouter', () => {
    // This test verifies the integration contract:
    // When CommandRouter is constructed in index.ts, it MUST receive
    // ordersPath: path.join(configDir, "orders.json") instead of
    // leaving it undefined (which falls back to ~/.lark-remote/orders.json).
    //
    // We verify this by checking that the current index.ts source
    // includes the ordersPath assignment.

    const indexSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.ts'), 'utf-8');

    // The router construction block should contain an ordersPath
    // that derives from configDir
    expect(
      indexSource,
      'index.ts must pass ordersPath: path.join(configDir, "orders.json") to CommandRouter',
    ).toMatch(/ordersPath\s*:\s*path\.join\s*\(\s*configDir\s*,\s*["']orders\.json["']\s*\)/);
  });
});
