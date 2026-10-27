[English](../../en/architecture/streaming-card.md) | 简体中文

# 单卡流式输出架构

Run/Bash 卡片的 CardKit 2.0 单卡流式架构说明，覆盖数据流、状态机、渲染规则、预算控制与降级策略。

## 1. 目标

一次 `claude -p` 运行在飞书侧正常路径只创建一张 CardKit 2.0 卡片：

- 运行期间原地更新 thinking、正文和工具摘要；
- 结束时明确区分 done、error、interrupted、idle_timeout；
- Claude 进程只负责输出 JSONL，不参与卡片构造；
- 普通消息保持串行，`/stop` 和停止按钮可以立即中断当前 run。

卡片是有损进度摘要，不是完整 transcript。超出滚动窗口的内容不会持久化。

## 2. 已验证的 SDK 机制

当前依赖为 `@larksuite/channel@0.7.1`。

`channel.stream(..., { card })` 的 card 模式：

1. 发送 initial interactive card；
2. producer 获得 `CardStreamController`；
3. `controller.update(card)` 更新 controller 当前状态，由 SDK throttle；
4. SDK 通过 `im.v1.message.patch` 对同一 `message_id` 做全卡替换；
5. producer 返回后，SDK flush throttle 并 drain FIFO update queue；
6. `channel.stream()` Promise 最后才返回 `messageId`。

因此：

- CardKit 2.0 可以通过全卡 patch 实现单卡更新；
- controller ready 不等于 stream Promise 完成；
- `RunCardSession.start()` 只能等待 controller ready，不能等待整个 stream；
- 卡片默认不写 `streaming_mode`。该字段是否有客户端动效只能真机验证。

## 3. 数据流

```text
普通飞书消息
  → Bridge work queue
  → ClaudeRunner.run()
  → AgentEvent
  → RunState reducer
  → renderRunCard()
  → CardStreamController.update()
  → 同一 message_id 全卡 patch

/stop 或 stop cardAction
  → control lane（绕过 work queue）
  → Bridge.interruptCurrentRun()
  → RunCardSession.finish(interrupted) + ClaudeRunner.stop()
```

核心模块：

| 模块                           | 职责                                                     |
| ------------------------------ | -------------------------------------------------------- |
| `src/card/run-state.ts`        | AgentEvent → 可渲染状态；终态幂等                        |
| `src/card/run-renderer.ts`     | RunState → CardKit 2.0 JSON                              |
| `src/card/run-card-session.ts` | controller-ready、producer-release、stream-done 生命周期 |
| `src/bridge/index.ts`          | active run、看门狗、session 同步、故障降级               |
| `src/connector/index.ts`       | `streamCard()` 与 `updateCard()` SDK 边界                |
| `src/index.ts`                 | 消息入口与 stop control lane 分流                        |

## 4. RunState

主要字段：

- `runId`
- `terminal`: running | finalizing | done | error | interrupted | idle_timeout | goal_continuing
- `footer`: thinking | tool_running | streaming | null
- `reasoning`
- 有序 `blocks`: text 或 tool
- `finalAnswer`: 协议明确标记或终态推断出的最终回答，独立于 `blocks`
- `resultSubtype`、`errorMsg`、`idleTimeoutMinutes`

事件转移：

| 输入                                           | 状态变化                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| system.init                                    | 记录 sessionId                                                                                                              |
| assistant.thinking                             | 按 itemId 分块：同块逐字追加 reasoning（不插分隔符），换块开新面板，footer=thinking                                         |
| assistant.text                                 | 合并相邻 text，footer=streaming                                                                                             |
| assistant.tool_use                             | 首次见 id → 新增 running tool；同 id → 原地合并 input/summary（opencode 的 tool_call_update 回填命令），footer=tool_running |
| user.tool_result                               | 匹配 tool id，置 ok/error 与 output                                                                                         |
| final_answer                                   | 写入 `finalAnswer`，并从进度 blocks 移除同一 item 的流式副本                                                                |
| result.success / result.error                  | finalizing（暂存 subtype/errorMsg，非终态）                                                                                 |
| result 但 agent 无 final_answer 标记           | 将最后一条非空 assistant text 提升为 `finalAnswer`（source=inferred）                                                       |
| CLI 进程退出（for-await 结束） + 仍 finalizing | done / error（lark-remote finally transition）                                                                              |
| 非零退出或 run 抛错                            | error                                                                                                                       |
| stdout 耗尽但无 result                         | error                                                                                                                       |
| `/stop` 或停止按钮                             | interrupted（可从 running 或 finalizing 转）                                                                                |
| 空闲看门狗                                     | idle_timeout                                                                                                                |

`finalizing` 是非终态：Claude Code CLI 2.x 在 main turn 结束写 `result` 事件后，若 turn 内启动了 `run_in_background` 任务，CLI 会等待后台任务退出才关闭 stream-json。所以 `result` 不再等于终态——只有 CLI 进程退出才算真正完成。卡片显示 `⏳ Claude · 完成中`（orange header），仍有 `⏹ 终止` 按钮（会杀掉主进程 + 后台子进程）。新消息依然按 workspace 串行队列排队等候，不打断后台等待。

终态只允许首次写入，后续 result、watchdog、stop 或异常不得覆盖。

## 5. CardKit 2.0 渲染

运行中卡片：

1. Header：`🤖 Claude`
2. 可选 thinking 摘要（标题显示 JSONL timestamp 的本地时间）
3. text/tool blocks（正文前缀和工具标题显示本地时间）
4. footer：正在思考、调用工具或输出
5. danger 停止按钮

停止按钮 payload：

```json
{ "cmd": "stop", "runId": "<uuid>" }
```

终态卡片：

| terminal        | Header                           | 注解                                                                                    |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| done            | ✅ Claude · 已完成               | subtype、无内容提示                                                                     |
| error           | ⚠️ Claude · 出错                 | 错误摘要                                                                                |
| interrupted     | ⏹ Claude · 已中断                | 已被用户终止                                                                            |
| idle_timeout    | ⏱ Claude · 已超时                | 空闲分钟数                                                                              |
| finalizing      | ⏳ Claude · 完成中               | 非终态；**保留** ⏹ 终止按钮                                                             |
| goal_continuing | ⏳ Claude · 本轮结束（目标继续） | 本轮 turn 已结束，但会话 goal 仍 active：任务没完成，宿主会自动起下一轮；不渲染 Compact |

终态不渲染 footer 和停止按钮（`finalizing` 除外，详见上表）。

### 5.1 goal 视图（DSH）

同一个 DSH 会话可以带一个长期目标（`goal` 投影：objective / phase / roundsStarted /
maxGoalRounds）。goal 是**跨 turn** 的自动续跑单元：`turn/end` 之后 12 ms 内
`goal-round-driver` 就可能起下一轮。因此：

- 运行中卡片在状态行下方渲染 `🎯 **目标进行中** · 第 r/N 轮` + 目标摘要（长目标进折叠面板）；
- 收尾时若 goal 仍 `active`，终态是 `goal_continuing`（标题「本轮结束（目标继续）」），
  summary 首行写「本轮结束 · 目标仍在继续」，绝不出现「已完成」；
- goal 仍 active 时不渲染 Compact 按钮（DSH 手动压缩要求 agent 空闲，点了必被拒）；
- goal 的 `complete` / `paused` / `blocked` 都是"不会自动续跑"，按普通终态收尾（blocked 显示阻断原因）。

数据来源只有宿主（`session/projections` 的 `goal` 值 + `session/control` 推送 +
`goal/change` 事件），桥不自行推断"任务结束"。

## 6. 长内容预算

最终回答优先于进度信息。终态渲染时：

1. 先放状态、审批和操作按钮；
2. 再放完整 `finalAnswer`；
3. 有剩余空间才从新到旧回填工具、计划、思考和通知；
4. 放不下时先省略 summary，再进入溢出通道。

Codex app-server 直接消费 `agentMessage.phase = "final_answer"`。没有协议标记的
agent 在 `result` 或终态收尾时把最后一条非空 assistant text 提升为最终回答，
因此 Claude、opencode、Kimi、Pi 和 DSH 共用同一套保护。

状态层仍对普通进度内容限制内存增长，渲染层再按 UTF-8 字节截断：

- reasoning 保留有限窗口；
- 普通 text 保留最新窗口；`finalAnswer` 不受该窗口和 `MAX_BLOCKS` 淘汰；
- tool input/output 截断；
- block 总数有上限；
- 工具块总数有上限（`MAX_BLOCKS`）；每个工具是原生折叠面板（默认一行标题），正文随卡下发并按工具数量截断；
- 整卡目标小于 28KB，测试要求小于 30KB。

预算使用 `Buffer.byteLength(..., 'utf8')`，不能使用 JavaScript 字符串 `.length` 代替。

单张卡片连“最终回答 + 必要控件”都放不下时，原卡显示
`_最终回答较长，完整内容已随后发送_`。Bridge 将完整回答按 UTF-8 字节和换行
边界拆成多条纯文本消息；拼接后必须与原文逐字一致，不能静默截断。

## 7. 并发与停止控制

普通消息和普通 cardAction 继续进入 `Bridge.enqueue` 的 Promise 链，保证最多一个 Claude
run。

停止控制不能进入该 queue，否则会等当前 run 完成后才执行。入口规则：

- exact `/stop` 直接调用 `interruptCurrentRun()`；
- stop cardAction 必须携带 runId；
- Bridge 校验 userId、chatId、runId；
- 旧卡片、其他用户或其他 chat 不能中断当前 run；
- finish 和 runner.stop 都允许重复调用。

成功中断不额外发送确认文本，原卡片的 interrupted 终态就是唯一反馈。

## 8. 错误与降级

### initial 发送前失败

继续消费 Claude 事件，运行结束后发送一张静态终态卡片。

### initial 已发送后失败

优先调用 `updateCard(messageId, finalCard)` 定型原卡片。只有原消息也无法更新时，才允许
发送第二张兜底卡片。

### 防止永久阻塞

- controller ready 有 5 秒启动等待上限；
- stream 完成有 5 秒 settle 等待上限；
- Claude 无 AgentEvent 默认 15 分钟触发 idle watchdog（`IDLE_TIMEOUT_MS = 15 * 60 * 1000`）；
- 所有 Promise rejection 都被观察并写日志。

严格单卡只承诺正常 stream 路径；故障路径遵循“优先原地定型”。

## 9. 配置语义

- thinking / tool_use / tool_result 恒常渲染（原 `output.show*` 配置已移除，无显示开关）；
- `RunCardRenderOptions` 仅承载卡片级元信息（agentKind 标题、compactSupported 按钮门控）。

## 10. 自动化覆盖

`src/card/` 与 `src/bridge/` 下大量单测覆盖：

- success/error result、非零退出、缺少 result；
- mixed content、tool result、所有终态（done/error/interrupted/idle_timeout/finalizing）与幂等；
- CardKit 2.0、runId、工具折叠、中文/emoji UTF-8 字节预算；
- stream 生命周期、启动/settle 超时、initial 前后失败降级；
- work queue、stop control lane、身份校验与 idle watchdog；
- 正常路径单卡且无结束分隔线；
- throttle patch detach rejection 的 unhandledRejection 兜底。

跑测试：`bun test`；类型检查：`bun run typecheck`。

## 11. 飞书联调

真实飞书环境验收点（已上线，常规迭代维护）：

- CardKit 2.0 initial + patch；
- stop action 回调（绑 `runId`）；
- done/error/interrupted/idle_timeout/finalizing 客户端表现；
- 中文、emoji、大量工具和超长正文；
- 卡片 schema、限流（99991400）及最终定型。

外部聊天权限错误（230027）等 4xx 飞书业务错误被 `classifyRejection` 判 recoverable，只记日志不退出进程。
