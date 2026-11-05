/**
 * formatBytes 的行为测试：通过 /ls 的公开出口 buildLsCommand 触发文件卡片，
 * 断言用户实际看到的「大小」文案逐字正确。fixture 用稀疏文件覆盖 B / KB /
 * MB / GB 的真实边界值（0、512、1023、1024、1MiB-1、1MiB、1GiB、2.5GiB），
 * 而不是断言内部函数存在或长度。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLsCommand } from '../../src/router/commands/ls.js';
import type { CommandContext } from '../../src/bridge/index.js';
import { writeSizedFile } from '../lib/sized-file.js';

const ctx: CommandContext = { userId: 'user1', chatId: 'chat1', messageId: 'msg1' };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-format-bytes-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 走公开出口取文件卡片第一行（路径 + 大小），这是用户实际看到的文本。 */
function fileCardFirstLine(filePath: string): string {
  const result = buildLsCommand([filePath], ctx, { cwd: tmpDir });
  const card = result.card as {
    body: { elements: Array<{ text?: { content?: string } }> };
  };
  return card.body.elements[0].text?.content ?? '';
}

const CASES: ReadonlyArray<readonly [number, string]> = [
  [0, '0B'],
  [512, '512B'],
  [1023, '1023B'],
  [1024, '1.0KB'],
  [1024 * 1024 - 1, '1024.0KB'],
  [1024 * 1024, '1.0MB'],
  [1024 * 1024 * 1024, '1.0GB'],
  [Math.floor(2.5 * 1024 * 1024 * 1024), '2.5GB'],
];

describe('formatBytes via /ls file card', () => {
  for (const [size, expected] of CASES) {
    it(`renders ${size} bytes as ${expected}`, () => {
      const filePath = path.join(tmpDir, `f-${size}.bin`);
      writeSizedFile(filePath, size);
      expect(fileCardFirstLine(filePath)).toBe(`\`${filePath}\`\n${expected}`);
    });
  }
});
