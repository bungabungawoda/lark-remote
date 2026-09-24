import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createMockProc, emitExit } from '../../tests/lib/mock-process.js';

// 不真起进程：identity 的全部断言都基于 spawn/execFileSync 的入参与 stdout 解析
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));

import { execFileSync, spawn } from 'node:child_process';
import {
  queryProcessIdentity,
  tokenizeCommandLine,
  verifyPidIdentityVerdict,
  verifyPidIdentityVerdictSync,
} from './identity.js';

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

/** stdout 吐出给定文本后以 exitCode 退出（数据先于 exit 事件，贴合真实时序）。 */
function procWithStdout(stdout: string, exitCode = 0): ChildProcess {
  const stream = new PassThrough();
  const proc = createMockProc({ stdout: stream, stderr: new PassThrough() });
  stream.end(stdout);
  setTimeout(() => emitExit(proc, exitCode, null), 0);
  return proc;
}

/** 永不退出的子进程（超时路径）。 */
function procNeverExits(): ChildProcess {
  const kill = vi.fn(() => true);
  return createMockProc({ stdout: new PassThrough(), pid: 4242, kill });
}

/** spawn 失败（如 powershell 不存在）。 */
function procError(err: Error): ChildProcess {
  const proc = createMockProc({ stdout: new PassThrough() });
  process.nextTick(() => proc.emit('error', err));
  return proc;
}

/** 取出第一次 spawn 调用的 (file, args)，不锁死 options。 */
function spawnCall(): { file: string; args: string[] } {
  const call = mockSpawn.mock.calls[0] as [string, string[], unknown] | undefined;
  expect(call).toBeDefined();
  return { file: call![0], args: call![1] };
}

// 真实 CIM 形态：含空格路径带双引号（朴素 split(/\s+/) 会切碎该 token）
const CIM_COMMAND_LINE =
  '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\pkg\\cli.js';
const CIM_CREATION_DATE = '20260904215415.123456+480';

beforeEach(() => {
  mockSpawn.mockReset();
  mockExecFileSync.mockReset();
});

describe('queryProcessIdentity (posix)', () => {
  it('用 ps -o command= -p <pid> 取命令行并去掉首尾空白', async () => {
    mockSpawn.mockReturnValue(procWithStdout('/usr/local/bin/claude --verbose\n'));
    const identity = await queryProcessIdentity(4242, { platform: 'linux' });
    expect(identity).toEqual({ commandLine: '/usr/local/bin/claude --verbose' });
    const { file, args } = spawnCall();
    expect(file).toBe('ps');
    expect(args).toEqual(['-o', 'command=', '-p', '4242']);
  });

  it('pid 不存在（空输出）→ null', async () => {
    mockSpawn.mockReturnValue(procWithStdout('', 1));
    await expect(queryProcessIdentity(4242, { platform: 'darwin' })).resolves.toBeNull();
  });

  it('ps 非零退出 → null', async () => {
    mockSpawn.mockReturnValue(procWithStdout('  PID TTY\n', 1));
    await expect(queryProcessIdentity(4242, { platform: 'linux' })).resolves.toBeNull();
  });

  it('spawn 失败（ENOENT）→ null，不抛', async () => {
    mockSpawn.mockReturnValue(procError(new Error('spawn ps ENOENT')));
    await expect(queryProcessIdentity(4242, { platform: 'linux' })).resolves.toBeNull();
  });

  it('子进程挂住不退出 → 超时返回 null 并杀掉子进程', async () => {
    const proc = procNeverExits();
    mockSpawn.mockReturnValue(proc);
    await expect(
      queryProcessIdentity(4242, { platform: 'linux', timeoutMs: 5 }),
    ).resolves.toBeNull();
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe('queryProcessIdentity (win32)', () => {
  it('走 CIM（Win32_Process + ConvertTo-Json），解析 CommandLine 与 CreationDate', async () => {
    mockSpawn.mockReturnValue(
      procWithStdout(
        JSON.stringify({ CommandLine: CIM_COMMAND_LINE, CreationDate: CIM_CREATION_DATE }),
      ),
    );
    const identity = await queryProcessIdentity(4242, { platform: 'win32' });
    expect(identity).toEqual({ commandLine: CIM_COMMAND_LINE, creationDate: CIM_CREATION_DATE });
    const { file, args } = spawnCall();
    // 只锁「走 CIM + 出 JSON」这个设计决策，不锁整串命令
    expect(file.toLowerCase()).toMatch(/^(powershell|pwsh)(\.exe)?$/);
    const joined = args.join(' ');
    expect(joined).toContain('Win32_Process');
    expect(joined).toContain('4242');
    expect(joined).toMatch(/ConvertTo-Json/);
  });

  it('CIM 返回数组 → 取首个元素', async () => {
    mockSpawn.mockReturnValue(
      procWithStdout(
        JSON.stringify([
          { CommandLine: CIM_COMMAND_LINE, CreationDate: CIM_CREATION_DATE },
          { CommandLine: 'C:\\other.exe', CreationDate: '20260101000000.000000+480' },
        ]),
      ),
    );
    const identity = await queryProcessIdentity(4242, { platform: 'win32' });
    expect(identity).toEqual({ commandLine: CIM_COMMAND_LINE, creationDate: CIM_CREATION_DATE });
  });

  it('进程已退出（空输出）→ null', async () => {
    mockSpawn.mockReturnValue(procWithStdout('   \n'));
    await expect(queryProcessIdentity(4242, { platform: 'win32' })).resolves.toBeNull();
  });

  it('CommandLine 缺失（权限不足）→ null', async () => {
    mockSpawn.mockReturnValue(
      procWithStdout(JSON.stringify({ CommandLine: null, CreationDate: CIM_CREATION_DATE })),
    );
    await expect(queryProcessIdentity(4242, { platform: 'win32' })).resolves.toBeNull();
  });
});

describe('verifyPidIdentityVerdict（异步入口：posix ps / win32 CIM 取身份后判定）', () => {
  it('posix：命令行首个 token 的 basename 与期望二进制一致 → match', async () => {
    mockSpawn.mockReturnValue(procWithStdout('/usr/local/bin/claude --verbose\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('match');
  });

  it('posix：basename 不一致 → mismatch（防 pid 复用误杀）', async () => {
    mockSpawn.mockReturnValue(procWithStdout('/usr/local/bin/codex --verbose\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('mismatch');
  });

  it('posix：解释器跑 cli.js 的命令行不匹配裸 agent 名 → mismatch', async () => {
    mockSpawn.mockReturnValue(procWithStdout('node /home/user/pkg/cli.js --run\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('mismatch');
  });

  it('posix：脚本路径 basename 匹配 → match（node 跑的 agent 入口）', async () => {
    mockSpawn.mockReturnValue(procWithStdout('node /home/user/.local/bin/claude --verbose\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('match');
  });

  it('posix：任意位置裸参数恰好等于期望名 → mismatch（防误杀无辜进程）', async () => {
    // bash 跑一个恰好叫 claude 的脚本、grep 参数引用 claude——都不是 claude 进程
    mockSpawn.mockReturnValue(procWithStdout('bash claude\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('mismatch');
    mockSpawn.mockReturnValue(procWithStdout('grep claude /var/log/app.log\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('mismatch');
  });

  it('win32：含空格引号路径不被空白切碎（引号感知 tokenizer）', async () => {
    mockSpawn.mockReturnValue(
      procWithStdout(
        JSON.stringify({ CommandLine: CIM_COMMAND_LINE, CreationDate: CIM_CREATION_DATE }),
      ),
    );
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'win32', expectedBinary: 'node' }),
    ).resolves.toBe('match');
  });

  it('win32：.exe 扩展与大小写不敏感', async () => {
    mockSpawn.mockReturnValue(
      procWithStdout(
        JSON.stringify({ CommandLine: CIM_COMMAND_LINE, CreationDate: CIM_CREATION_DATE }),
      ),
    );
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'win32', expectedBinary: 'node' }),
    ).resolves.toBe('match');
    mockSpawn.mockReturnValue(
      procWithStdout(
        JSON.stringify({
          CommandLine: 'C:\\Node\\NODE.EXE C:\\pkg\\cli.js',
          CreationDate: CIM_CREATION_DATE,
        }),
      ),
    );
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'win32', expectedBinary: 'claude' }),
    ).resolves.toBe('mismatch');
  });

  it('大小写敏感性跟随平台：darwin 不敏感 → match，linux 严格 → mismatch', async () => {
    mockSpawn.mockReturnValue(procWithStdout('/usr/bin/CLAUDE --verbose\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'darwin', expectedBinary: 'claude' }),
    ).resolves.toBe('match');
    mockSpawn.mockReturnValue(procWithStdout('/usr/bin/CLAUDE --verbose\n'));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'claude' }),
    ).resolves.toBe('mismatch');
  });

  it('win32：CreationDate 匹配才 match；旧 pid 文件缺省该字段退化为仅命令行匹配', async () => {
    const cimOut = JSON.stringify({
      CommandLine: CIM_COMMAND_LINE,
      CreationDate: CIM_CREATION_DATE,
    });
    mockSpawn.mockReturnValue(procWithStdout(cimOut));
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'win32',
        expectedBinary: 'node',
        expectedCreationDate: CIM_CREATION_DATE,
      }),
    ).resolves.toBe('match');

    mockSpawn.mockReturnValue(procWithStdout(cimOut));
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'win32',
        expectedBinary: 'node',
        expectedCreationDate: '20200101000000.000000+480',
      }),
    ).resolves.toBe('mismatch');

    mockSpawn.mockReturnValue(procWithStdout(cimOut));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'win32', expectedBinary: 'node' }),
    ).resolves.toBe('match');
  });

  it('身份查询失败（进程不存在）→ unknown，不是 mismatch', async () => {
    // 两者在生产里处置方向相反：killOrphan 都不杀，但 InstanceLock 只有
    // mismatch 才接管锁，unknown 必须退回存活探测。
    mockSpawn.mockReturnValue(procWithStdout('', 1));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'win32', expectedBinary: 'node' }),
    ).resolves.toBe('unknown');
  });
});

describe('tokenizeCommandLine', () => {
  it('双引号段整体保留，空白只在引号外切分', () => {
    expect(tokenizeCommandLine('"C:\\Program Files\\nodejs\\node.exe" --verbose')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      '--verbose',
    ]);
  });

  it('无引号退化为空白切分；空引号段也是 token', () => {
    expect(tokenizeCommandLine('/usr/local/bin/claude --verbose')).toEqual([
      '/usr/local/bin/claude',
      '--verbose',
    ]);
    expect(tokenizeCommandLine('node "" x')).toEqual(['node', '', 'x']);
  });

  it('末尾未闭合引号不吞 token', () => {
    expect(tokenizeCommandLine('claude "unclosed')).toEqual(['claude', 'unclosed']);
  });
});

/**
 * 匹配强度分档（2026-09-20）。fixture 取自本机实测的**真实安装形态**（脱敏，
 * 家目录用 /home/user 占位），对应 identity.ts 的 IdentityMatchMode 注释：
 *   - claude → `bin/claude.exe`（Mach-O 原生单文件，ps 首 token 就是它）
 *   - codex  → `@openai/codex/bin/codex.js`（`#!/usr/bin/env node`，basename 恰好同名）
 *   - pi     → `@earendil-works/pi-coding-agent/dist/bundle/cli.js`（名字只在目录里）
 *   - dsh    → `@deepseek-ai/dsh/lib/bin.js`（同上）
 * 后两者用 'executable' 档恒判 mismatch → 那两个 agent 的 killOrphan 会静默失效。
 * 这就是这一档存在的全部理由，不是风格偏好。
 */
const NODE_BIN = '/home/user/.nvm/versions/node/v25.6.1/bin/node';
const PI_CMD = `${NODE_BIN} /home/user/.nvm/versions/node/v25.6.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --flag`;

describe('matchMode：executable（默认）vs agent-invocation', () => {
  it('agent-invocation：agent 名只在路径段里也命中（pi / dsh 真实安装形态）', async () => {
    mockSpawn.mockReturnValue(procWithStdout(`${PI_CMD}\n`));
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'pi',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('match');

    mockSpawn.mockReturnValue(
      procWithStdout(
        `${NODE_BIN} /home/user/.nvm/versions/node/v25.6.1/lib/node_modules/@deepseek-ai/dsh/lib/bin.js\n`,
      ),
    );
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'dsh',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('match');
  });

  it('默认 executable 档对同一命令行判 mismatch（InstanceLock 必须保持严格）', async () => {
    // 锁文件记的是 binaryName(process.execPath)（node/bun）。放松成路径段匹配会让
    // 形如 node-18 的无关进程被判成「锁还在」→ 新实例再也起不来。
    mockSpawn.mockReturnValue(procWithStdout(`${PI_CMD}\n`));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'pi' }),
    ).resolves.toBe('mismatch');
  });

  it('agent-invocation：basename 恰好同名的形态本来就命中（codex / claude 原生）', async () => {
    mockSpawn.mockReturnValue(
      procWithStdout(
        `${NODE_BIN} /home/user/.nvm/versions/node/v25.6.1/lib/node_modules/@openai/codex/bin/codex.js\n`,
      ),
    );
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'codex',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('match');

    mockSpawn.mockReturnValue(
      procWithStdout(
        '/home/user/.nvm/versions/node/v25.6.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --verbose\n',
      ),
    );
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'claude',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('match');
  });

  it('agent-invocation 仍拒绝裸参数与「整条路径里没有该名字」（防误杀）', async () => {
    for (const cmd of [
      'bash claude',
      'grep claude /var/log/app.log',
      `${NODE_BIN} /home/user/pkg/cli.js --run`,
    ]) {
      mockSpawn.mockReturnValue(procWithStdout(`${cmd}\n`));
      await expect(
        verifyPidIdentityVerdict(4242, {
          platform: 'linux',
          expectedBinary: 'claude',
          matchMode: 'agent-invocation',
        }),
      ).resolves.toBe('mismatch');
    }
  });

  it('段前缀必须紧跟非字母数字（claude-code 命中；claudette / claudeAgent 不命中）', async () => {
    mockSpawn.mockReturnValue(procWithStdout(`${NODE_BIN} /home/user/claude-code/cli.js\n`));
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'claude',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('match');

    for (const dir of ['claudette', 'claudeAgent']) {
      mockSpawn.mockReturnValue(procWithStdout(`${NODE_BIN} /home/user/${dir}/x.js\n`));
      await expect(
        verifyPidIdentityVerdict(4242, {
          platform: 'linux',
          expectedBinary: 'claude',
          matchMode: 'agent-invocation',
        }),
      ).resolves.toBe('mismatch');
    }
  });

  it('已知代价：段前缀档对短名偏松（pi 会命中 pi-data/），换的是 pi/dsh 真能回收', async () => {
    mockSpawn.mockReturnValue(procWithStdout(`${NODE_BIN} /home/user/pi-data/x.js\n`));
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'pi',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('match');
  });

  it('三态区分：不匹配 → mismatch；查不到进程 → unknown', async () => {
    mockSpawn.mockReturnValue(procWithStdout(`${NODE_BIN} /home/user/pkg/cli.js\n`));
    await expect(
      verifyPidIdentityVerdict(4242, {
        platform: 'linux',
        expectedBinary: 'pi',
        matchMode: 'agent-invocation',
      }),
    ).resolves.toBe('mismatch');

    mockSpawn.mockReturnValue(procWithStdout('', 1));
    await expect(
      verifyPidIdentityVerdict(4242, { platform: 'linux', expectedBinary: 'pi' }),
    ).resolves.toBe('unknown');
  });
});

describe('verifyPidIdentityVerdictSync（killOrphan 的同步入口）', () => {
  // platform 必须显式钉死：同步档在 win32 上**恒** unknown（CIM 无同步形态，见下一条
  // 用例），不钉就会跟着宿主漂——在 macOS 上「默认档=posix」通过，在 Windows 上必红。
  it('posix：execFileSync 取 ps 命令行，按 matchMode 裁决', () => {
    mockExecFileSync.mockReturnValue(`${PI_CMD}\n`);
    expect(
      verifyPidIdentityVerdictSync(4242, {
        platform: 'linux',
        expectedBinary: 'pi',
        matchMode: 'agent-invocation',
      }),
    ).toBe('match');

    mockExecFileSync.mockReturnValue(`${NODE_BIN} /home/user/pkg/cli.js\n`);
    expect(
      verifyPidIdentityVerdictSync(4242, {
        platform: 'linux',
        expectedBinary: 'pi',
        matchMode: 'agent-invocation',
      }),
    ).toBe('mismatch');
  });

  it('查询失败（进程不存在 / ps 不可用）→ unknown（fail-closed，调用方不杀）', () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(verifyPidIdentityVerdictSync(4242, { platform: 'linux', expectedBinary: 'pi' })).toBe(
      'unknown',
    );
  });

  it('win32：同步档恒 unknown（CIM 无同步形态），且不发起任何查询', () => {
    mockExecFileSync.mockReturnValue('anything\n');
    expect(
      verifyPidIdentityVerdictSync(4242, { platform: 'win32', expectedBinary: 'claude' }),
    ).toBe('unknown');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('非法 pid → unknown，不发起查询', () => {
    expect(verifyPidIdentityVerdictSync(0, { expectedBinary: 'pi' })).toBe('unknown');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
