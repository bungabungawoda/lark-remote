 [English](../../en/architecture/design.md) | 简体中文

 # lark-remote 设计文档

把飞书私聊消息桥接到本地 Claude Code CLI。用户发消息或 `/命令`，程序把消息
传给 `claude` 进程，读取 JSONL 输出，把 thinking / text / tool 摘要实时更新到同一张
飞书卡片。所有飞书
I/O 由程序完成，不修改 Claude 的 system prompt，只支持 p2p 私聊，单用户。

---

## 1. 先决条件

**飞书自建应用**：开启机器人能力，订阅 `im.message.receive_v1` 和
`card.action.trigger` 事件，订阅方式选"长连接"（WebSocket，无需公网地址）。
权限至少需要 `im:message`。

**Claude Code CLI**：本地安装并在终端完成一次登录（`claude` → 浏览器 OAuth）。
bridge 不处理 OAuth，首次未登录会导致 claude 进程挂起。

**Tech stack**：Node.js 20+，TypeScript，`@larksuite/channel`（飞书 WebSocket 长连接 + 消息/卡片 API），
`axios`（文件上传/发送等直连 `open-apis/im/v1/*` REST 调用），`zod` + `yaml`（配置）。

---

## 2. 架构

```
飞书服务器
    │ WebSocket（@larksuite/channel SDK）
    ▼
InstanceLock             同一 configDir 只允许一个 bridge 主进程
    │
FeishuConnector          接收 p2p message + cardAction，发送/更新卡片/文件
    │
StartupContact           记录最近私聊；连接成功后发送含启动时间和 pid 的通知
    │
Bridge                   普通 work queue + stop control lane；非命令消息 → forwardToClaude
    │                       getRunner() 走 AgentRegistry，sendCompletionNotificationCard 走 SessionReaderRegistry
CommandRouter            /开头 → 内置 handler；否则委托 bridge.forwardToClaude
    │                       session 读取走 SessionReaderRegistry（非直接 claude/sessions import）
    │
ClaudeRunner             长驻交互会话（ClaudeSession），stream-json 双向通道，
                         control_request → ApprovalCoordinator → 审批区，yield AgentEvent
    │
RunCardSession           RunState reduce → CardKit 2.0 render → 原消息 patch
    │
FeishuConnector.streamCard() / updateCard()
```

---

## 3. Claude 进程调用（长驻交互模式）

ClaudeRunner 从「一次一跑」（`claude -p`）升级为**长驻交互会话**：一个 workspace
一个长驻进程，stdout 是 stream-json 事件流，stdin 是双向 JSON 控制通道
（`--input-format stream-json`）。每次用户消息 = 写一条 `user` 事件 + 消费事件
直到本 turn 的 `result`；进程在 turn 之间保持存活，被 `/stop`、`/new`、`/cd`、
会话级空闲回收（`claude.idleTtlMinutes`，默认 30 分钟）或 bridge 退出时经
`ProcessStopper` 组杀，下条消息按 SessionStore 的 sessionId `--resume` 恢复。
进程编排（pid 文件、killOrphan 身份校验、心跳、退出分发）由 `ClaudeSession`
继承 `SpawningRunner` 复用；`ClaudeRunner` 是 workspace-lifetime 薄包装。

```bash
claude \
  --output-format stream-json \
  --input-format stream-json \
  --permission-prompt-tool stdio \
  --replay-user-messages \
  --verbose \
  [--permission-mode <default|acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>] \
  [--resume <session_id>] \
  [--model <model>] \
  [--settings <settings_json_path>]
```

- `--verbose`：**必须加**，否则 JSONL 里不含 `thinking` 块
- `--permission-prompt-tool stdio`：把权限检查以 `control_request`（subtype
  `can_use_tool`）发到 stdout、从 stdin 收 `control_response`——这是
  实测的成熟路径（Claude Code SDK 内部隐藏参数，`claude --help`
  不显示；`stdio` 是保留值，其他值会被当作 MCP 工具名调用）
- `--replay-user-messages`：把用户消息回显到 stdout（`isReplay`），协议层据此
  确认消息已被接收
- `--permission-mode`：默认 `bypassPermissions`（无审批卡，行为与旧版一致）；
  配置为其他值后激活交互式审批
- `--settings`：可选，指定 Claude 配置文件（由 CLI 参数 `--settings` 传入，或自动从 `CLAUDE_SETTINGS_PATH` 环境变量 / `~/.claude/settings.json` 检测）
- `cwd`：通过 spawn 的 `cwd` 选项传入，不写进 prompt

**交互式审批链路**：`control_request`（工具调用/AskUserQuestion）→ runner 翻译
为 `approval_requested` → bridge `ApprovalCoordinator` → run 卡底部审批区
（允许 / 拒绝 / 允许所有；AskUserQuestion 为选项卡片）→ 用户决策 →
`control_response` 回写。审批等待期间暂停桥级空闲看门狗；`claude.approvalTimeoutMs`
（默认 5 分钟）超时自动发 cancel（deny + 中断 turn），终态显示「审批超时未响应，
已自动取消」。

**result 事件语义**：subtype 为 `compact`/`compaction` 是 turn 中途压缩（不是
结束），其余 subtype 才是 turn 终态；`--resume` 会先重放上一轮旧 result（早于
`system/init`），协议层直接丢弃。真实 claude 实测：长驻模式下 result 之后不会
再有 stdout 事件（后台任务完成是静默的），因此 result = run 卡终态，无需像
旧 `-p` 流程那样等进程退出（2026-08-16 实测）。

**JSONL 事件类型（每行一个 JSON）：**

```
{ type:'system',    subtype:'init',    session_id, cwd, model }
{ type:'assistant', message:{ content:[
    { type:'thinking', thinking:'...' },
    { type:'text',     text:'...' },
    { type:'tool_use', id, name, input }
  ]}}
{ type:'user',      message:{ content:[
    { type:'tool_result', tool_use_id, content, is_error }
  ]}}
{ type:'result',    subtype:'success'|'error', session_id, usage, total_cost_usd }
```

一次运行中 assistant → user（tool_result）→ assistant 可循环多轮。

---

## 4. Session 管理

内存 Map，key 为 userId（open_id）：

```typescript
interface SessionEntry {
  sessions: Map<AgentKind, string>;        // 每 agent 一个 sessionId
  previousSessions: Map<AgentKind, string>; // 切走时停放的 session（/config 切 agent 后可恢复）
  arrivalSessions: Map<AgentKind, string>;  // 到达基线：上次切到该 agent 时用户拿到的 sessionId
  sessionCwds: Map<AgentKind, string>;      // 会话实际目录（system.init 的 event.cwd，仅 claude 可能与 cwd 不同）
  cwd: string;                              // 受控工作目录（realpath）
}
const sessions = new Map<string, SessionEntry>();
```

- `system.init` 到达时只同步 `sessionId` 和 `sessionCwds[agent]`（会话实际目录），`cwd`（受控工作目录）保持 bridge 启动 Claude 时传入值，**永不被 `event.cwd` 覆盖**；Claude 回报 cwd 不一致（如 `EnterWorktree` relocate 后 resume）只记 INFO，`/s` 按差异展示「会话目录」
- 下次发消息带 `--resume sessionId`
- `/new` 只清空 `sessionId` + `sessionCwds`，保留当前 `cwd`
- `/cd` 和 `/ws use` 时**必须清空 sessionId**（见坑 §9.1）
- `/config` 切 defaultAgent 时：旧 agent 的 sessionId 存入 `previousSessions`（停车位），新 agent 从 `arrivalSessions` 恢复上次到达基线；切回时可恢复停车位
- 持久化 `<configDir>/last-session.json` 保存全部 5 个字段，任一缺失视为损坏跳过；bridge 重启恢复 cwd + 上次使用的 sessionId

---

## 5. 命令列表

| 命令 | 行为 |
|------|------|
| `/new` | 清 session（保留 cwd） |
| `/cd <path>` | 切换 cwd，清 session |
| `/ls [dir]` | 弹出目录/文件卡片；点击目录切换，点击 30MB 内文件发送到飞书；>30 条分页 |
| `/ws save/use/remove` | 命名目录别名管理（`/ws` 默认 list） |
| `/resume [list\|id]` | 列出/切换当前 agent 的 session（`/resume [agent] [N]` 双参数，N clamp [1,5] 作为页大小）；列表分页（`resume.page` 回调翻页） |
| `/active` | 列出本进程内存中正在进行中的任务（Agent + Bash） |
| `/status` | 显示 cwd、session_id、model、进程状态 |
| `/stop` | SIGTERM 立刻 SIGKILL（不等 grace） |
| `/ps` | 是否有进程在跑 |
| `/help` | 命令列表 |
| `/exit` | 退出 bridge |
| `/reconnect` | 重连 WebSocket |
| `/restart` | 原地自重启 bridge：spawn detached 继任者 → 旧进程释放单例锁退出 |
| `/config get\|set` | 查改运行时配置（卡片交互，agent-aware 字段） |
| `/order save\|list` | 保存或列出常用指令；>15 条分页（`order.page` 原地翻页，受飞书单卡 60 个 body 元素上限约束） |
| `!<cmd>` | 执行 bash 命令并流式输出到卡片（绕过串行队列） |

---

## 6. 卡片交互

### 6.1 `/ls` 卡片构造（CardKit 2.0）

使用 **CardKit 2.0** 格式——交互组件直接挂 `body.elements`，回调用
`behaviors:[{type:"callback", value:{cmd,key}}]`，channel SDK 从
`action.formValue`/`action.option` 读取，无需 `includeRawEvent`。

```json
{
  "schema": "2.0",
  "header": { "title": { "tag": "plain_text", "content": "📂 /path/to/cwd" } },
  "body": {
    "elements": [
      { "tag": "div", "text": { "tag": "lark_md", "content": "`/path/to/cwd`\n共 N 个子目录" } },
      { "tag": "hr" },
      { "tag": "div", "text": { "tag": "lark_md", "content": "**A**" } },
      {
        "tag": "button",
        "text": { "tag": "plain_text", "content": "apple" },
        "type": "default",
        "behaviors": [{ "type": "callback", "value": { "cmd": "ls.switch", "path": "/absolute/path/to/apple" } }]
      }
    ]
  }
}
```

子目录和文件按首字符分桶（A-Z / `0-9` / `#`），每个桶前一个 lark_md 标题，桶内每个按钮直接平铺在 `body.elements`（禁止包 `action` 容器，否则触发 200861）。浏览子目录按钮使用 `{ cmd: "ls.browse" }`（浏览不切 cwd，原地刷新卡片），"切换"按钮使用 `{ cmd: "ls.switch" }`（存在性校验后切 cwd），文件按钮使用 `{ cmd: "ls.file" }`。点击文件时，router 先校验目标存在、是文件且不超过 30MB，再由 connector 上传并发送到当前飞书私聊。普通文件上传到 `im/v1/files` 时 `file_type` 使用 `stream`，发送 `im/v1/messages` 时 `receive_id_type` 使用 `chat_id`。

### 6.2 cardAction 事件处理

收到卡片点击后，从 `action.action.value` 取 payload：

```typescript
channel.on('cardAction', async (action) => {
  const value = action.action.value as { cmd: string; path?: string; name?: string; sessionId?: string };
  if (value.cmd === 'ls.switch') {
    // 安全校验后切换 cwd
  } else if (value.cmd === 'ls.browse') {
    // 浏览目录（不切 cwd，原地刷新卡片）
  } else if (value.cmd === 'ws.use') {
    // 执行 /ws use <name>
  } else if (value.cmd === 'resume.use') {
    // 执行 /resume <sessionId>
  } else if (value.cmd === 'resume.page') {
    // /resume 列表翻页（value: { agent, offset, pageSize }，原地 updateCardInPlace）
  }
});
```

### 6.3 CardKit 2.0 唯一标准

本项目卡片全面采用 CardKit 2.0（已无 1.x 代码路径）。2.0 卡片约束：
- 交互组件（button/select_static/input）**直接挂 body.elements**，禁止包 `action` 容器
- 回调统一用 `behaviors:[{type:"callback",value:{cmd,key}}]`
- 流式输出不需要 tabs，内容直接 inline 排列
- SDK 0.3.0+ 从 `action.action.value` 读 payload，select 项在 `action.option`、input 值在 `action.formValue`（input 提交图标的 `input_value` 需 `includeRawEvent: true` 从 `action.raw.action.input_value` 读）

### 6.4 `/ws` 卡片

使用 CardKit 2.0，每个别名两个按钮；列表按 `WS_PAGE_SIZE`（15 条/页）分页，
超过一页时底部显示分页栏（`ws.page` 原地刷新）。每行 3 个 body 元素
（div + column_set + hr），15 行 + 头部 + 分页栏 = 48 个元素，低于飞书单卡
`body.elements` 60 个上限（ErrCode 11310 "element exceeds the limit"）；
删除按钮携带 `offset`，刷新后停留在原页。

```json
{ "cmd": "ws.use",    "name": "proj-a" }
{ "cmd": "ws.remove", "name": "proj-a", "offset": 0 }
{ "cmd": "ws.page",   "offset": 15 }
```

### 6.5 Claude 运行卡片

每次 Claude run 正常路径只创建一张 CardKit 2.0 卡片。`channel.stream` 先发送 initial
卡片，随后通过 `message_id` 全卡 patch。运行中显示 thinking、正文、工具摘要、状态行和
停止按钮；终态切换 header，移除状态行和按钮。

停止按钮 payload 为 `{ "cmd": "stop", "runId": "<uuid>" }`。入口必须校验
`runId + operator.openId + chatId`，并绕过普通 work queue，否则 stop 会排在当前 run
结束后而无法中断。

---

## 7. 输出格式化

Claude 对话输出由 `RunState` 和 `renderRunCard` 构造成 CardKit 2.0 卡片：

- thinking、text、tool use/result 按 JSONL 顺序 reduce，并保留事件 `timestamp`；
- live `stream-json` 事件缺 timestamp 时，`createJSONLStream` 以事件到达时间补齐；
- 卡片时间戳统一按本地时间 `YYYY-MM-DD HH:mm` 展示；
- `showThinking`、`showToolUse`、`showToolResult` 继续控制可见内容；
- 长内容使用滚动窗口、截断、工具折叠、`collapsible_panel` 视觉折叠和 UTF-8 字节预算；
- 卡片是有损进度摘要，当前不持久化完整 transcript；
- SDK 对 patch 使用 throttle 和 FIFO UpdateQueue；
- result.success / result.error → finalizing（非终态，CLI 仍在等后台任务）；
  CLI 进程退出后由 bridge finally 块 transition 到 done/error；非零退出或无 result 耗尽 → error；
- 正常路径不再发送多条 markdown/text，也不再发送结束分隔线。

---

## 8. 配置

```yaml
feishu:
  appId: cli_xxx
  appSecret: xxx

# 默认 agent 展示顺序（/config 卡片）：codex → claude → opencode → pi → kimi；
# 未安装（CLI 不在 PATH）的 agent 排到后面。defaultAgent 决定 bridge spawn
# 哪个 agent、run 卡片 header 显示哪个 agent 名
defaultAgent: claude

claude:
  model: claude-opus-4-8
  effort: medium           # low | medium | high | xhigh | max
  permissionMode: bypassPermissions  # Claude 官方 --permission-mode：default | acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
  approvalTimeoutMs: 300000          # 审批超时（ms），默认 5 分钟，勿随意改短
  idleTtlMinutes: 30                 # 会话级空闲回收（分钟），0=禁用
  stopGraceMs: 5000

agents:
  codex:
    approvalPolicy: on-request  # Codex 官方 AskForApproval：untrusted | on-request | never（默认 on-request）
    sandbox: workspace-write   # Codex 官方 SandboxMode：read-only | workspace-write | danger-full-access（默认 workspace-write）
    appServer:                # app-server 连接参数
      binary: codex
      requestTimeoutMs: 60000
      idleTtlMs: 1800000
      turnIdleTimeoutMinutes: 10
  kimi:
    permissionMode: manual     # manual | auto | yolo（纯 ACP 模式，kimi acp 持久连接，支持审批 + compact）
    acp:                       # acp 连接参数
      binary: kimi
      requestTimeoutMs: 60000
      idleTtlMs: 1800000
      turnIdleTimeoutMinutes: 10

output:
  showThinking: true
  showToolUse: true
  showToolResult: true

logging:
  level: info             # debug | info | warn | error

idle:
  watchdogMinutes: 15     # 0 关闭空闲看门狗
```

首次启动检测不到 `feishu.appId`/`appSecret` 时：交互式终端（stdin/stdout 均 TTY）
走扫码创建向导（`src/config/wizard.ts`，调用 `@larksuite/channel` 的 `registerApp`），
终端打印二维码，用户用飞书 App 扫码创建应用，返回的 `client_id`/`client_secret`
写回配置文件后继续启动；非交互环境（无 TTY）落到 `loadConfig` 生成模板并退出。

`codex.appServer` 与审批/沙箱字段的完整语义见
[`docs/zh/guides/codex-config.md`](../guides/codex-config.md)。
`kimi` 的 permissionMode/acp 字段完整语义见
[`docs/zh/usage.md`](../usage.md)（kimi 为纯 ACP 模式，已无 cli/acp 切换）。

---

## 9. 已知坑点

### 9.1 `/cd` 必须清空 session_id

`claude --resume <session_id>` 恢复的是 Claude 记忆中的上下文（含旧 cwd）。
如果 `/cd` 后不清 session_id，Claude 记忆里的目录和实际 spawn cwd 不一致，
文件读写会错乱。`/cd` 和 `/ws use` 都必须清空 session_id。

`/cd` 路径解析必须先展开 `~`：`path.resolve` 不识别 `~`，直接传 `~/projects` 会被
当相对路径拼成 `<bridge process.cwd()>/~/projects`（如 `/Users/.../lark-remote/~/projects`）。
`cmdCd` 用 `path.join(os.homedir(), target.slice(1))` 预处理 `~` 开头的输入。

### 9.2 `--verbose` 缺失导致无 thinking 输出

`--output-format stream-json` 默认不输出 thinking 块，必须同时加 `--verbose`。
且模型需支持 extended thinking（`claude-haiku-4-5` 无 thinking）。

### 9.3 claude 首次运行需 OAuth

`claude`（print/交互模式）未登录时触发交互式浏览器 OAuth，非 TTY 下进程挂起或报错退出。
bridge 无法代替这一步——首次启动若发现 OAuth 未完成，会在日志中记录并由用户去终端手动 `claude` 完成登录。

### 9.4 JSONL 末行可能无换行符

claude 异常退出时 stdout 最后一块数据可能无尾部 `\n`，`readline` 会丢弃该行。
用手动 buffer 处理：`data` 事件里按 `\n` 切分，最后一段存 `partialLine`，
在 `stdout 'close'` 时手动 flush。

### 9.5 飞书限流（错误码 99991400）

新消息发送约 5 req/s。`sendWithRetry` 对可重试错误 sleep 200ms 后重试一次：SDK 的
`rate_limited`（HTTP 429，SDK 已内置退避重试，此处仅作兜底），以及飞书业务码
99991400/99991401（频率控制）——后者被 `@larksuite/channel@0.3.0` 的 `classifyError`
归类为 `permission_denied` 且 SDK 对 `permission_denied` fail-fast，必须由
`shouldRetrySendError` 从 `cause` 链（`cause.response.data.code`）识别才不至于让
限流重试路径死掉。普通 `permission_denied`（如缺 scope）不重试。
run 卡片 patch 由 channel SDK 的 throttle + FIFO UpdateQueue 控制；默认关闭
tool use/result 展示可进一步减小卡片更新量。

### 9.6 消息串行处理

并发处理多条消息会导致多个 claude 进程竞争 session、飞书回复乱序。
`Bridge.enqueue` 用 Promise 链保证普通消息和普通 cardAction 串行：

```typescript
// src/bridge/index.ts
enqueue(task: () => Promise<void>): void {
  this.queue = this.queue
    .then(() => task())
    .catch((err) => getLogger().error('[bridge] queue task error:', err));
}
```

`/stop` 和 stop cardAction 是控制操作，必须绕过该 Promise 链，直接调用
`Bridge.interruptCurrentRun()`。active run 保存 runId/userId/chatId，防止旧卡片或其他
会话终止当前 run。

**lane 与执行 cwd 同源**：lane 键按入队时
`sessionStore` cwd 划分，而 `/cd`、`/ws use`、`ls.switch` 等斜杠命令绕过队列立即
改写 cwd。若执行时 `forwardToClaude` 重新 `resolveCwd`，会出现两条并行 lane 都
resolve 到新 cwd 的竞态——先到者占 `activeRuns`，后到者 busy-drop，排队消息静默
丢失。修复：`index.ts` 入队闭包把入队时 `workspace` 作为 `cwdOverride` 显式传给
`router.handle` → `bridge.forwardToClaude`，执行时以 lane 为准（空串回退
`resolveCwd`）。`finalizeRun` 的清理（`activeRuns.delete` + runner slot 回收）在
`try/finally` 的 finally 中执行（review）：finalize 期 `renderRunCard`
抛错也不得留下永久 busy 的 workspace。

**第六批 P1 语义**：
- 完成通知卡：`sendCompletionNotificationCard` 读会话内容带
  `maxEvents: 5`，发送走 `sendResult`（`enforceCardBudget` 兜底），不再直连
  connector——长会话卡片不会再超 28KB 被飞书静默拒绝。
- bash `!` 进程：`BashProcessRunner` 在进程存活期注册到进程级 exit
  分发器（与 5 个 agent runner 同源），`/restart`/SIGTERM 时组杀 bash 及其子
  进程，run() 结束注销——`!sleep 3600` 不再孤儿化。
- 缓存：session 读取缓存统一「TTL 用缓存写入时间 + 有界
  LRU/FIFO」。

### 9.7 `/ls` 切换目标：与浏览对齐，不做子树限制

`ls.switch`（切换 cwd）与 `ls.browse`/`ls.file` 对齐，只校验"目标存在且是目录"，
不再要求目标是 cwd 的**任意深度后代**或**上级目录**。原因：

1. **同族 handler 已具备同等能力**：`ls.browse` 可浏览任意目录、`ls.file` 可上传任意
   ≤30MB 文件。能通过 owner 认证的攻击者不需要 `ls.switch` 也能达成同等/更大危害。
2. **真实边界是 owner 认证**（`src/binder.ts`）：消息与卡片回调都以单一 owner
   openId 强校验（`src/index.ts` 的 `isOwner(operator.openId)`），子树校验是冗余纵深。

```typescript
// handleLsSwitch 的校验逻辑（src/router/index.ts）：
const resolvedTarget = path.resolve(targetPath);
if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
  return `路径无效: ${resolvedTarget}`;
}
const canonical = fs.realpathSync(resolvedTarget); // cwd 以 canonical 形式入库
this.sessionStore.setCwd(ctx.userId, canonical);
```

> 注：原 `isParentDir` + realpath 前缀匹配校验（只允许任意深度后代 + 直接父级）已删除，
> `isParentDir` 函数同步移除。残余风险（cwd 可切到任意目录）由 `binder` owner 认证兜底。

### 9.8 飞书重复推送与 cardAction 去重

飞书 WebSocket 是 at-least-once 投递，同一事件可能推送多次。SDK
`@larksuite/channel` 的 `safety.dedup`（`SeenCache`：内存 LRU + 可注入长期 cache）
负责去重：`pushMessage` 用 `msg.messageId`、`pushAction` 用
`card:{messageId}:{operator.openId}:{actionId}` 作为 seenCache key，TTL 内重复到达
直接丢弃。项目在 `src/connector/index.ts` 配置 `dedup.ttl = DEDUP_TTL_MS`（300ms）。

**cardAction dedup 的设计缺陷**：`actionId = tag|name|option|JSON.stringify(value)`，
**不含时间戳/事件序号/messageId**。同一用户在同一张卡上点同一个按钮，eventId 三段
全相同 → 第二次点击被 seenCache 当重复丢弃，handler 不执行。

**原地更新卡片的高危场景**：`updateCardInPlace` 不发新卡，用户始终在同一张卡上操作。
config 卡片的 toggle 按钮（`{cmd:'config.toggle', key: field.key}`）callback value 固定，
用户连点两次（如"显示工具结果" on→off→on）时：
- 第一次：eventId 不在缓存 → toggle 生效 → 卡片变"已关闭" → finally 把 eventId 加入 seenCache
- 第二次（TTL 内）：eventId 已在缓存 → **drop duplicate action** → toggle 没执行 → 卡片卡在"已关闭"

`configActionQueue`（`src/router/index.ts`）的串行化救不了——被 drop 的事件根本没到 router。

**方案：调小 `DEDUP_TTL_MS`**（SDK 不支持 per-event-type 配置，ttl 全局作用于 message +
cardAction）。300ms 挡飞书瞬时重投递（<100ms 级），放过用户连击（慢点两次通常 >500ms）。
代价：削弱 message 秒级重投递防护——但飞书 WS 正常连接不重发，重连补发延迟常 >60s 本
就挡不住，串行队列（§9.6）兜底防并发，影响可接受。SDK 默认 12h、项目曾用 60s 都会误伤连击。

**原地更新逻辑的去重风险分类**（新增原地更新按钮时参考，统一用方案 1 即小 ttl 窗口去重）：

| callback value | 风险 | 说明 |
|----------------|------|------|
| 固定（`config.toggle`/`config.set`/`config.input`/`config.save`/`new-session`） | **高危** | 连击第二次被 drop 会卡死状态且 TTL 内无法恢复；靠 `DEDUP_TTL_MS` 小窗口放过 |
| 含动态字段（`stop`→runId、`queue.*`→messageId、`resume.use`→sessionId、`*.cd`→path、`ws.*`→name、`order.*`→orderId） | 低危 | 不同目标 actionId 不同天然安全；同目标连击第二次 drop 属幂等无害 |

**新增原地更新按钮的准则**：
1. callback value 尽量带动态字段（runId/path/sessionId 等），让不同操作的 actionId 天然不同；
2. 固定 value 的 toggle 类按钮（必然存在），不要把 `DEDUP_TTL_MS` 调大（>500ms 即可能误伤慢点）；
3. 连击需幂等的按钮（如 `order.exec`）即便方案 1 让连击通过，也由串行队列/runId 校验兜底，无破坏。

**无法在 stub connector 测试中复现**：测试直接调 `router.handleCardAction`，绕过 SDK safety
层；stub 不模拟 dedup。靠 `DEDUP_TTL_MS` 常量区间断言（`src/connector/dedup-config.test.ts`）
防回归 + 本节文档约束。

### 9.9 进程与单例

同一 `configDir` 只能同时运行一个 bridge 主进程。启动时 `InstanceLock` 读取 `<configDir>/lark-remote.pid`：若 pid 仍存活则拒绝启动，若 pid 已不存在则覆盖陈旧锁；进程退出时只清理属于当前 pid 的锁。

bridge 崩溃时 agent 子进程变孤儿。启动时读 `<configDir>/<agent>-*.pid`（按 workspace
隔离，P1-9），先做进程身份校验（`ps -o command=` 匹配 binary，防 pid 复用误杀，
P1-10）再对整个进程组发 SIGTERM；bridge 退出时（`process.on('exit'|'SIGINT'|'SIGTERM')`）
对进程组做 SIGTERM+SIGKILL 清理并删 pid 文件。

### 9.10 workspace.json 写入原子性

`/ws save` 写文件时进程崩溃可能产生截断 JSON。写临时文件再 `fs.rename`（原子操作）。
启动时 JSON 解析失败视为空 store，提示用户"配置损坏已重置"。

### 9.11 日志落盘与轮转

`src/logger/` 单例 `Logger`，**只写文件不写 stdout/stderr**。日志按本地日期
轮转（跨午夜自动换文件）：目录为 `<configDir>/logs/YYYY-MM-DD/`，文件名
`lark-remote-<pid>.log`（日期在目录名而非文件名中）。日志目录由 `configDir`
推导（`<configDir>/logs`），不可单独配置。级别由 `logging.level`
控制。同步写（`fs.appendFileSync`），日志量小，无需缓冲刷新。

`config/index.ts` 中 logger 初始化**之前**的致命错误（模板生成、校验失败）以及
`config/wizard.ts` 的扫码向导交互仍走 `console.*`（stderr/stdout），因为此时 logger
尚未就绪；其余模块一律用 `getLogger()`，不要新增 `console.*`。

### 9.12 claude 空闲看门狗

`Bridge.forwardToClaude` 在 `runner.run()` 的 `for await` 循环上挂一个 15 分钟空闲
计时器，每收到一个 AgentEvent 就重置。若 claude 进程长时间无 stdout 输出（典型
表现：进程挂起、不退出也不产事件），计时器触发 `runner.stop()` 并把原卡片定型为
idle_timeout。这避免单个卡死的 claude 永久阻塞 §9.6
的串行 queue，导致后续消息全部排队无法处理。常量 `IDLE_TIMEOUT_MS = 15min`
在 `src/bridge/index.ts` 顶部。窗口大小由 `config.idle.watchdogMinutes` 控制（默认 15，可在 `/config` 卡片的"⏱️ 空闲"tab 调整）；设 0
视为关闭（卡片仍会定型为 idle_timeout，但永远不触发）。

**与 `/stop` 的区别**：watchdog 触发时调 `runner.stop()`（无 `immediate`），仍走
stopGraceMs（默认 5s）等待期，礼貌收尾。`/stop` 走 `runner.stop({ immediate: true })`，
SIGTERM 发完立刻 SIGKILL，不等 grace——用户主动停永远不等。`stopGraceMs` 因此
**只服务于 watchdog 自动 finish 路径**，不再有用户命令控制它（`/timeout` 已删除）。

### 9.13 `/active` 与 `/resume` 的 session 状态判定

**新语义**：`/active` 不再扫描文件系统，只显示本 bridge 进程内存中的活跃任务。
通过 `Bridge.getActiveRuns()` 获取 Agent 任务，`Bridge.getActiveBashRuns()` 获取 Bash 命令。
只显示 `terminal` 为 `running` 或 `finalizing` 的任务，已完成（done/error/interrupted）的任务不显示。
`/resume` 和 `/cd` / `/ws use` 自动恢复卡片使用 `readSessionContent` 读取最后一个用户输入
之后的会话内容。后台任务状态优先合并当前 bridge 进程内 `Bridge.getActiveRunFor(cwd)` 的
内存 active run；只有当 `activeRun.sessionId === sessionId` 且 terminal 为
`finalizing` 时才复用内存状态。JSONL 作为 fallback：`result` 后尚无
`permission-mode`，或尾部出现 `system.away_summary`，都显示为完成中——但必须叠加
mtime 新鲜度校验（`STALE_MS = 1h`，与 `isSessionActive` 同源）：一个已停止写入 1 小时以上的
文件不可能来自仍在运行的进程。（任何已完成的普通 turn 都以
`result` 结束且没有 `permission-mode`，mtime gating 用来排除这类陈旧文件。卡片 `stop` 按钮在
`interruptCurrentRun` miss 时（runId 不匹配或已退出）经 `bridge.sendResult` 回复
"该任务已结束，无需终止"，不静默 return。

如果 jsonl 完全找不到 user 消息（极旧/损坏），fallback 到读整个文件而不是返回空卡片，
避免 `/resume use` 拿到 sessionId 后只显示"已设置 session_id"纯文本而不出历史卡。

**usage 数据源（contextLength / compactCount）**：run 卡片完成时（done/error/interrupted）
的 context 长度与压缩次数从 jsonl 读，不走 stream-json——Claude CLI 的 stream-json 不发
`compact_boundary` 事件（它只持久化到 jsonl：
`{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":N}}`），
且 `result` 事件无 context 长度字段。`Bridge.forwardToClaude` 的 finish 路径调
`resolveFinalUsage(sessionId, cwd)`，经 `sessionReaderRegistry` 调 `readSessionContent`
聚合所有 `compact_boundary` 事件，得 `compactCount = 事件计数`；`contextLength =
max(末次 compact 的 postTokens, 末轮完整 prompt input+output+cacheRead+cacheCreation)`
——postTokens 只在 compact 刚发生时准确，session 继续增长就过期；cache_read 是 prompt
主体，漏掉会严重低估。**不可累加所有 turn**（N turn 累加得 N×context 虚假巨值，
regression: 55 turn 累加 3,328,386，实际 79,816）。`totalInput/totalOutput`
仍累加，保留备用。
`/resume` 末尾的 context 长度同源（`readSessionContent` 共用 `aggregateSessionUsage`）。


`ClaudeRunner.run()` 路径探针（`src/runner/index.ts`）：
- `spawn pid=... binary=... cwd=... sessionId=...` —— spawn 成功
- `spawn failed: ...` —— `proc.once('error')` 拒绝
- `wrote pid file path=pid` —— pid 文件写入
- `sending SIGTERM to pid=...` / `cleaned pid file ...` —— stop 路径
- `non-zero exit code=N stderr=...` —— 异常退出

**spawn-stage heartbeat**（关键）：spawn 成功到第一行 stdout 之间的窗口
（约 30 秒，OAuth 弹窗未响应、stdio fd 错位、cwd 不可达）**不被 §9.12 idle
watchdog 覆盖**——watchdog 在 `for await (runner.run())` 循环里，要等
`runner.run` 第一次产出事件才会启动。spawn-stage heartbeat 在 spawn 后
**立即**启动 30 秒 timer（WARN `spawn stage stalled`），第一行 stdout 到达
即清除 timer。

**不自动 stop**：spawn-stage stall 常需用户介入（重登 OAuth 或检查 cwd），
自动 SIGTERM 让用户更困惑。检测到后让用户决定 `/stop` 或 `Ctrl+C` 重新登录。
这与 §9.12 idle watchdog 自动 stop 是不同策略——watchdog 覆盖的是 stream
已发出但不再推进的窗口，通常确实是孤儿进程。

`Bridge.forwardToClaude` 路径探针（`src/bridge/index.ts`）：
- `forward entry userId=... cwd=... sessionId=... message=...`
- `workspace busy, dropping message userId=... cwd=...` —— 第 2+ 条进队列前被丢弃
- `activeRuns.set cwd=... runId=...` / `activeRuns.delete cwd=... runId=...` —— 增删配对
- `cardSession.start() begin/ok runId=...` —— 卡片流启动
- `runner.run() begin runId=... message=...` —— 进入 spawn 阶段
- `system.init received runId=... sessionId=...` —— 拿到 session_id
- `result event received runId=...` —— `result` 事件到达（**非终态**，CLI 可能在等后台任务退出）
- `runner stream end runId=... sawResult=...` —— 流结束
- `finally settle runId=... state.terminal=...` —— finally 段

**关键不变量**：下次同类事件（队列阻塞、activeRun 卡住不复位、spawn hang），
`activeRuns.delete cwd=... runId=...` 必须被记录——这是从日志还原"是否清理
干净"的唯一锚点。如果该探针缺失，永久阻塞会无声发生。

测试覆盖：`src/bridge/bridge.test.ts` `Bridge.forwardToClaude logging probes`
组 + `src/runner/claude/claude-runner.test.ts` `ClaudeRunner logging probes` 组，
用 `vi.mock('../logger/index.js')` 替换 `getLogger` 返回 `vi.fn()`，断言
特定探针字符串被调用。重构 logger 调用时同步更新断言。

### 9.16 `/active` 内存实现

> ⚠️ **新语义**：以下内容已废弃旧的 jsonl 扫描方式。`/active` 现在只显示本 bridge 进程内存中的活跃任务。

**新实现**：`/active` 不再扫描 `~/.claude/projects/` 全部子目录。

- 数据来源：`Bridge.getActiveRuns()`（Agent 任务）+ `Bridge.getActiveBashRuns()`（Bash 命令）
- 判定逻辑：只包含 `terminal` 为 `running` 或 `finalizing` 的任务
- 优势：
  1. 确定性高：不受文件系统状态影响
  2. 语义清晰：用户只看"现在有什么在跑"
  3. 与 `/stop` 一致：都基于内存 runId
**`Bridge.enqueue` 防御性检查**：生产日志反复出现
`[bridge] queue task error: TypeError: task is not a function`，根因是非函数 task
溜进 Promise 链污染整条 workspace 队列。`enqueue` 入口加 `typeof task === 'function'`
守卫，非函数时 warn + 早退，不破坏后续任务推进。

### 9.17 卡片折叠（`collapsible_panel`）

所有卡片类型的次要信息用 CardKit `collapsible_panel` 包裹，构造工具在
`src/card/collapsible.ts`（`collapsiblePanel` / `collapsibleMarkdownPanel` /
`markdownDiv`）。router 侧共享工具在 `src/router/card-helpers.ts`
（`sessionEventPanel` / `formatTimestamp`）。

**关键约束**：折叠是**视觉隐藏**，JSON payload 仍含全部内容，28KB 字节预算
（§9.14 `CARD_BUDGET_BYTES`）仍需遵守。折叠减少的是视觉高度，不是序列化大小。

**Run card 折叠策略**（`src/card/run-renderer.ts` + `src/card/tool-render.ts`）：

| 内容 | 折叠行为 | 理由 |
|------|----------|------|
| Thinking | 运行中 `expanded:true`，完成后 `expanded:false` | 运行时关注进度，完成后是次要信息 |
| 运行中工具 | `expanded:true`，border 跟随状态（grey→red if error） | 用户需要看到实时执行 |
| 已完成工具（<3个） | `expanded:false` | 默认折叠，点击展开查看 |
| 连续工具组（≥3个） | 单个 collapsed panel，body 只含 header 列表 | 参考 `collapsedToolSummary` |
| 正文 text block | 不折叠，直接 markdown | Claude 的回复是主要信息 |
| 终态 footer / Stop 按钮 | 不折叠 | 状态摘要必须可见 |

**工具渲染改进**（`src/card/tool-render.ts`）：折叠后的 header 显示智能摘要
（`✅ **Bash** — pwd`、`✅ **Read** — /repo/a.ts`），并附加本地时间戳；而非无意义的 `Tool0`。
`toolHeaderText` 按工具类型提取关键字段；`toolBodyMd` 按类型结构化渲染
（Bash→command/output 代码块、Read→file_path、Grep→pattern/path）。
截断常量：`HEADER_SUMMARY_MAX=80`、`BODY_FIELD_MAX=600`、`OUTPUT_MAX=1200`、
`BODY_TOTAL_MAX=2500`。

**Session 内容卡片折叠**（auto-resume、`/resume <id>`）：每条 event 包在
`collapsible_panel` 中，最后 2 条默认展开（用户刚恢复需看最新内容），历史事件折叠。

**Dashboard 卡片折叠**（`/active`）：每个 session 包在 collapsed panel
中，切换目录按钮放 panel 外保持可操作。/active 已重写为内存 dashboard（`buildActiveCardFromMemory`），显示 bridge 进程内存中的活跃任务，单卡展示。

**`/ls` 折叠**：同字母分组 >5 个 entry 时，整组按钮包在 collapsed panel 中。

**流式更新限制**：Run card 通过全卡 patch 更新（`controller.update()`），每次
更新会重置 collapsible_panel 的 `expanded` 状态到默认值。运行中工具默认展开
（用户不需要手动操作），用户手动展开的已完成工具 panel 在下次事件到来时折叠
回去——可接受，因为新事件通常意味着上下文变化。**不引入增量 patch 或状态追踪**
来保持用户展开状态，复杂度不值得。

### 9.18 `!` bash 命令：绕过串行队列 + 单卡流式

`!` bash 命令不启动 claude、不碰 session 状态，串行队列的设计目的（禁止并发
claude）对它不适用。因此 `!` 在 `src/index.ts` 走 immediate 分发（同 slash 命令），
**不进 `Bridge.enqueue`**，可与同 workspace 的 claude run 并行。

**分发**（`src/index.ts`）：`/stop` → immediate；`/xxx` → immediate；`!xxx` →
immediate（router 调 `bridge.executeBash`）；其余 → `bridge.enqueue`（claude）。

**跟踪**（`src/bridge/index.ts`）：bash run 用独立的 `activeBashRuns: Map<runId,
{bashRunner, userId, chatId, cwd}>`，按 **runId** 索引（支持同 workspace 多个 `!`
并发），**不进** `activeRuns`（claude 专用，按 cwd 单条）。两者分离避免互相覆盖。
`isBusy`/`isBusyFor`/`getAllActiveRuns`/`getActiveRunFor` 只反映 `activeRuns`，
bash 不出现在诊断卡 / `/ps` 视图（但 `/active` 会显示 bash runs）。

**`/stop`**（`interruptCurrentRun`）：先遍历 `activeRuns`（claude，调
`getRunner(cwd).stop` + `session.finish`），再遍历 `activeBashRuns`（bash，调
`bashRunner.stop({ immediate: true })`）。bash 卡片是静态流式无 session.finish。
卡片 stop 按钮带 `runId`，按 userId/chatId/runId 精确匹配。

**单卡流式**（`src/card/bash-card-session.ts`）：`BashCardSession` 仿 `RunCardSession`，
通过 `connector.streamCard` 建一张卡，`update()` 推 stdout/stderr patch，`finish()`
转终态，`settle()` 等 stream 关闭 + `updateCard` fallback。**不要**用多张
`sendWithRetry`（会发成多张独立卡片）。bash 卡片 running 状态带「⏹ 终止」按钮，
终态无按钮（`src/card/bash-renderer.ts`）。

**死锁历史**：曾经 `!` 走 `enqueue → router → executeBash`，而 `executeBash` 又
复用 `this.queues` 二次排队 + `await taskDone`，形成自等待死锁（enqueue 的队列
promise 未 settle，executeBash 等 bashTask，bashTask 挂在该 promise 后）。修复
后 `executeBash` 直接 `await executeBashInternal`，不再碰 `this.queues`。

**SIGKILL 退出判断**（`src/runner/bash/runner.ts`）：`/stop` 用 SIGKILL 杀进程时
`exitCode` 保持 `null`、只有 `signalCode` 被设置。`run()` 的退出条件必须是
`proc.exitCode !== null || proc.signalCode !== null`，否则循环空转、`executeBash`
永不 resolve。

### 9.19 cardAction 分发原则：按操作语义分类，不按触发方式分类

**正确的心智模型**：**不产生 Claude 工作的操作，无论触发方式，都不应该进串行队列**。

串行队列（`Bridge.enqueue`）的存在目的是防止并发启动多个 Claude 进程（§9.6）。
一个操作是否需要排队，取决于它**是否会产生 Claude 工作**（即调用 `forwardToClaude`
spawn claude 进程），而不是它由 slash command 触发还是 cardAction 触发。

分类定义：

| 分类 | 含义 | 队列行为 |
|------|------|----------|
| **控制操作** | 不 spawn claude，只读写 session/workspace 状态 | 免排队（`enqueueImmediate` 或直接执行） |
| **工作操作** | spawn claude 进程或排队等待 spawn | 走串行队列（`enqueue`） |

现行实现：`isImmediateAction` 白名单（`src/router/index.ts`）按上述语义分类，控制操作
免排队，工作操作（`order.exec`、普通消息）走串行队列。

### 9.20 SDK throttle patch rejection detach 与 unhandledRejection 兜底

run 卡片流式 patch 走 SDK `@larksuite/channel` 的 throttle + FIFO `UpdateQueue`。
`Throttle.fireSoon` 用 `setTimeout(() => this.doFire())` 延迟触发，`doFire` 内
`(async () => { await this.fire(); })()` 创建一条 **detached Promise**——其 rejection
既不被 `RunCardSession.update()` 的 try-catch 捕获（`controller.update()` 调完
`throttle.note()` 立即 resolve，不等真正 patch），也不被 SDK 内部 await。patch 失败
（如飞书 230027「无权操作外部聊天」、卡片不存在、内容超限）时，该 rejection 冒泡到
`process.unhandledRejection`。

**兜底**：`src/index.ts` 的 unhandledRejection handler 调 `classifyRejection`
（`src/error-classification.ts`，纯函数便于单测）分类：

| 判定 | 条件 | 行为 |
|------|------|------|
| **recoverable** | 502/503/504/ETIMEDOUT/ECONNRESET；或飞书 4xx 业务错误（`status∈[400,500)` 且 `data.code` 为数字，如 230027/230025） | 只记日志，进程继续 |
| **fatal** | TypeError 等编程错误；HTTP 5xx；纯 HTTP 400 无飞书 code（非 SDK patch 路径的真错误） | release 锁 + `exit(1)` |

飞书 4xx 业务错误判 recoverable 的理由：只影响单张卡的某次 patch，不应拖垮整个 bridge；
后续 patch 仍可能成功。230027 曾被旧 handler 当
fatal 退出。

**重构提醒**：动 handler / `classifyRejection` 时保留 detach 逃逸回归测试
（`src/card/run-card-stream-error.test.ts` 的 `test_anchor_sdk_throttle_detach_rejection_escapes_session`：
模拟 `controller.update` 立即 resolve + `setTimeout` 异步 fire rejected patch，断言 rejection
冒泡到 `unhandledRejection`）与分类边界测试（`src/error-classification.test.ts`）。旧测试用
`controller.update: async () => { throw }` 同步抛出**无法复现 detach**——必须 `setTimeout`
异步 fire 才能模拟 SDK 的真实 detach 语义。

### 9.21 Token 统计统一口径（ccusage 对齐）

run 卡片 done 统计与 `/resume` 末尾统计共用 `formatUsageStats`（src/router/index.ts），
统一对齐 [ccusage](https://github.com/sirmalloc/ccusage) 的 token 语义。**核心不变量**：

- **`Total = max(totalTokens, input+output+cacheRead+cacheCreation)`**。不能退回
  `input+output`——会漏掉 cache（codex/opencode 的 cache_read 动辄占输入 90%+）。
  无 `totalTokens` 时 total = 分项和（claude JSONL 无显式 total，由 reader 算分项和）。
- **`input_tokens` 处处表示「未命中缓存的输入」**：codex 由
  `input_tokens − cached_input_tokens` 推导（`src/session/codex/rollout-reader.ts` 的 jsonl 兜底读取），
  pi/opencode/claude 的原值即非缓存。
- **codex `total_token_usage` 是会话累计、`last_token_usage` 才是单 turn 增量**
  ：done 卡"本 run"只能用 `last_token_usage`
  （缺失时 `total − prev_total` 推导）；累计用主线程文件最后一条
  `total_token_usage`。**不能**用"最后一个 `token_count` 事件的
  `total_token_usage` 代表末 turn"——那是累计值，resume 长会话下会把整个会话
  的历史消耗当成单次 run（实测虚高约 240 倍）。
- **cache 百分比**：`cacheRead/(input+cacheRead)`（input 已是未缓存值，不再减一次）。
- **Cache create 行**：`cacheCreationTokens`（pi 的 `cacheWrite`、opencode 的
  `tokens.cache.write`）；codex 永远 0。
- **Context 行与上限百分比**：`contextLimit` 仅 codex 提供
  （`token_count.info.model_context_window`，每 turn 上报，可与 `last_token_usage`
  同事件读取）。有 `contextLimit` 时 Context 行渲染 `Context - X (Y%)`，
  `Y = round(contextLength/contextLimit*100)`，不 clamp；缺省（其他 agent、旧数据、
  运行中）只显示绝对量。`contextLimit <= 0` 视为缺失（防除零）。app-server 模式
  同一数值由协议 `thread/tokenUsage/updated` 的 `tokenUsage.modelContextWindow`
  提供（v2 schema 与 last/total 平级），经 result event `context_limit` 透传，
  jsonl 无该字段时 live 值兜底。

**透传链路与 scope 统一**：result event usage → `Bridge` 提取 live 值
（claude 原生命名 `cache_read_input_tokens`/`cache_creation_input_tokens` 与统一命名
都兼容）；进程退出后 `resolveFinalUsage` 读 jsonl。**flow 字段（input/output/cache/
total）：live 有 input/output 时全部用 live（本 run scope），否则 jsonl 兜底**；
codex app-server 的 `turn.completed` 透传协议 `tokenUsage.last`（本 turn 增量，
live 口径），与 opencode 一致走 live 优先；`contextLength`/`compactCount` 保持 jsonl
优先（水位/历史计数）。同一张卡片禁止混 scope（曾出现 Input 是本 run、Cache/Total
是 session 累计，cache% 分子分母不同源）。
→ `FinishMeta` → `RunState` → `run-renderer` 传给 `formatUsageStats`。

**`/resume` 由各 session reader 填充**：claude `aggregateSessionUsage`（`totalTokens`
= 分项和）、pi `extractUsage`（`totalTokens = usage.totalTokens`）、opencode reader
（`cache.write`/`total`）、codex `readCodexRollout` 解析 `token_count`
事件（`raw = last_token_usage ?? subtract(total, prev_total)`，跟踪 `previousTotals`
做累计差）。改 token 展示时，四个 reader + `formatUsageStats` + bridge 五处要保持一致。

**contextLength**：claude/pi reader 用 `max(末次 compact 的
postTokens, 末轮完整 prompt input+output+cacheRead+cacheCreation)`——postTokens 随
session 增长过期（实测低估 85-95%），pi 不再用 compaction 前的 `tokensBefore`；
codex reader 用末 turn raw `input_tokens`（含 cache 的完整 prompt 大小）；bridge 实时
路径 fallback `totalTokens ?? (input+cacheRead+cacheCreation+output)`（input 已非缓存，
不能只用 `input+output`）。

### 9.22 `/resume` 列表分页

**起因**：codex `/resume` 列表曾显示任意 walk 子集（`listCodexRollouts` 收集到
`limit*2` 条就 break 再排序，APFS 哈希序下最新目录常被跳过），且总数显示截断后长度。

**reader 契约**（`AgentSessionReader.listSessions`，5 个 agent 统一）：

```ts
listSessions(cwd: string, opts?: { limit?: number; offset?: number }): {
  sessions: AgentSession[]; // mtime desc 排序后的 [offset, offset+limit) 切片
  total: number;            // cwd 精确匹配的全集大小（分页前）
};
```

- 必须先对**全集**按 mtime desc 建立全序再切片；任何建立全序前的提前终止都错（§1.4 第一性原理）。
- 负 offset 按 0 处理（5 reader 统一 `Math.max(0, offset)`，防静默空页）。
- `getNewestSession(cwd)` 内部 = `listSessions(cwd, { limit: 1 }).sessions[0] ?? null`。
- codex 的 `listCodexRollouts` 返回 `{ entries, total }`，基于 `getSessionIndex`
  （全量 walk + 首行 `session_meta` + stat mtime，5s TTL），只对页内文件全量解析。
- kimi 默认 limit 20，与其他 agent 对齐。

**router `/resume` 分页**：
- `RESUME_PAGE_SIZE = 5`；`/resume [agent] [N]` 的 N clamp `[1, 5]`，默认 5。
- 分页栏照搬 `/ls` 结构：`第 x/y 页 · 共 N 个会话` + `上一页`/`下一页` 按钮，
  仅 `total > pageSize` 时显示；N 为 reader 返回的真实总数。旧假提示
  `输入 /resume N 查看全部` 已删除。
- 新增回调 `resume.page`（value `{ cmd, agent, offset, pageSize }`）→ `handleResumePage`
  → `cmdResume(offset)` → `updateCardInPlace` 原地刷新；`resume.page` 是
  `isImmediateAction` 白名单成员（控制操作免排队）。缺 agent 字段回退 defaultAgent。
- offset clamp：`[0, 页对齐末页起点]`（末页起点 = `(ceil(total/pageSize)-1)*pageSize`，
  不是 `max(0, total-pageSize)`——后者会产生与分页栏不一致的滑窗，违反"翻页不错位"）。
  clamp 后**分页按钮的 value 必须用 clamp 后的 pageOffset 计算**（否则上一页按钮
  从越界页点击会再次 clamp 回末页，按钮假死，）。
- `pageSize` 经 handleResumePage 数值化 clamp `[1, RESUME_PAGE_SIZE]`，非法值不被当作 sessionId。
- 预算：每页 5 条 × 约 3 elements ≈ 15 elements（上限 200），字节远低于 28KB。
