[English](../en/usage.md) | 简体中文

# 使用指南

lark-remote 把飞书私聊变成 Claude Code CLI 的远程入口：在飞书里发消息，本地 Claude 在你指定的目录里读写文件、跑命令，回复原路送回飞书。

单用户、p2p 私聊，不修改 Claude 的 system prompt。

---

## 一、前置条件

1. **Node.js 20+**
2. **飞书自建应用**（二选一）
   - **推荐：扫码创建**——首次启动时若检测不到凭据且终端可交互，会弹出二维码，用飞书 App 扫码即可创建应用并自动写入凭据（见下「配置」）。
   - **手动创建**：在飞书开放平台建自建应用，开启「机器人」能力，订阅事件 `im.message.receive_v1`、`card.action.trigger`，订阅方式选「长连接」（WebSocket，无需公网地址），权限至少 `im:message`，再把 App ID / App Secret 填入配置文件。
3. **Claude Code CLI**
   - 本地安装
   - 在终端完成一次登录（运行 `claude` → 浏览器 OAuth）

---

## 二、安装

```bash
git clone <repo> lark-remote
cd lark-remote
bun install
bun run build
```

也可全局安装为命令行程序，之后直接运行 `lark-remote`：

```bash
bun install -g "$(pwd)"   # 相对路径 `.` 会被 bun 解析成空包名（unsafe name），必须绝对路径
lark-remote
```

---

## 三、配置

首次启动分两种情况：

- **交互式终端且无凭据**：进入扫码创建向导，终端打印二维码，用飞书 App 扫码完成应用创建，凭据自动写入配置文件后继续启动。无需手动去开放平台建应用。
- **非交互环境（如 CI、管道、已重定向 stdin）或已存在配置**：无凭据时自动在 `~/.lark-remote/config.yaml` 生成模板并退出，填写飞书凭据后重启。

完整配置文件字段：

```yaml
feishu:
  appId: cli_xxx            # 飞书应用 App ID
  appSecret: xxx            # 飞书应用 App Secret

# 默认 agent：claude | codex | opencode | pi | kimi，默认 claude
defaultAgent: claude

claude:
  model: claude-opus-4-8    # 模型
  effort: medium            # 推理强度 low | medium | high | xhigh | max
  # permissionMode 硬编码为 bypassPermissions（runner 内部），不通过 config 配置
  stopGraceMs: 5000         # 空闲超时自动停止时的优雅关闭宽限时间（毫秒）

output:
  showThinking: true        # 是否发送 thinking 块
  showToolUse: true         # 是否展示工具调用
  showToolResult: true      # 是否展示工具结果

logging:
  level: info               # debug | info | warn | error

idle:
  watchdogMinutes: 15       # 空闲超时自动停止，0 关闭
```

配置文件路径可用 `--config-dir` CLI 参数覆盖（如 `lark-remote --config-dir /path/to/dir`）。

> **不要把真实 config.yaml 提交进仓库。**

---

## 四、运行

```bash
bun run dev      # 开发（bun 直跑 TS）
lark-remote      # 全局安装后直接用
```

bridge 启动后不在终端输出，运行日志写入 `~/.lark-remote/logs/`（见下）。同一 `configDir` 只允许一个实例；重复启动会退出并提示已有 pid。连接飞书成功后，bridge 会向最近私聊用户发送启动通知，包含启动时间和进程号。

日志按日期轮转，落在 `~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log`（每天一个子目录，路径由 configDir 推导，级别由 `logging.level` 配置）。

---

## 五、命令

直接发非 `/` 开头的消息即转发给 Claude。以 `/` 开头走内置命令，**部分命令支持单字母别名**（`/help /h`、`/status /s`、`/stop /t`、`/exit /e`、`/resume /r`、`/config /c`、`/order /o`）：

| 命令 | 别名 | 行为 |
|------|------|------|
| `/help` | `/h` | 显示命令列表 |
| `/cd <path>` | - | 切换 Claude 工作目录（支持 `~`、绝对/相对路径，会清空当前会话，下次消息开新对话） |
| `/cd` | - | 不带参数时显示当前目录 |
| `/ls` | - | 弹出目录/文件卡片；点击目录切换，点击 30MB 内文件发送到飞书 |
| `/ws save <name>` | - | 把当前目录保存为命名别名 |
| `/ws use <name>` | - | 切换到别名目录（清空会话） |
| `/ws remove <name>` | - | 删除别名 |
| `/ws` `/ws list` | - | 列出所有别名（卡片，带「使用」「删除」按钮） |
| `/resume [agent] [N]` | `/r` | 列出/切换当前目录的 agent session（卡片，分页，默认每页 5 个） |
| `/resume <id>` | - | 手动切换到指定 session id |
| `/active` | - | 列出本进程内存中正在进行中的任务（包括 Agent 任务和 Bash 命令） |
| `/new` | - | 清空当前 session（清 `sessionId` + `sessionCwds`，**工作目录保留**），下次消息开新对话 |
| `/status` | `/s` | 显示工作目录、会话目录（不同时）、session、模型、进程状态 |
| `/stop` | `/t` | 终止当前 agent 进程（SIGTERM 后立即 SIGKILL，不等宽限期） |
| `/ps` | - | 查询是否有进程在跑 |
| `/reconnect` | - | 重连飞书 WebSocket |
| `/config` | `/c` | 查看配置（卡片交互，布尔值点击切换，其他用按钮选择） |
| `/order save <text>` | `/o` | 保存常用指令 |
| `/order` `/order list` | `/o` | 列出已保存的指令 |
| `/exit` | `/e` | 退出 bridge |
| `/restart` | - | 原地自重启 bridge：新进程同 config 接管，启动通知稍后送达 |

### 命令详解

#### `/cd` 与 `/ls`：目录导航

- **`/cd <path>`** 支持 `~`（展开为 home 目录）、绝对路径和相对路径（相对当前目录）。切换后会清空 session，因为 `--resume` 会恢复 Claude 记忆中的旧 cwd，不清则文件读写错乱。
- **`/ls [dir]`** 返回 CardKit 2.0 卡片，列出当前目录的**全部**子目录和文件；传 `[dir]` 可列出指定子目录（等价于 bash `ls <dir>`）。点击目录按钮即浏览该目录（`ls.browse`，不切换 cwd），"切换"按钮把工作目录切换到当前浏览的绝对路径（`ls.switch`，校验目标存在且是目录）。点击文件按钮会把 30MB 内的文件上传并发送到当前飞书私聊，超过限制会返回错误提示。

#### `/ws`：workspace 别名

把常用目录保存成短名字，避免每次手敲长路径。别名持久化在 `~/.lark-remote/workspace.json`（原子写入：先写临时文件再 rename）。

```text
/ws save proj        # 保存当前目录为 "proj"
/ws use proj         # 切换到 proj 目录
/ws                  # 卡片展示所有别名（等价于 /ws list）
/ws remove proj      # 删除 proj
```

#### `/resume`：切换历史 session

每个 agent（claude/codex/opencode/pi/kimi）的对话都有一个 session id，bridge 默认在每次 run 后记住它，下条消息用 `--resume` 续上。`/resume` 用来在历史 session 之间切换：

- **`/resume`** 或 **`/resume list`**：列出当前目录下当前 agent 的 session（卡片，按最近使用排序，每页 5 条带分页栏；点击按钮即切换）。当前 session 标记 ✓。
- **`/resume <agent>`**：查看指定 agent 的 session 列表（如 `/resume codex`）。
- **`/resume <N>`**：把页大小覆盖为 N（clamp `[1, 5]`，如 `/resume 3`）。
- **`/resume <id>`**：手动切换到指定 session id（需先 `/cd` 设置工作目录）。

```text
/resume              # 卡片分页列出当前目录的 session（每页 5 条）
[点击 "bbbb1234-xxxx-xxxx-xxxx-xxxxxxxxxxxx 修 bug" 按钮]
/resume codex        # 查看 codex 的 session 列表
/resume aaaa5678     # 手动切到另一个
```

> `/cd`、`/ws use`、`/ls` 点击切换目录时都会清空 session（开新对话，§9.1），因为 `--resume` 会恢复 Claude 记忆中的旧 cwd，跨目录续 session 会导致文件读写错乱。要续旧 session 请先切回对应目录再 `/resume`。Claude 会话内 `EnterWorktree` 会 relocate 到 worktree，`/s` 显示「会话目录」告知实际位置，`/new` 可回工作目录。


#### `/stop`：终止进程

`/stop` 走独立控制通道，不会排在当前 Claude run 后等待。它调用
`runner.stop({ immediate: true })`：发 SIGTERM 后立即 SIGKILL，**不等宽限期**
（`stopGraceMs` 只服务空闲看门狗自动 finish 路径，默认 5s，不可由用户调整）。
运行卡片上的「⏹ 终止」按钮行为相同。

#### `/restart`：自重启 bridge

`/restart` 让 bridge 进程原地重启：旧进程在持锁期间 spawn 一个 detached 继任者
（继承同一命令行参数，即同一 `--config-dir`），回复「♻️ bridge 重启中（新进程
pid N），启动通知稍后送达…」后干净退出并释放单例锁；新进程等旧进程死亡后走正常
锁 acquire 接管（最多等 20s，超时仍继续尝试 acquire——若旧进程真的还活着会撞锁
退出，不会出现双实例）。重启完成后向最近私聊联系人发送启动通知。

- **无单字母别名**：`/r` 仍归 `/resume`，请使用全词 `/restart`（`/help` 卡片上的
  `/restart` 按钮行为与手打一致）。
- **重启前请先 `/stop` 或等任务完成**：进行中的 claude/bash run 不会被保留，旧进程
  退出后其内存状态随之消失（jsonl 里的 session 仍在，可用 `/resume` 恢复上下文）。
- **spawn 失败不会退出旧进程**：若无法拉起继任者（如日志目录不可写），会收到
  「重启失败：…，旧进程仍在运行」，bridge 继续服务。
- **开发形态注意**：`bun run dev` 重启的是源码、`bun dist/cli.js` 重启的是 dist——
  改完代码后不 `bun run build` 就 `/restart`，新进程跑的还是旧 dist。

---

## 六、工作流示例

### 场景 1：远程改代码

```text
你: /cd ~/projects/my-app
你: 帮我看下 src/index.ts 的 main 函数，加个错误处理
Claude: [读文件 → 修改 → 展示 diff]
你: 跑下测试
Claude: [运行 npm test → 返回结果]
```

### 场景 2：多项目切换

```text
你: /ws save backend ~/projects/api
你: /ws save frontend ~/projects/web
你: /ws use backend
你: 重启服务
Claude: ...
你: /ws use frontend
你: 同样重启下
Claude: ...
```

### 场景 3：卡片导航

```text
你: /cd ~/projects
你: /ls
[卡片: my-app | api | web | ...]
你: [点击 "my-app" 按钮]
bot: 已切换到: /Users/you/code/my-app
你: 现在跑起来
```

---

## 七、输出格式

每次 Claude run 正常路径只创建一张 CardKit 2.0 卡片，并持续原地更新：

- **thinking**：由 `showThinking` 控制，标题显示本地时间戳
- **正文**：保留最新滚动窗口，正文前显示本地时间戳
- **tool_use / tool_result**：由 `showToolUse` / `showToolResult` 控制，旧工具自动折叠，工具标题显示本地时间戳
- **运行状态**：正在思考、调用工具或输出
- **终态**：完成、出错、中断、空闲超时；终态会移除停止按钮
- **表情回应**：你的原消息上，处理中先打 `Typing`；结束时按终态补打 `Done`（完成）/ `ERROR`（出错）/ `Alarm`（空闲超时）/ `SHHH`（用户 `/stop`）。bash（`!`）命令始终打 `Done`。key 来自飞书官方表情清单，新增终态映射需同步 anchor 测试。

卡片有严格 UTF-8 字节预算，是有损进度摘要，不是完整 transcript。

---

## 八、异常处理

| 情况 | 行为 |
|------|------|
| claude 进程被外部 kill | bridge 报错但不崩溃，下一条消息正常处理 |
| claude 长时间无输出（挂起） | 15 分钟空闲看门狗自动终止进程，原卡片显示超时，queue 解除阻塞 |
| bridge 异常退出 | 残留 claude 进程被清理（启动时读 pid 文件 kill 孤儿） |
| 同一 configDir 重复启动 | 第二个实例直接退出并提示已有 pid |
| 飞书限流（99991400） | 自动 sleep 200ms 重试一次 |
| `/ls` 点击文件发送失败 | 返回 `发送文件失败: ...`，30MB 以上文件在上传前拒绝 |
| 消息并发到达 | 串行处理（Promise 链），不会启动多个 claude 进程 |
| `/cd` 后发消息 | 清空 session，开新对话（不带 `--resume`） |

---

## 九、测试

```bash
bun run test        # vitest 全部测试
bun run typecheck   # tsc --noEmit 静态检查
```

测试覆盖：config、session、workspace、runner（JSONL 解析 + exit code）、card（状态机、渲染、
stream 生命周期）、bridge（work queue + control lane + 看门狗 + 降级）、router 以及 integration。

---

## 十、深入文档

| 想了解 | 看哪里 |
|--------|--------|
| 整体设计、JSONL 事件、坑点 | [`architecture/design.md`](architecture/design.md) |
| 单卡流式架构与飞书验收 | [`architecture/streaming-card.md`](architecture/streaming-card.md) |
| 新增 agent 接入模板 | [`guides/add-new-agent.md`](guides/add-new-agent.md) |
| Codex 配置卡片指南 | [`guides/codex-config.md`](guides/codex-config.md) |
| 飞书 CardKit 2.0 组件参考 | [飞书开放平台官方文档](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview) |
| 入门指南 | [`getting-started.md`](getting-started.md) |
