import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OwnerBinder, formatBindGuidance } from './binder.js';
import { StartupContactStore } from './startup-contact.js';

vi.mock('./logger/index.js', async () =>
  (await import('../tests/lib/logger-mock.js')).loggerModuleMock(),
);

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
  it('starts unbound with no pending pin', () => {
    const store = new StartupContactStore(storePath);
    const binder = new OwnerBinder(store);

    expect(binder.isBound()).toBe(false);
    expect(binder.boundOpenId()).toBeUndefined();
  });

  it('binds on the first message with any content', () => {
    const store = new StartupContactStore(storePath);
    const binder = new OwnerBinder(store);

    const decision = binder.classify('ou_owner1', '你好', 'chat-1');

    expect(decision.kind).toBe('bind_success');
    expect(binder.isBound()).toBe(true);
    expect(binder.boundOpenId()).toBe('ou_owner1');
    expect(store.getContact()).toEqual({ chatId: 'chat-1', userId: 'ou_owner1' });
  });

  it('binds on slash commands and whitespace-padded content alike', () => {
    const store = new StartupContactStore(storePath);
    const binder = new OwnerBinder(store);

    expect(binder.classify('ou_owner1', '/help', 'chat-1').kind).toBe('bind_success');

    const store2 = new StartupContactStore(path.join(tmpDir, 'other.json'));
    const binder2 = new OwnerBinder(store2);
    expect(binder2.classify('ou_owner2', '  hello  ', 'chat-2').kind).toBe('bind_success');
    expect(store2.getContact()?.userId).toBe('ou_owner2');
  });
});

describe('OwnerBinder - bound state', () => {
  function bindOwner(store: StartupContactStore, openId = 'ou_owner'): OwnerBinder {
    const binder = new OwnerBinder(store);
    binder.classify(openId, 'hello', 'chat-owner');
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

    // Simulate restart: a fresh binder over the same store must be bound
    const restarted = new OwnerBinder(store);
    expect(restarted.isBound()).toBe(true);
    expect(restarted.boundOpenId()).toBe('ou_owner');
    expect(restarted.isOwner('ou_owner')).toBe(true);
    expect(restarted.isOwner('ou_attacker')).toBe(false);
  });
});

describe('formatBindGuidance', () => {
  it('instructs the user to send any message to bind', () => {
    const text = formatBindGuidance();
    expect(text).toContain('任意消息');
    expect(text).toContain('首次绑定');
    expect(text).toContain('startup-contact.json');
  });
});
