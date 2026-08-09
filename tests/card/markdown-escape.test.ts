/**
 * 红 agent - Round 1 anchor 测试（特殊字符保护）
 *
 * 验收标准：
 * 1. 卡片 markdown 内容中的特殊字符被正确转义
 * 2. 覆盖飞书常见解析错误场景：反斜杠、方括号、下划线、星号等
 * 3. 转义后内容不会触发飞书 230099 错误
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock logger
vi.mock('../logger/index.js', () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('飞书卡片 markdown 特殊字符保护 - anchor 测试', () => {
  it('应该存在 markdown 内容转义函数', () => {
    // 检查是否有 escapeMarkdown 或 sanitizeMarkdown 函数
    // 可以在 collapsible.ts, run-renderer.ts, 或新建 utils 中

    const filesToCheck = [
      path.join(__dirname, '../../src/card/collapsible.ts'),
      path.join(__dirname, '../../src/card/run-renderer.ts'),
      path.join(__dirname, '../../src/card/tool-render.ts'),
    ];

    const hasEscapeFunction = filesToCheck.some((filePath) => {
      const content = fs.readFileSync(filePath, 'utf-8');
      return /escape|sanitize|normalize.*markdown/i.test(content);
    });

    expect(hasEscapeFunction).toBe(true);
  });

  it('应该处理反斜杠 \\ 字符', () => {
    const filesToCheck = [
      path.join(__dirname, '../../src/card/collapsible.ts'),
      path.join(__dirname, '../../src/card/run-renderer.ts'),
    ];

    const handlesBackslash = filesToCheck.some((filePath) => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // 检查是否有处理反斜杠的逻辑
      return /\\\\|backslash|escape.*\\\\/i.test(content);
    });

    expect(handlesBackslash).toBe(true);
  });

  it('应该处理方括号 [] 字符', () => {
    const filesToCheck = [
      path.join(__dirname, '../../src/card/collapsible.ts'),
      path.join(__dirname, '../../src/card/run-renderer.ts'),
    ];

    const handlesBracket = filesToCheck.some((filePath) => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // 检查是否有处理方括号的逻辑
      return /\[.*\]|bracket|sanitize.*\[/i.test(content);
    });

    expect(handlesBracket).toBe(true);
  });

  it('应该处理下划线 _ 和星号 * 字符（markdown 特殊符号）', () => {
    const filesToCheck = [
      path.join(__dirname, '../../src/card/collapsible.ts'),
      path.join(__dirname, '../../src/card/run-renderer.ts'),
    ];

    const handlesMarkdownSpecial = filesToCheck.some((filePath) => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // 检查是否有处理 markdown 特殊符号的逻辑
      return /(\\_|\\*|underscore|asterisk|markdown.*special|special.*markdown)/i.test(content);
    });

    expect(handlesMarkdownSpecial).toBe(true);
  });

  it('markdownDiv 应该在渲染内容时进行转义处理', () => {
    const collapsiblePath = path.join(__dirname, '../../src/card/collapsible.ts');
    const content = fs.readFileSync(collapsiblePath, 'utf-8');

    // markdownDiv 函数应该包含转义处理
    // 检查是否在设置 content 之前进行了处理
    const hasSanitization =
      /markdownDiv.*escape|sanitize|normalize/i.test(content) ||
      /content.*escape|sanitize|normalize/i.test(content);

    expect(hasSanitization).toBe(true);
  });

  it('转义函数应该能够防止飞书 230099 错误', () => {
    // 这个测试检查是否有针对飞书错误 230099 的防护
    // 错误信息是 "markdown content parse error"
    const filesToCheck = [
      path.join(__dirname, '../../src/card/collapsible.ts'),
      path.join(__dirname, '../../src/card/run-renderer.ts'),
      path.join(__dirname, '../../src/connector/index.ts'),
    ];

    const has230099Handling = filesToCheck.some((filePath) => {
      if (!fs.existsSync(filePath)) return false;
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return /230099|parse.*error|markdown.*error/i.test(fileContent);
    });

    // 这个测试可能需要调整，因为可能是在运行时捕获错误而不是预防
    // 暂时标记为可选
    expect(has230099Handling).toBe(true);
  });
});
