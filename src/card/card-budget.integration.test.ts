import { describe, it, expect } from 'vitest';
import { enforceCardBudget } from './card-budget.js';

// 集成测试：enforceCardBudget 的 28KB 截断逻辑
describe('enforceCardBudget 28KB truncation', () => {
  it('should handle card with long document content exceeding 28KB budget', () => {
    // 模拟一个包含长文档内容的会话卡片（用于测试 enforceCardBudget 的 28KB 截断逻辑）
    const longDocContent = `
# 卡片预算保护机制设计文档

**概述**: enforceCardBudget 函数负责在卡片发送前检查其序列化字节大小，并在超过 28KB 限制时执行渐进式截断，以确保飞书消息 API 不会因 payload 过大而拒绝发送。

---

## 1. 背景与动机

飞书卡片消息 API 对单条消息的 payload 大小有限制（约 30KB）。当 Agent 会话包含大量 thinking 块、工具调用结果、或长文本输出时，序列化后的卡片可能远超此限制，导致消息发送失败、用户看到空白卡片、或 bridge 进程因未捕获的 API 错误而崩溃。

卡片预算保护机制的核心目标是：在任何情况下，发送给飞书 API 的卡片 payload 都不超过 28KB（留 2KB 余量给协议包装开销）。

## 2. 截断策略概述

enforceCardBudget 采用三级渐进式截断策略：

1. **第一级 - 思考块截断**: 将 collapsible_panel 类型的 thinking 块内容截断到前 200 个字符，保留开头部分让用户了解思考的大致方向。
2. **第二级 - 工具结果截断**: 将工具调用结果（tool_result）的内容截断到前 500 个字符，保留开头部分让用户了解工具调用的输出概况。
3. **第三级 - 极端 fallback**: 如果前两级截断后仍超限，则丢弃所有非关键元素，只保留停止按钮和新会话按钮，确保用户始终能控制当前会话。

## 3. 第一级截断：思考块截断

### 3.1 为什么思考块是第一截断目标？

思考块（thinking）通常是 Agent 会话中最大的元素之一。Agent 在执行复杂任务时可能产生数千甚至数万字符的思考内容，而这些内容对用户来说通常是参考性的——用户更关心 Agent 的最终输出和工具调用结果，而非完整的思考过程。

### 3.2 截断阈值

思考块内容截断到前 200 个字符。这个阈值是经验性的——足够让用户了解思考的大致方向（"用户想要实现 X 功能，我需要先检查 Y"），但不会保留过多的冗余内容。

### 3.3 截断后的标记

截断后的思考块末尾会添加 "[...已截断]" 标记，告知用户内容已被截断。这个标记是纯文本的，不使用任何 markdown 格式，以确保在各种渲染环境下都能正确显示。

### 3.4 边界情况处理

- 如果思考块内容本身不足 200 个字符，则不执行截断。
- 如果思考块内容恰好是 200 个字符，则不执行截断（等于阈值不截断）。
- 如果思考块内容包含多字节 UTF-8 字符（如中文、日文、韩文），则按字节长度截断，可能在字符中间截断。

## 4. 第二级截断：工具结果截断

### 4.1 为什么工具结果是第二截断目标？

工具调用结果（tool_result）可能是 Agent 会话中最大的元素。例如，读取一个大型日志文件、执行一个返回大量数据的 SQL 查询、或调用一个返回长 JSON 的 API，都可能产生数万甚至数十万字符的工具结果。

### 4.2 截断阈值

工具结果内容截断到前 500 个字符。这个阈值比思考块的阈值更高（500 vs 200），因为工具结果通常包含更多的结构性信息（如文件路径、命令行、JSON 结构等），用户需要更多的上下文来理解工具调用的输出。

### 4.3 截断后的标记

截断后的工具结果末尾会添加 "[...已截断，完整结果请查看会话日志]" 标记，告知用户内容已被截断，并引导用户查看完整的会话日志。

### 4.4 特殊情况：Bash 输出截断

对于 Bash 命令的输出，enforceCardBudget 还会额外保留最后 12KB 的输出（从末尾截取），以确保用户能看到最近的命令执行结果。这是因为 Bash 命令的输出通常是按时间顺序的，最近的输出通常最有价值。

## 5. 第三级截断：极端 fallback

### 5.1 什么时候会触发极端 fallback？

当第一级和第二级截断都执行完毕后，如果卡片 payload 仍然超过 28KB 限制，则触发极端 fallback。这种情况通常发生在：

- 卡片包含大量 collapsible_panel 元素（每个面板都有标题和内容）
- 卡片包含大量 hr（分隔线）元素
- 卡片包含大量 div 元素，且每个元素都有很长的文本内容
- 卡片的 header 或 config 元素本身就很大

### 5.2 极端 fallback 的行为

极端 fallback 会丢弃所有非关键元素，只保留：

1. 卡片 header（标题）
2. 停止按钮（如果当前会话仍在运行）
3. 新会话按钮

这确保了即使在最极端的情况下，用户仍然能够控制当前会话——停止正在运行的 Agent，或开始一个新的会话。

### 5.3 极端 fallback 的标记

极端 fallback 后的卡片会在 header 下方添加一个警告文本块，告知用户："卡片内容过大，已折叠部分元素。请使用 /new 开始新会话，或使用 /stop 停止当前会话。"

## 6. 预算计算细节

### 6.1 字节大小 vs 字符大小

enforceCardBudget 使用 Buffer.byteLength(JSON.stringify(card), 'utf8') 计算卡片的大小。这是因为：

- 飞书 API 的 payload 限制是按字节计算的，不是按字符计算的。
- UTF-8 编码下，多字节字符（如中文、日文、韩文）的字节大小可能大于字符大小。例如，一个中文字符在 UTF-8 下占 3 个字节。
- 如果按字符大小计算，可能会导致实际 payload 超过字节限制。

### 6.2 序列化开销

enforceCardBudget 计算的是 JSON.stringify(card) 的大小，即序列化后的 JSON 字符串的字节大小。这包括了：

- JSON 的语法开销（引号、逗号、冒号、括号等）
- 字段名的开销（每个元素都需要包含 tag、content、elements 等字段名）
- 嵌套结构的开销（每个 collapsible_panel 都包含 header、elements 等嵌套字段）

### 6.3 28KB 限制的由来

28KB 限制是飞书 API payload 限制（约 30KB）减去 2KB 的协议包装开销：

- 飞书 API 的 payload 限制是约 30KB（确切值可能因 API 版本和消息类型而异）。
- 协议包装开销包括：HTTP 请求头、multipart/form-data 边界标记、JSON 外层包装等。
- 留 2KB 余量可以确保在各种协议包装情况下都不会超限。

## 7. 与其他子系统的交互

### 7.1 与 bridge 的交互

bridge 在发送每条卡片消息前都会调用 enforceCardBudget 进行预算检查。如果 enforceCardBudget 返回 wasTruncated = true，bridge 会在日志中记录一条 warning，但不会阻止卡片发送。

### 7.2 与 router 的交互

router 不直接调用 enforceCardBudget。router 负责生成卡片的初始内容，然后交给 bridge 发送。bridge 在发送前调用 enforceCardBudget。

### 7.3 与 run-renderer 的交互

run-renderer 负责将 Agent 事件流渲染为卡片元素。run-renderer 不关心卡片大小——它只负责生成正确的卡片元素，截断逻辑由 enforceCardBudget 统一处理。

### 7.4 与 session reader 的交互

session reader 在读取历史会话内容时也不关心卡片大小。session reader 返回的会话内容可能非常长，但最终发送给用户时仍会经过 enforceCardBudget 的预算检查。

## 8. 测试策略

### 8.1 单元测试

enforceCardBudget 的单元测试覆盖了以下场景：

- 空卡片（不触发截断）
- 小卡片（不触发截断）
- 大卡片（触发第一级截断）
- 超大卡片（触发第一级和第二级截断）
- 极端卡片（触发极端 fallback）
- 多字节字符卡片（中文、日文、韩文）
- 深度嵌套卡片（多层 collapsible_panel）
- 只有 header 的卡片（极端 fallback 后仍保留 header）

### 8.2 集成测试

集成测试使用一个包含长文档内容的模拟卡片来验证 enforceCardBudget 的端到端行为。测试会验证：

- 原始卡片确实超过 28KB 限制
- 截断后的卡片确实在 28KB 限制内
- wasTruncated 标志被正确设置

### 8.3 回归测试

回归测试确保之前修复的 bug 不会再次出现。例如，之前曾经出现过截断后的卡片仍然超限的 bug（因为截断逻辑没有考虑 JSON 序列化开销），回归测试会确保这种 bug 不会再次出现。

## 9. 未来改进方向

### 9.1 智能截断

当前的截断策略是基于固定阈值的（思考块 200 字符，工具结果 500 字符）。未来可以考虑基于内容重要性的智能截断——例如，保留思考块中的结论性语句，丢弃探索性的语句。

### 9.2 分块发送

当前的策略是截断超限内容。未来可以考虑将超限内容分块发送——将一个大卡片拆分为多个小卡片，按顺序发送给用户。这样可以保留完整的内容，但会增加消息数量和用户操作的复杂性。

### 9.3 用户可配置截断阈值

当前截断阈值是硬编码的。未来可以考虑让用户通过配置文件自定义截断阈值——例如，高级用户可以设置更大的截断阈值（如 1000 字符），以保留更多的上下文信息。

## 10. 总结

卡片预算保护机制是 bridge 与飞书 API 之间的关键保护层。它通过三级渐进式截断策略，确保在任何情况下发送给飞书 API 的卡片 payload 都不超过 28KB 限制。截断策略的设计原则是：

1. 优先截断参考性内容（思考块），保留操作性内容（工具结果）
2. 始终保留用户控制能力（停止按钮、新会话按钮）
3. 截断后提供明确的标记，告知用户内容已被截断

这种设计确保了即使在最极端的情况下（Agent 产生大量输出、工具返回超长结果、会话包含大量思考块），用户仍然能够收到有效的卡片消息，并能够控制当前会话。
    `.repeat(5); // 复制 5 次使其更长

    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '📂 /home/user/project' } },
      body: {
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '已恢复最近会话: **dddddddd-1111-2222-3333-444444444444**',
            },
          },
          { tag: 'hr' },
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'markdown', content: 'thinking (2026-01-15 08:00)' } },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: 'placeholder',
                },
              },
            ],
          },
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'markdown', content: 'tool_use (2026-01-15 08:00)' } },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: '🔧 read: { "path": "/home/user/project/docs/long-review-doc.md" }',
                },
              },
            ],
          },
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'markdown', content: 'text (2026-01-15 08:00)' } },
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: longDocContent } }],
          },
        ],
      },
    };

    // 验证原始卡片超限
    const originalSize = Buffer.byteLength(JSON.stringify(card), 'utf8');
    expect(originalSize).toBeGreaterThan(28_000); // 确保确实超限

    // 应用保护
    const result = enforceCardBudget(card);

    // 验证保护生效
    expect(result.wasTruncated).toBe(true);

    // 验证保护后的卡片大小
    const protectedSize = Buffer.byteLength(JSON.stringify(result.card), 'utf8');
    expect(protectedSize).toBeLessThanOrEqual(28_000);
  });
});
