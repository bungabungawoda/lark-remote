import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OwnerBinder, formatPinGuidance } from './binder.js';
import { StartupContactStore } from './startup-contact.js';

vi.mock('./logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-binder-'));
  storePath = path.join(tmpDir, 'startup-contact.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OwnerBinder - unbound bootstrap', () => {
  it('generates a 4-digit PIN when unbound', () => {
    const store = new StartupContactStore(storePath);
    const binder = new OwnerBinder(store);

    expect(binder.isBound()).toBe(false);
    expect(binder.pendingPin).toMatch(/^\d{4}$/);
  });

  it('binds on correct PIN and clears the PIN', () => {
    const store = new StartupContactStore(storePath);
    const binder = new OwnerBinder(store);
    const pin = binder.pendingPin!;

    const decision = binder.classify('ou_owner1', pin, 'chat-1');

    expect(decision.kind).toBe('bind_success');
    expect(binder.isBound()).toBe(true);
    expect(binder.boundOpenId()).toBe('ou_owner1');
    expect(binder.pendingPin).toBeUndefined();
  });

  it('silently ignores wrong PIN and never binds', () => {
    const store = new StartupContactStore(storePath);
    const binder = new OwnerBinder(store);
    const pin = binder.pendingPin!;

    // 输错：静默，不绑定，PIN 保持不变
    expect(binder.classify('ou_x', 'not-a-pin', 'chat-x').kind).toBe('pin_wrong');
    expect(binder.isBound()).toBe(false);
    expect(binder.pendingPin).toBe(pin);

    // 多次输错仍不绑定、PIN 不变（无重生成）
    for (let i = 0; i < 20; i++) binder.classify('ou_x', 'not-a-pin', 'chat-x');
    expect(binder.isBound()).toBe(false);
    expect(binder.pendingPin).toBe(pin);
  });
});

describe('OwnerBinder - bound state', () => {
  function bindOwner(store: StartupContactStore, openId = 'ou_owner'): OwnerBinder {
    const binder = new OwnerBinder(store);
    binder.classify(openId, binder.pendingPin!, 'chat-owner');
    return binder;
  }

  it('admits owner and rejects everyone else', () => {
    const store = new StartupContactStore(storePath);
    const binder = bindOwner(store, 'ou_owner');

    expect(binder.classify('ou_owner', '/help', 'chat-owner').kind).toBe('owner');
    expect(binder.classify('ou_attacker', '/help', 'chat-attacker').kind).toBe('rejected');
    expect(binder.classify('ou_attacker2', 'hi', 'chat-attacker2').kind).toBe('rejected');
    expect(binder.rejectedCount).toBe(2);
  });

  it('isOwner reflects bound identity only', () => {
    const store = new StartupContactStore(storePath);
    const unbound = new OwnerBinder(store);
    expect(unbound.isOwner('ou_owner')).toBe(false);

    const binder = bindOwner(store, 'ou_owner');
    expect(binder.isOwner('ou_owner')).toBe(true);
    expect(binder.isOwner('ou_other')).toBe(false);
  });

  it('counts rejected card actions in the shared counter', () => {
    const store = new StartupContactStore(storePath);
    const binder = bindOwner(store, 'ou_owner');

    expect(binder.isOwner('ou_attacker')).toBe(false);
    binder.recordRejectedCardAction('ou_attacker');
    binder.recordRejectedCardAction('ou_attacker2');
    expect(binder.rejectedCount).toBe(2);
  });

  it('persists binding across restarts (new binder reads existing contact)', () => {
    const store = new StartupContactStore(storePath);
    bindOwner(store, 'ou_owner');

    // Simulate restart: a fresh binder over the same store must be bound, no new PIN
    const restarted = new OwnerBinder(store);
    expect(restarted.isBound()).toBe(true);
    expect(restarted.pendingPin).toBeUndefined();
    expect(restarted.boundOpenId()).toBe('ou_owner');
    expect(restarted.isOwner('ou_owner')).toBe(true);
    expect(restarted.isOwner('ou_attacker')).toBe(false);
  });
});

describe('formatPinGuidance', () => {
  it('includes the PIN and binding instructions', () => {
    const text = formatPinGuidance('4827');
    expect(text).toContain('4827');
    expect(text).toContain('首次绑定');
    expect(text).toContain('startup-contact.json');
  });
});
