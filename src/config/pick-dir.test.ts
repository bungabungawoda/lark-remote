import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  applyConfigDirPick,
  applyPickerKey,
  candidateAppLabel,
  listConfigDirCandidates,
  pinConfigDirArgv,
  renderCandidateTable,
  renderPicker,
  shortenHome,
  visibleWindow,
  pickConfigDir,
  type ConfigDirCandidate,
  type PickOutcome,
} from './pick-dir.js';
import type { BotInfoHttp } from './bot-info.js';
import { displayWidth } from '../common/text-width.js';
import { makeTempDir } from '../../tests/lib/temp-dir.js';
import { currentPlatform } from '../platform/select.js';

function writeConfig(dir: string, appId?: string, appSecret?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const body =
    appId && appSecret ? `feishu:\n  appId: ${appId}\n  appSecret: ${appSecret}\n` : 'feishu: {}\n';
  fs.writeFileSync(path.join(dir, 'config.yaml'), body, 'utf-8');
}

function candidate(overrides: Partial<ConfigDirCandidate> = {}): ConfigDirCandidate {
  return {
    dir: '/fixtures/cfg-a',
    displayPath: '~/.cfg-a',
    nameSource: 'none',
    running: false,
    configInvalid: false,
    missingCredentials: false,
    ...overrides,
  };
}

const okHttp = (appName = '联调机器人'): BotInfoHttp => ({
  post: async () => ({ data: { code: 0, tenant_access_token: 't-1' } }),
  get: async () => ({ data: { code: 0, bot: { app_name: appName } } }),
});

describe('listConfigDirCandidates', () => {
  it('lists default + .lark-remote* siblings that contain config.yaml, default first', async () => {
    const home = makeTempDir('pick-home-');
    writeConfig(path.join(home, '.lark-remote'), 'cli_default', 's1');
    writeConfig(path.join(home, '.lark-remote-wiki'), 'cli_wiki', 's2');
    writeConfig(path.join(home, 'not-lark-remote'), 'cli_x', 's3');
    fs.mkdirSync(path.join(home, '.lark-remote-temp')); // 无 config.yaml
    fs.writeFileSync(path.join(home, '.lark-remote-file'), 'x', 'utf-8');

    const items = await listConfigDirCandidates({ home, http: okHttp() });
    expect(items.map((item) => path.basename(item.dir))).toEqual([
      '.lark-remote',
      '.lark-remote-wiki',
    ]);
    expect(items[0]?.displayPath).toBe(shortenHome(path.join(home, '.lark-remote'), home));
    expect(items.every((item) => item.appName === '联调机器人')).toBe(true);
    expect(items.every((item) => item.nameSource === 'fresh')).toBe(true);
  });

  it('marks broken configs and missing credentials without fetching names', async () => {
    const home = makeTempDir('pick-home-');
    writeConfig(path.join(home, '.lark-remote'), 'cli_default', 's1');
    fs.mkdirSync(path.join(home, '.lark-remote-broken'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lark-remote-broken', 'config.yaml'), 'feishu: [\n');
    writeConfig(path.join(home, '.lark-remote-nocreds'));

    const fetched: number[] = [];
    const items = await listConfigDirCandidates({
      home,
      http: okHttp(),
      onFetchStart: (pending) => fetched.push(pending),
    });
    const byName = new Map(items.map((item) => [path.basename(item.dir), item]));

    expect(byName.get('.lark-remote-broken')).toMatchObject({
      configInvalid: true,
      missingCredentials: true,
      nameSource: 'none',
    });
    expect(byName.get('.lark-remote-nocreds')).toMatchObject({
      missingCredentials: true,
      appId: undefined,
      nameSource: 'none',
    });
    expect(fetched).toEqual([1]);
  });

  it('deduplicates symlinked config dirs by realpath', async () => {
    const home = makeTempDir('pick-home-');
    const wiki = path.join(home, '.lark-remote-wiki');
    writeConfig(wiki, 'cli_wiki', 's2');
    // win32 上 'dir' 需要管理员权限；junction 不需要。
    fs.symlinkSync(
      wiki,
      path.join(home, '.lark-remote-link'),
      currentPlatform === 'win32' ? 'junction' : 'dir',
    );

    const items = await listConfigDirCandidates({ home, http: okHttp() });
    expect(items).toHaveLength(1);
    expect(fs.realpathSync(items[0]!.dir)).toBe(fs.realpathSync(wiki));
  });

  it('reports a running instance from the read-only pid probe', async () => {
    const home = makeTempDir('pick-home-');
    const defaultDir = path.join(home, '.lark-remote');
    writeConfig(defaultDir, 'cli_default', 's1');
    fs.writeFileSync(path.join(defaultDir, 'lark-remote.pid'), '4242\nlark-remote', 'utf-8');

    const items = await listConfigDirCandidates({
      home,
      http: okHttp(),
      isPidAlive: (pid) => pid === 4242,
    });
    expect(items[0]?.running).toBe(true);
  });

  it('uses the default pid probe when none is injected', async () => {
    const home = makeTempDir('pick-home-');
    const dir = path.join(home, '.lark-remote');
    writeConfig(dir, 'cli_default', 's1');
    fs.writeFileSync(path.join(dir, 'lark-remote.pid'), `${process.pid}\nlark-remote`, 'utf-8');

    const items = await listConfigDirCandidates({ home, http: okHttp() });
    expect(items[0]?.running).toBe(true);
  });

  it('falls back to the appId tail when the name cannot be fetched', async () => {
    const home = makeTempDir('pick-home-');
    writeConfig(path.join(home, '.lark-remote'), 'cli_abcdef123456', 's1');
    const failing: BotInfoHttp = {
      post: async () => {
        throw new Error('offline');
      },
      get: async () => {
        throw new Error('offline');
      },
    };
    const items = await listConfigDirCandidates({ home, http: failing });
    expect(items[0]).toMatchObject({ nameSource: 'none', appName: undefined });
    expect(candidateAppLabel(items[0]!)).toBe('飞书：appId …123456');
  });

  it('keeps a stale cached name when the network fails', async () => {
    const home = makeTempDir('pick-home-');
    const dir = path.join(home, '.lark-remote');
    writeConfig(dir, 'cli_cached', 's1');
    fs.writeFileSync(
      path.join(dir, 'bot-info.json'),
      JSON.stringify({
        appId: 'cli_cached',
        appName: '旧名字',
        fetchedAt: new Date(0).toISOString(),
      }),
      'utf-8',
    );
    const failing: BotInfoHttp = {
      post: async () => {
        throw new Error('offline');
      },
      get: async () => {
        throw new Error('offline');
      },
    };
    const items = await listConfigDirCandidates({ home, http: failing });
    expect(items[0]).toMatchObject({ appName: '旧名字', nameSource: 'stale' });
  });
});

describe('shortenHome', () => {
  it('shortens paths under home and leaves others untouched', () => {
    const home = path.join(path.sep, 'home', 'u');
    expect(shortenHome(home, home)).toBe('~');
    expect(shortenHome(path.join(home, 'x'), home)).toBe(path.join('~', 'x'));
    expect(shortenHome(path.join(path.sep, 'opt', 'cfg'), home)).toBe(
      path.join(path.sep, 'opt', 'cfg'),
    );
  });
});

describe('applyPickerKey', () => {
  const count = 3;

  it('wraps around at both ends', () => {
    expect(applyPickerKey({ index: 0 }, { name: 'up' }, count)).toEqual({
      index: 2,
      action: 'continue',
    });
    expect(applyPickerKey({ index: 2 }, { name: 'down' }, count)).toEqual({
      index: 0,
      action: 'continue',
    });
  });

  it('maps Enter/Esc/q/Ctrl+C and digits', () => {
    expect(applyPickerKey({ index: 1 }, { name: 'return' }, count).action).toBe('confirm');
    expect(applyPickerKey({ index: 1 }, { name: 'escape' }, count).action).toBe('cancel');
    expect(applyPickerKey({ index: 1 }, { sequence: 'q' }, count).action).toBe('cancel');
    expect(applyPickerKey({ index: 1 }, { name: 'c', ctrl: true }, count).action).toBe('interrupt');
    expect(applyPickerKey({ index: 0 }, { sequence: '2' }, count)).toEqual({
      index: 1,
      action: 'confirm',
    });
  });

  it('ignores out-of-range digits and unknown keys', () => {
    expect(applyPickerKey({ index: 1 }, { sequence: '9' }, count)).toEqual({
      index: 1,
      action: 'continue',
    });
    expect(applyPickerKey({ index: 1 }, { sequence: 'x' }, count)).toEqual({
      index: 1,
      action: 'continue',
    });
  });
});

describe('visibleWindow', () => {
  it('returns everything when it fits and scrolls around the selection otherwise', () => {
    expect(visibleWindow(3, 1, 5)).toEqual({ start: 0, end: 3 });
    expect(visibleWindow(20, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(visibleWindow(20, 10, 5)).toEqual({ start: 8, end: 13 });
    expect(visibleWindow(20, 19, 5)).toEqual({ start: 15, end: 20 });
  });
});

describe('renderPicker', () => {
  const items = [
    candidate({
      dir: '/home/u/.lark-remote',
      displayPath: '~/.lark-remote',
      running: true,
      appName: '默认助手',
      nameSource: 'cache',
    }),
    candidate({
      dir: '/home/u/.lark-remote-reports',
      displayPath: '~/.lark-remote-reports',
      appName: '报表机器人',
      nameSource: 'fresh',
    }),
    candidate({
      dir: '/home/u/.lark-remote-broken',
      displayPath: '~/.lark-remote-broken',
      configInvalid: true,
    }),
  ];

  it('marks the selection and shows app names + running state', () => {
    const frame = renderPicker(items, 1, { columns: 100 });
    expect(frame).toContain('❯ 2');
    expect(frame).toContain('~/.lark-remote-reports');
    expect(frame).toContain('飞书：报表机器人');
    expect(frame).toContain('● 运行中');
    expect(frame).toContain('○ 未运行');
    expect(frame).toContain('⚠ 配置无效');
  });

  it('never exceeds the terminal width, even when narrow', () => {
    for (const columns of [40, 28, 20]) {
      const frame = renderPicker(items, 0, { columns });
      for (const line of frame.split('\n')) {
        expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('uses ANSI highlighting only when color is enabled', () => {
    expect(renderPicker(items, 0, { columns: 100, color: true })).toContain('\x1b[36m');
    expect(renderPicker(items, 0, { columns: 100, color: false })).not.toContain('\x1b[36m');
  });

  it('falls back to a sane width when the pty reports 0 columns', () => {
    const frame = renderPicker(items, 0, { columns: 0, rows: 0 });
    expect(frame).toContain('选择 lark-remote 配置目录');
    expect(frame).toContain('~/.lark-remote');
  });

  it('renders a flat table for non-TTY output', () => {
    const table = renderCandidateTable(items, { columns: 80 });
    expect(table.split('\n')).toHaveLength(3);
    expect(table).not.toContain('❯');
  });
});

describe('pickConfigDir', () => {
  function fakeOutput(): { stream: NodeJS.WriteStream; chunks: string[] } {
    const chunks: string[] = [];
    const stream = {
      isTTY: true,
      columns: 90,
      rows: 24,
      write: (text: string) => {
        chunks.push(text);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { stream, chunks };
  }

  it('moves with arrows and confirms with Enter', async () => {
    const input = new PassThrough();
    const { stream, chunks } = fakeOutput();
    const items = [candidate(), candidate({ dir: '/fixtures/cfg-b', displayPath: '~/.cfg-b' })];

    const promise = pickConfigDir(items, {
      input: input as unknown as NodeJS.ReadStream,
      output: stream,
    });
    input.write('\x1b[B');
    input.write('\r');

    const outcome = await promise;
    expect(outcome).toMatchObject({ kind: 'selected', item: { dir: '/fixtures/cfg-b' } });
    expect(chunks.join('')).toContain('✔ 使用配置目录：~/.cfg-b');
  });

  it('interrupts on Ctrl+C', async () => {
    const input = new PassThrough();
    const { stream } = fakeOutput();
    const promise = pickConfigDir([candidate()], {
      input: input as unknown as NodeJS.ReadStream,
      output: stream,
    });
    input.write('\x03');
    await expect(promise).resolves.toEqual({ kind: 'interrupted' });
  });

  it('cancels on Esc', async () => {
    const input = new PassThrough();
    const { stream } = fakeOutput();
    const promise = pickConfigDir([candidate()], {
      input: input as unknown as NodeJS.ReadStream,
      output: stream,
    });
    input.write('\x1b');
    await expect(promise).resolves.toEqual({ kind: 'cancelled' });
  });
});

describe('pinConfigDirArgv', () => {
  it('replaces every -c/--config-dir form with one explicit pair', () => {
    expect(pinConfigDirArgv(['-c'], '/x')).toEqual(['--config-dir', '/x']);
    expect(pinConfigDirArgv(['-c', '--dev'], '/x')).toEqual(['--config-dir', '/x', '--dev']);
    expect(pinConfigDirArgv(['--config-dir=/old', '--dev'], '/x')).toEqual([
      '--config-dir',
      '/x',
      '--dev',
    ]);
    expect(pinConfigDirArgv(['-c', '/old', '-c'], '/x')).toEqual(['--config-dir', '/x']);
    expect(pinConfigDirArgv([], '/x')).toEqual(['--config-dir', '/x']);
  });
});

describe('applyConfigDirPick', () => {
  function capture(): {
    out: { isTTY: boolean; columns: number; write: (t: string) => boolean };
    text: () => string;
  } {
    const chunks: string[] = [];
    return {
      out: {
        isTTY: false,
        columns: 80,
        write: (text: string) => {
          chunks.push(text);
          return true;
        },
      },
      text: () => chunks.join(''),
    };
  }

  it('does nothing without the pick request or with an explicit path', async () => {
    let called = 0;
    const list = async () => {
      called++;
      return [];
    };
    await applyConfigDirPick({}, { list });
    await applyConfigDirPick({ configDirPick: true, configDir: '/explicit' }, { list });
    expect(called).toBe(0);
  });

  it('prints the candidate table and exits 2 outside a TTY', async () => {
    const { out, text } = capture();
    const codes: number[] = [];
    let remoteNames: boolean | undefined;
    await applyConfigDirPick(
      { configDirPick: true },
      {
        stdin: { isTTY: false },
        stdout: out,
        exit: (code) => codes.push(code),
        list: async (opts) => {
          remoteNames = opts.remoteNames;
          return [candidate({ appId: 'cli_x', displayPath: '~/.cfg-a' })];
        },
      },
    );
    expect(codes).toEqual([2]);
    expect(remoteNames).toBe(false);
    expect(text()).toContain('需要显式路径');
    expect(text()).toContain('~/.cfg-a');
    expect(text()).toContain('Usage: lark-remote --config-dir <path>');
  });

  it('exits 2 when no candidate exists', async () => {
    const { out, text } = capture();
    const codes: number[] = [];
    await applyConfigDirPick(
      { configDirPick: true },
      {
        stdin: { isTTY: false },
        stdout: out,
        exit: (code) => codes.push(code),
        list: async () => [],
      },
    );
    expect(codes).toEqual([2]);
    expect(text()).toContain('未发现可用的配置目录');
  });

  it('writes the selection back and pins argv', async () => {
    const cliArgs: { configDir?: string; configDirPick?: boolean } = { configDirPick: true };
    const argv = ['node', 'cli.js', '-c', '--dev'];
    const selected = candidate({ dir: '/picked/dir', displayPath: '~/picked' });
    const outcome: PickOutcome = { kind: 'selected', item: selected };
    const chunks: string[] = [];
    let remoteNames: boolean | undefined;

    await applyConfigDirPick(cliArgs, {
      stdin: { isTTY: true },
      stdout: {
        isTTY: true,
        columns: 90,
        write: (text: string) => {
          chunks.push(text);
          return true;
        },
      },
      argv,
      list: async (opts) => {
        remoteNames = opts.remoteNames;
        opts.onFetchStart(2);
        return [selected];
      },
      pick: async () => outcome,
    });

    expect(remoteNames).toBe(true);
    expect(chunks.join('')).toContain('正在读取飞书应用信息（2 个目录）');
    expect(chunks.join('')).toContain('\x1b[1A\x1b[0J');
    expect(cliArgs.configDir).toBe('/picked/dir');
    expect(argv).toEqual(['node', 'cli.js', '--config-dir', '/picked/dir', '--dev']);
  });

  it('maps cancel to exit 1 and Ctrl+C to exit 130', async () => {
    const codes: number[] = [];
    const deps = {
      stdin: { isTTY: true },
      stdout: { isTTY: true, columns: 90, write: () => true },
      argv: ['node', 'cli.js', '-c'],
      list: async () => [candidate()],
      exit: (code: number) => codes.push(code),
      pick: vi.fn<() => Promise<PickOutcome>>(),
    };
    deps.pick.mockResolvedValueOnce({ kind: 'cancelled' });
    await applyConfigDirPick({ configDirPick: true }, deps);
    deps.pick.mockResolvedValueOnce({ kind: 'interrupted' });
    await applyConfigDirPick({ configDirPick: true }, deps);
    expect(codes).toEqual([1, 130]);
  });
});
