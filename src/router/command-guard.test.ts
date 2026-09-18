/**
 * B1（P0 安全）：命令识别前置条件 —— 用户消息里的结构占位符永远不能触发命令分发。
 *
 * 事故现场（2026-09-15）：
 *   `![image](img_v3_…) \n test`   ← 富文本把图片渲染在前
 *   [router] handle … startsWithBang=true          ← 首字符恰好是 "!"
 *   [lark-remote] executeBash start … command="[image](img_v3_…"
 *
 * 判据：`allowCommandPrefix`（调用方声明纯文本）+ 剥离后非空且无占位符 + 首字符 / 或 !。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from './index.js';
import { SessionStore } from '../session/index.js';
import { AppConfigSchema } from '../config/index.js';
import { createMockBridge, createStubSessionReaderRegistry } from '../../tests/lib/bridge-stubs.js';

interface Fixture {
  router: CommandRouter;
  bridge: ReturnType<typeof createMockBridge>;
  tmpDir: string;
}

let fixture: Fixture;

function makeFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-command-guard-'));
  const config = AppConfigSchema.parse({ feishu: { appId: 'app-id', appSecret: 'app-secret' } });
  const sessionStore = new SessionStore(
    path.join(tmpDir, 'last-session.json'),
    config.defaultAgent,
  );
  const bridge = createMockBridge({
    executeBash: vi.fn().mockResolvedValue(undefined),
  } as never);
  const router = new CommandRouter({
    sessionStore,
    bridge,
    config,
    configPath: path.join(tmpDir, 'config.yaml'),
    workspacePath: path.join(tmpDir, 'workspace.json'),
    ordersPath: path.join(tmpDir, 'orders.json'),
    sessionReaderRegistry: createStubSessionReaderRegistry(),
    exitHandler: () => {},
  });
  return { router, bridge, tmpDir };
}

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
});

const ctx = { userId: 'u1', chatId: 'c1', messageId: 'm1' };

describe('router.handle 命令守卫（B1 P0）', () => {
  it('![image](img_v3_x) 不触发 executeBash，且 prompt 里没有 img_v3_x', async () => {
    await fixture.router.handle('![image](img_v3_x)', ctx, { allowCommandPrefix: true });

    expect(fixture.bridge.executeBash).not.toHaveBeenCalled();
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith('', ctx, expect.anything());
    const prompt = (fixture.bridge.forwardToClaude as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as string;
    expect(prompt).not.toContain('img_v3_x');
  });

  it('![image](img_v3_x)\\ntest → 走 agent，prompt 为 test', async () => {
    await fixture.router.handle('![image](img_v3_x)\ntest', ctx, { allowCommandPrefix: true });
    expect(fixture.bridge.executeBash).not.toHaveBeenCalled();
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith('test', ctx, expect.anything());
  });

  it('<file key="k"/>\\n你好 → 走 agent，prompt 为 你好', async () => {
    await fixture.router.handle('<file key="k"/>\n你好', ctx, { allowCommandPrefix: true });
    expect(fixture.bridge.executeBash).not.toHaveBeenCalled();
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith('你好', ctx, expect.anything());
  });

  it('[unsupported message] 不执行命令（B4 的不支持回执路径由装配器负责）', async () => {
    await fixture.router.handle('[unsupported message]', ctx, { allowCommandPrefix: true });
    expect(fixture.bridge.executeBash).not.toHaveBeenCalled();
    expect(fixture.bridge.sendResult).not.toHaveBeenCalled();
  });

  it('!ls（allowCommandPrefix: true）仍走 executeBash', async () => {
    await fixture.router.handle('!ls', ctx, { allowCommandPrefix: true });
    expect(fixture.bridge.executeBash).toHaveBeenCalledWith('ls', ctx);
  });

  it('/help（allowCommandPrefix: true）仍走命令分发', async () => {
    await fixture.router.handle('/help', ctx, { allowCommandPrefix: true });
    expect(fixture.bridge.forwardToClaude).not.toHaveBeenCalled();
    expect(fixture.bridge.sendResult).toHaveBeenCalled();
  });

  it('!ls（allowCommandPrefix: false）不进 shell，按文本交给 agent', async () => {
    await fixture.router.handle('!ls', ctx, { allowCommandPrefix: false });
    expect(fixture.bridge.executeBash).not.toHaveBeenCalled();
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith('!ls', ctx, expect.anything());
  });

  it('/help（allowCommandPrefix: false）不进命令分发', async () => {
    await fixture.router.handle('/help', ctx, { allowCommandPrefix: false });
    expect(fixture.bridge.sendResult).not.toHaveBeenCalled();
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith('/help', ctx, expect.anything());
  });

  it('占位符 + 命令前缀混合：仍不进 shell（含占位符一律不当命令）', async () => {
    await fixture.router.handle('![image](img_v3_x)\n!ls', ctx, { allowCommandPrefix: true });
    expect(fixture.bridge.executeBash).not.toHaveBeenCalled();
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith('!ls', ctx, expect.anything());
  });

  it('装配器生成的 <attachments> 协议块原样转发（附件路径不能丢）', async () => {
    const prompt =
      '看这张图\n\n<attachments>\n  <file path="/tmp/a/x.png" kind="image"/>\n</attachments>';
    await fixture.router.handle(prompt, ctx, { allowCommandPrefix: false });
    expect(fixture.bridge.forwardToClaude).toHaveBeenCalledWith(prompt, ctx, expect.anything());
  });

  it('默认（未声明 allowCommandPrefix）保持既有内部调用语义：命令仍生效', async () => {
    await fixture.router.handle('/help', ctx);
    expect(fixture.bridge.sendResult).toHaveBeenCalled();
  });
});
