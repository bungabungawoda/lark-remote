import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloneSession, generateCloneSuffix, isValidCloneName, type CloneContext } from './clone.js';

vi.mock('./logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const SOURCE_CONFIG = [
  'feishu:',
  '  appId: cli_old_app',
  '  appSecret: old_secret',
  'claude:',
  '  model: test-model',
  'defaultAgent: claude',
  '',
].join('\n');

const CTX: CloneContext = { userId: 'ou_user', chatId: 'oc_chat', messageId: 'om_1' };

interface RegisterResult {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string };
}

interface FakeRegisterOpts {
  signal?: AbortSignal;
  createOnly?: boolean;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
}

/** 可控的 registerApp 替身：每次调用一个独立 deferred（可分别 resolve/reject）。 */
function makeDeferredRegisterApp() {
  const calls: Array<{
    signal?: AbortSignal;
    opts: FakeRegisterOpts;
    resolve: (r: RegisterResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  const fn = (opts: FakeRegisterOpts) => {
    return new Promise<RegisterResult>((res, rej) => {
      calls.push({ signal: opts.signal, opts, resolve: res, reject: rej });
    });
  };
  return { calls, fn };
}

function stubConnector() {
  const texts: string[] = [];
  const imagePaths: string[] = [];
  return {
    texts,
    imagePaths,
    async sendWithRetry(
      _chatId: string,
      input: { text?: string; markdown?: string; card?: object },
    ): Promise<string> {
      texts.push(input.text ?? input.markdown ?? JSON.stringify(input.card));
      return 'message-1';
    },
    async sendImage(chatId: string, filePath: string): Promise<string> {
      void chatId;
      imagePaths.push(filePath);
      return 'message-2';
    },
  };
}

let tmpBase: string;
let configDir: string;
let configPath: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-clone-'));
  configDir = path.join(tmpBase, 'cfg');
  fs.mkdirSync(configDir, { recursive: true });
  configPath = path.join(configDir, 'config.yaml');
  fs.writeFileSync(configPath, SOURCE_CONFIG);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

interface Fixture {
  connector: ReturnType<typeof stubConnector>;
  reg: ReturnType<typeof makeDeferredRegisterApp>;
  spawned: string[];
  session: CloneSession;
}

function makeFixture(opts?: { suffixes?: string[]; spawnFails?: boolean }): Fixture {
  const connector = stubConnector();
  const reg = makeDeferredRegisterApp();
  const spawned: string[] = [];
  let suffixIdx = 0;
  const session = new CloneSession({
    connector,
    configPath,
    configDir,
    registerAppFn: reg.fn,
    generateSuffix: () => opts?.suffixes?.[suffixIdx++] ?? '99zz',
    spawnNewInstance: (dir) => {
      spawned.push(dir);
      return opts?.spawnFails ? undefined : 4321;
    },
  });
  return { connector, reg, spawned, session };
}

const flush = () => new Promise((r) => setImmediate(r));

/** 等 finalize 链跑完（状态回到 idle）。 */
async function waitIdle(session: CloneSession): Promise<void> {
  await vi.waitFor(() => expect(session.currentState).toBe('idle'), {
    timeout: 2000,
    interval: 10,
  });
}

describe('generateCloneSuffix', () => {
  it('produces 2 digits + 2 lowercase alphanumerics', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCloneSuffix()).toMatch(/^\d{2}[a-z0-9]{2}$/);
    }
  });
});

describe('isValidCloneName', () => {
  it('accepts ordinary names including CJK', () => {
    expect(isValidCloneName('myclone')).toBe(true);
    expect(isValidCloneName('分身A')).toBe(true);
    expect(isValidCloneName('a.b')).toBe(true);
  });

  it('rejects path separators, leading dots, trailing dot/space, reserved device names', () => {
    for (const bad of ['a/b', 'a\\b', '.x', 'a.', 'a ', '', 'con', 'NUL', 'com1', 'LPT3']) {
      expect(isValidCloneName(bad)).toBe(false);
    }
  });
});

describe('CloneSession.start', () => {
  it('random suffix: derives target dir, enters awaiting_scan, starts registration', async () => {
    const { connector, reg, session } = makeFixture({ suffixes: ['42ab'] });

    await session.start(undefined, CTX);

    expect(session.currentState).toBe('awaiting_scan');
    expect(session.isActive()).toBe(true);
    expect(session.pendingTargetDir).toBe(`${configDir}-42ab`);
    expect(reg.calls).toHaveLength(1);
    expect(reg.calls[0].opts.createOnly).toBe(true);
    expect(connector.texts[0]).toContain('42ab');
    // 尚未写盘
    expect(fs.existsSync(`${configDir}-42ab`)).toBe(false);
  });

  it('random suffix collision: regenerates until the dir does not exist', async () => {
    const { session } = makeFixture({ suffixes: ['aa00', 'bb11'] });
    fs.mkdirSync(`${configDir}-aa00`);

    await session.start(undefined, CTX);

    expect(session.pendingTargetDir).toBe(`${configDir}-bb11`);
  });

  it('explicit name: appends the given name to the config dir', async () => {
    const { session } = makeFixture();

    await session.start('myclone', CTX);

    expect(session.pendingTargetDir).toBe(`${configDir}-myclone`);
    expect(session.currentState).toBe('awaiting_scan');
  });

  it('explicit name with existing dir: rejects and stays idle', async () => {
    const { connector, reg, session } = makeFixture();
    fs.mkdirSync(`${configDir}-dup`);

    await session.start('dup', CTX);

    expect(session.currentState).toBe('idle');
    expect(reg.calls).toHaveLength(0);
    expect(connector.texts[0]).toContain('目录已存在');
  });

  it('invalid name (path separator): rejects and stays idle', async () => {
    const { connector, reg, session } = makeFixture();

    await session.start('a/b', CTX);

    expect(session.currentState).toBe('idle');
    expect(reg.calls).toHaveLength(0);
    expect(connector.texts[0]).toContain('无效的名字');
  });

  it('reserved device name or trailing dot: rejects and stays idle', async () => {
    const { session } = makeFixture();
    for (const bad of ['con', 'a.']) {
      await session.start(bad, CTX);
      expect(session.currentState).toBe('idle');
    }
  });

  it('already active: refuses to start a second flow', async () => {
    const { connector, reg, session } = makeFixture();

    await session.start(undefined, CTX);
    await session.start('another', CTX);

    expect(session.pendingTargetDir).toBe(`${configDir}-99zz`);
    expect(reg.calls).toHaveLength(1);
    expect(connector.texts.at(-1)).toContain('已在创建分身流程中');
  });
});

describe('CloneSession QR delivery', () => {
  it('sends the QR as an image message plus guidance text, then cleans the temp file', async () => {
    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);

    reg.calls[0].opts.onQRCodeReady({ url: 'https://example.com/create-app', expireIn: 600 });
    await flush();
    await flush();

    expect(connector.imagePaths).toHaveLength(1);
    const qrPath = connector.imagePaths[0];
    expect(qrPath.endsWith('.gif')).toBe(true);
    expect(fs.existsSync(qrPath)).toBe(false); // 发送后即清理
    const guidance = connector.texts.at(-1)!;
    expect(guidance).toContain('https://example.com/create-app');
    expect(guidance).toContain('10 分钟');
    expect(guidance).toContain('/Q');
    expect(session.currentState).toBe('awaiting_scan');
  });

  it('image send failure falls back to the URL text and keeps the flow alive', async () => {
    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);

    connector.sendImage = async () => {
      throw new Error('upload failed');
    };
    reg.calls[0].opts.onQRCodeReady({ url: 'https://example.com/create-app', expireIn: 600 });
    await flush();
    await flush();

    expect(connector.texts.at(-1)).toContain('https://example.com/create-app');
    expect(session.currentState).toBe('awaiting_scan');
  });
});

describe('CloneSession.handleMessage', () => {
  async function startedFixture(): Promise<Fixture> {
    const fixture = makeFixture();
    await fixture.session.start(undefined, CTX);
    return fixture;
  }

  it('unknown input gets guidance with continue (resend) and exit (/Q) hints', async () => {
    const { connector, session } = await startedFixture();

    await session.handleMessage('你好', CTX);

    expect(session.currentState).toBe('awaiting_scan');
    expect(connector.texts.at(-1)).toContain('等待你扫码');
    expect(connector.texts.at(-1)).toContain('重发');
    expect(connector.texts.at(-1)).toContain('/Q');
  });

  it('/Q cancels: aborts the registration, stays silent on its rejection, exits flow', async () => {
    const { connector, reg, session } = await startedFixture();

    await session.handleMessage('/Q', CTX);

    expect(session.currentState).toBe('idle');
    expect(reg.calls[0].signal?.aborted).toBe(true);
    expect(connector.texts.at(-1)).toContain('已取消创建分身');

    // abort 导致的 registerApp rejection 被静默吞掉（不再追加失败提示）
    reg.calls[0].reject(new Error('aborted'));
    await flush();
    expect(connector.texts).toHaveLength(2); // intro + cancel
  });

  it('/Q is accepted case-insensitively', async () => {
    const { session } = await startedFixture();

    await session.handleMessage('/q', CTX);

    expect(session.currentState).toBe('idle');
  });

  it('late resolve of a cancelled generation is ignored: nothing is written, no notice', async () => {
    const { connector, reg, session } = await startedFixture();

    await session.handleMessage('/Q', CTX);
    const textCount = connector.texts.length;

    reg.calls[0].resolve({
      client_id: 'cli_late',
      client_secret: 'late_secret',
      user_info: { open_id: 'ou_late' },
    });
    await flush();
    await flush();

    expect(fs.existsSync(`${configDir}-99zz`)).toBe(false);
    expect(connector.texts.length).toBe(textCount);
  });

  it('重发 aborts the old registration and starts a new one', async () => {
    const { connector, reg, session } = await startedFixture();

    await session.handleMessage('重发', CTX);

    expect(reg.calls).toHaveLength(2);
    expect(reg.calls[0].signal?.aborted).toBe(true);
    expect(reg.calls[1].signal?.aborted).toBe(false);
    expect(session.currentState).toBe('awaiting_scan');
    expect(connector.texts.at(-1)).toContain('重新生成二维码');

    // 旧注册的 abort rejection 不产生失败提示
    reg.calls[0].reject(new Error('aborted'));
    await flush();
    expect(connector.texts.at(-1)).toContain('重新生成二维码');
  });

  it('late resolve of a resent-away generation is ignored; the new generation finalizes', async () => {
    const { reg, session } = makeFixture();
    await session.start(undefined, CTX);
    await session.handleMessage('重发', CTX);
    const targetDir = `${configDir}-99zz`;

    // 旧代际迟到 resolve：被忽略，同目录未写入
    reg.calls[0].resolve({
      client_id: 'cli_old_gen',
      client_secret: 'old_secret',
      user_info: { open_id: 'ou_old_gen' },
    });
    await flush();
    await flush();
    expect(fs.existsSync(targetDir)).toBe(false);
    expect(session.currentState).toBe('awaiting_scan');

    // 新代际 resolve：正常 finalize 到同一个已预留目录
    reg.calls[1].resolve({
      client_id: 'cli_new_gen',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_new_gen' },
    });
    await flush();
    await waitIdle(session);

    const written = fs.readFileSync(path.join(targetDir, 'config.yaml'), 'utf-8');
    expect(written).toContain('cli_new_gen');
  });

  it('genuine registration failure keeps the flow alive with resend/exit guidance', async () => {
    const { connector, reg, session } = await startedFixture();

    reg.calls[0].reject(new Error('qr expired'));
    await flush();

    expect(session.currentState).toBe('awaiting_scan');
    expect(connector.texts.at(-1)).toContain('创建失败或二维码已过期');
    expect(connector.texts.at(-1)).toContain('/Q');
  });
});

describe('CloneSession.finalize', () => {
  it('copies config, pre-binds the new openId, spawns and reports', async () => {
    const { connector, reg, spawned, session } = makeFixture();
    await session.start(undefined, CTX);

    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_new_app_scope' },
    });
    await flush();
    await waitIdle(session);

    const targetDir = `${configDir}-99zz`;
    // 配置：除 feishu appId/secret 外全部保留
    const written = fs.readFileSync(path.join(targetDir, 'config.yaml'), 'utf-8');
    expect(written).toContain('cli_new_app');
    expect(written).toContain('new_secret');
    expect(written).not.toContain('cli_old_app');
    expect(written).not.toContain('old_secret');
    expect(written).toContain('test-model');
    expect(written).toContain('defaultAgent: claude');
    // 自动绑定
    const contact = JSON.parse(
      fs.readFileSync(path.join(targetDir, 'startup-contact.json'), 'utf-8'),
    ) as { userId?: string };
    expect(contact.userId).toBe('ou_new_app_scope');
    // 自动拉起新实例
    expect(spawned).toEqual([targetDir]);
    // 原应用回执
    const notice = connector.texts.at(-1)!;
    expect(notice).toContain('分身创建完成');
    expect(notice).toContain('cli_new_app');
    expect(notice).toContain(targetDir);
    expect(notice).toContain('pid=4321');
    expect(notice).toContain('启动通知');
  });

  it('spawn failure: notice carries the manual start command', async () => {
    const { connector, reg, spawned, session } = makeFixture({ spawnFails: true });
    await session.start(undefined, CTX);

    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_new_app_scope' },
    });
    await flush();
    await waitIdle(session);

    expect(spawned).toEqual([`${configDir}-99zz`]);
    expect(connector.texts.at(-1)).toContain('自动启动失败');
    expect(connector.texts.at(-1)).toContain(`lark-remote --config-dir ${configDir}-99zz`);
  });

  it('missing open_id: skips pre-bind, notice says first message will bind', async () => {
    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);

    reg.calls[0].resolve({ client_id: 'cli_new_app', client_secret: 'new_secret' });
    await flush();
    await waitIdle(session);

    const targetDir = `${configDir}-99zz`;
    expect(fs.existsSync(path.join(targetDir, 'startup-contact.json'))).toBe(false);
    expect(connector.texts.at(-1)).toContain('自动完成绑定');
  });

  it('config read failure: reports the error and exits the flow', async () => {
    fs.unlinkSync(configPath);
    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);

    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_x' },
    });
    await flush();
    await waitIdle(session);

    expect(session.currentState).toBe('idle');
    expect(connector.texts.at(-1)).toContain('配置写入失败');
  });

  it('write failure cleans up a half-written target dir containing only our artifacts', async () => {
    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);
    const targetDir = `${configDir}-99zz`;
    // config.yaml.tmp 是目录 → atomicWrite 写 tmp 时 EISDIR 失败
    fs.mkdirSync(path.join(targetDir, 'config.yaml.tmp'), { recursive: true });

    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_x' },
    });
    await flush();
    await waitIdle(session);

    expect(fs.existsSync(targetDir)).toBe(false);
    expect(connector.texts.at(-1)).toContain('配置写入失败');
  });

  it('cleanup keeps the dir when foreign files are present', async () => {
    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);
    const targetDir = `${configDir}-99zz`;
    fs.mkdirSync(path.join(targetDir, 'config.yaml.tmp'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'keep.txt'), 'user data');

    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_x' },
    });
    await flush();
    await waitIdle(session);

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'keep.txt'))).toBe(true);
    expect(connector.texts.at(-1)).toContain('配置写入失败');
  });
});

describe('CloneSession state sync', () => {
  it('copies workspace/orders verbatim and re-keys last-session to the new openId', async () => {
    // 旧实例的绑定与状态文件
    fs.writeFileSync(
      path.join(configDir, 'startup-contact.json'),
      JSON.stringify({ chatId: 'oc_chat', userId: 'ou_user' }),
    );
    fs.writeFileSync(
      path.join(configDir, 'workspace.json'),
      JSON.stringify([{ name: 'proj', path: '/home/user/project' }]),
    );
    fs.writeFileSync(
      path.join(configDir, 'orders.json'),
      JSON.stringify([{ id: 'o1', text: '跑全量测试' }]),
    );
    const entry = {
      cwd: '/home/user/project',
      sessions: { claude: 'aaaaaaaa-1111-2222-3333-444444444444' },
      previousSessions: {},
      sessionCwds: {},
      arrivalSessions: {},
    };
    fs.writeFileSync(
      path.join(configDir, 'last-session.json'),
      JSON.stringify({
        ou_user: entry,
        // 其余用户条目不迁移：分身只服务新 owner
        ou_other: {
          cwd: '/x',
          sessions: {},
          previousSessions: {},
          sessionCwds: {},
          arrivalSessions: {},
        },
      }),
    );

    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);
    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_new_app_scope' },
    });
    await flush();
    await waitIdle(session);

    const targetDir = `${configDir}-99zz`;
    // 全局文件原样复制
    expect(fs.readFileSync(path.join(targetDir, 'workspace.json'), 'utf-8')).toBe(
      fs.readFileSync(path.join(configDir, 'workspace.json'), 'utf-8'),
    );
    expect(fs.readFileSync(path.join(targetDir, 'orders.json'), 'utf-8')).toBe(
      fs.readFileSync(path.join(configDir, 'orders.json'), 'utf-8'),
    );
    // 会话条目重绑到新 openId，内容原样保留；旧 owner / 其他用户条目不迁移
    const rekeyed = JSON.parse(
      fs.readFileSync(path.join(targetDir, 'last-session.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(Object.keys(rekeyed)).toEqual(['ou_new_app_scope']);
    expect(rekeyed['ou_new_app_scope']).toEqual(entry);
    expect(connector.texts.at(-1)).toContain('会话与工作目录状态已同步');
  });

  it('without prior session entry: global state still copies, notice downgrades', async () => {
    fs.writeFileSync(path.join(configDir, 'workspace.json'), JSON.stringify([]));

    const { connector, reg, session } = makeFixture();
    await session.start(undefined, CTX);
    reg.calls[0].resolve({
      client_id: 'cli_new_app',
      client_secret: 'new_secret',
      user_info: { open_id: 'ou_new_app_scope' },
    });
    await flush();
    await waitIdle(session);

    const targetDir = `${configDir}-99zz`;
    expect(fs.existsSync(path.join(targetDir, 'workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'last-session.json'))).toBe(false);
    expect(connector.texts.at(-1)).toContain('workspace / 常用指令状态已同步');
  });
});
