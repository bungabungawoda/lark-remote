# Claude 400「exceeds the context window」根因与长久修复

## 现象

长会话里 Claude 回复一行红字：

```
API Error: 400 Your input exceeds the context window of this model.
Please adjust your input and try again. (request id: ...)
```

之后继续发消息仍然 400，连 `/compact` 也救不回来，任务卡死。

## 根因

网关（`ANTHROPIC_BASE_URL`，本机是 `https://coder.narwal.com`）按
`context_window - max_output_tokens` 拒绝超限输入，而 Claude Code 只按模型名
里的 `[1M]` 认为窗口是 1M。

以 `gpt-6-astra` 为例（2026-09-27 实测）：

| 项 | 值 | 来源 |
|---|---|---|
| 网关声明 context_window | 1,050,000 | `/v1/models` |
| 网关声明 max_output_tokens | 128,000 | `/v1/models` |
| 网关真实输入上限 | ≈922,000 | 921,325 成功、再大即 400 |
| Claude Code 认为的窗口 | 1,000,000（`[1M]`） | stream-json `modelUsage.contextWindow` |
| Claude Code 认为的 max output | 32,000 | stream-json `modelUsage.maxOutputTokens` |

两边对不上（922k vs 1M，且 max output 差 128k vs 32k），Claude Code 的自动压缩
阈值也跟着偏高，所以它在撞到 922k 之前不会压缩。等上下文到了 921k 再触发压缩时，
压缩请求本身也超过 922k，于是 400 反复出现、会话彻底卡死。

不同模型的上限不同：`deepseek-v4.1-flash` 实测 979k 输入仍成功，
`glm-5.3-flash` 未单独验证。

## 长久修复

给 Claude Code 一个显式的自动压缩窗口，让它在下限之前就压缩：
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（或 settings.json 的 `autoCompactWindow`）。
本仓库把它做成了配置项 `claude.autoCompactWindow`，spawn claude 时注入子进程环境，
不依赖用户全局 settings.json（后者会被 cc-switch 的重写覆盖）。

```yaml
claude:
  model: gpt-6-astra[1M]
  # 750k ≈ 真实上限(922k) - 安全余量，覆盖 astra / glm / deepseek 三条路由
  autoCompactWindow: 750000
```

`0` 表示不注入，沿用 settings.json / 环境默认（不推荐：会重现本问题）。

## 验证

已用 stream-json 模式（bridge 实际用的模式）验证该变量生效：设
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=30000` 跑两轮，第一轮上下文 44k，第二轮自动
降到 22k（说明中间压缩了）；不设时上下文单调增长直至撞墙。

## 注意

- 单个 turn 若注入超大工具结果（如 task-notification），可能一轮就跨越窗口。
  750k 留了 ~170k 余量，够常规单轮增长；遇到超大规模输出仍需拆小。
- 网关每个模型的上限不同，换模型后若仍偶发 400，把该模型的下调
  `autoCompactWindow` 即可，无需改代码。
