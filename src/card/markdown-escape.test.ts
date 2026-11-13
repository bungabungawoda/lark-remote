import { describe, it, expect } from 'vitest';
import { markdownDiv, unescapeMarkdown } from './collapsible.js';
import { collectCardTexts } from '../../tests/lib/card-view.js';

/**
 * ANCHOR: 卡片取文必须还原 markdown 反斜杠转义。
 *
 * 故障形态：`markdownDiv` 把内容里的 `\` 转义成 `\\`（飞书 lark_md 的转义
 * 字符），而测试从渲染后的卡片 JSON 取文时拿到的是**转义后**的字符串。任何
 * `toContain(<路径>)` 断言在 POSIX 宿主上恒绿（路径无反斜杠），只在
 * ci-windows 上红——Windows 路径 `C:\Users\...` 变成 `C:\\Users\\...`。
 *
 * 后果：两处 anchor（config 切换卡的 📁 工作区行）在 Windows CI 假红，
 * 且本地 macOS/Linux 复跑永远无法复现，只能靠 CI 反推。
 *
 * 约束：`collectCardTexts` 对 `lark_md` 内容调用 `unescapeMarkdown` 再返回，
 * 断言比对用户看到的原文。本文件用 Windows 风格路径在任意宿主上钉住该契约
 * （不依赖真实 Windows 路径，POSIX 上也能红）。
 */
describe('markdownDiv 反斜杠转义与取文还原', () => {
  const winPath = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ws';

  it('markdownDiv 把反斜杠转义（飞书 lark_md 语义）', () => {
    const div = markdownDiv(`📁 ${winPath}`) as { text: { tag: string; content: string } };
    expect(div.text.tag).toBe('lark_md');
    expect(div.text.content).toBe(
      '📁 C:\\\\Users\\\\runneradmin\\\\AppData\\\\Local\\\\Temp\\\\ws',
    );
  });

  it('unescapeMarkdown 是 escapeMarkdown 的逆', () => {
    const div = markdownDiv(winPath) as { text: { content: string } };
    expect(unescapeMarkdown(div.text.content)).toBe(winPath);
    // 幂等边界：无反斜杠与空串原样返回
    expect(unescapeMarkdown('')).toBe('');
    expect(unescapeMarkdown('/tmp/ws')).toBe('/tmp/ws');
  });

  it('collectCardTexts 还原 lark_md 内容，Windows 路径按原文命中', () => {
    const card = { body: { elements: [markdownDiv(`已切换，session 已清空\n📁 ${winPath}`)] } };
    const texts = collectCardTexts(card);
    expect(texts.join(' ')).toContain(`📁 ${winPath}`);
  });

  it('collectCardTexts 不还原 plain_text / markdown（未经转义的组件）', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: '🔀 切换到 Pi' } },
      body: {
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content: 'a\\b' } },
          { tag: 'collapsible_panel', header: { title: { tag: 'markdown', content: 'c\\d' } } },
        ],
      },
    };
    const texts = collectCardTexts(card);
    expect(texts).toContain('🔀 切换到 Pi');
    expect(texts).toContain('a\\b');
    expect(texts).toContain('c\\d');
  });
});
