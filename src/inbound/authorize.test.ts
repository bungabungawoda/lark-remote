/**
 * InboundAuthorizer tests.
 *
 * 首条入站消息是纯媒体时也必须完成 owner 绑定：媒体入口与文本入口共用同一个
 * 授权/onboarding 入口，且 onboarding 只跑一次（同一条 post 会先触发媒体、再
 * 触发文本两个 handler）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InboundAuthorizer } from './authorize.js';
import { OwnerBinder } from '../binder.js';
import { StartupContactStore } from '../startup-contact.js';

vi.mock('../logger/index.js', async () =>
  (await import('../../tests/lib/logger-mock.js')).loggerModuleMock(),
);

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-inbound-authorize-'));
  storePath = path.join(tmpDir, 'startup-contact.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('InboundAuthorizer', () => {
  it('test_anchor_first_pure_media_binds_owner', async () => {
    const binder = new OwnerBinder(new StartupContactStore(storePath));
    const onBind = vi.fn();
    const authorizer = new InboundAuthorizer({ binder, onBind });

    // 首条消息只有媒体（connector 不产生文本事件）：媒体入口也必须绑定。
    expect(authorizer.authorize('ou_owner1', 'chat-1')).toBe('bind_success');
    await authorizer.whenBound();

    expect(binder.isOwner('ou_owner1')).toBe(true);
    // 绑定文件已落盘（后续文本消息据此走 owner 分支）。
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as {
      userId?: string;
      chatId?: string;
    };
    expect(persisted).toMatchObject({ userId: 'ou_owner1', chatId: 'chat-1' });
    expect(onBind).toHaveBeenCalledTimes(1);
    expect(onBind).toHaveBeenCalledWith('ou_owner1', 'chat-1');
  });

  it('runs onboarding once when media and text handlers both see bind_success', async () => {
    const binder = new OwnerBinder(new StartupContactStore(storePath));
    const onBind = vi.fn(() => new Promise<void>(() => {})); // never settles
    const authorizer = new InboundAuthorizer({ binder, onBind });

    // connector 对一条「图 + 文」消息先后调用媒体/文本 handler；第二个调用时
    // startup-contact 已写好 → owner，但即便两个都看到 bind_success 也只跑一次。
    expect(authorizer.authorize('ou_owner1', 'chat-1')).toBe('bind_success');
    expect(authorizer.authorize('ou_owner1', 'chat-1')).toBe('owner');
    expect(onBind).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-owner once the owner is bound', () => {
    const binder = new OwnerBinder(new StartupContactStore(storePath));
    binder.authorize('ou_owner1', 'chat-1');
    const onBind = vi.fn();
    const authorizer = new InboundAuthorizer({ binder, onBind });

    expect(authorizer.authorize('ou_intruder', 'chat-2')).toBe('rejected');
    expect(onBind).not.toHaveBeenCalled();
  });

  it('does not fail inbound handling when onboarding throws', async () => {
    const binder = new OwnerBinder(new StartupContactStore(storePath));
    const authorizer = new InboundAuthorizer({
      binder,
      onBind: () => {
        throw new Error('send failed');
      },
    });

    expect(authorizer.authorize('ou_owner1', 'chat-1')).toBe('bind_success');
    await expect(authorizer.whenBound()).resolves.toBeUndefined();
  });
});
