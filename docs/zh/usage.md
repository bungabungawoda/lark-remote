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
  appId: cli_xxx # 飞书应用 App ID
  appSecret: xxx # 飞书应用 App Secret

# 默认 agent：claude | codex | opencode | pi | kimi | dsh，默认 claude
defaultAgent: claude

claude:
  model: claude-opus-4-8 # 模型
  effort: medium # 推理强度 low | medium | high | xhigh | max
  permissionMode: auto # 取值：default（=不传 --permission-mode，CLI 无此值）| acceptEdits | auto | bypassPermissions | manual | dontAsk | plan（/config 卡片可切换；auto 为默认：低风险放行、高风险审批）
  stopGraceMs: 5000 # 空闲超时自动停止时的优雅关闭宽限时间（毫秒）

agents:
  kimi: # 纯 ACP 模式（kimi acp 持久连接，支持审批 + compact）
    permissionMode: manual # manual（始终询问）| yolo（必要时询问）| auto（完全自动）；kimi 0.40+ 语义，无人值守全放行用 auto
    acp: # acp 连接参数
      binary: kimi
      requestTimeoutMs: 60000
      idleTtlMs: 1800000
      turnIdleTimeoutMinutes: 10
  dsh: # DSH（DeepSeek Harness）Web Host 直连（HTTP+WS，全机共享进程）
    host: http://127.0.0.1:3080 # 本地 DSH Web Host 地址，默认 3080 端口
    manageProcess: true # 未运行时由 lark-remote 后台拉起（detached，退出不停止 DSH）
    dshHome: '' # 可选：DSH_HOME，默认 $DSH_HOME 或 ~/.dsh
    dshCommand: dsh # 可选：dsh 可执行文件
    startTimeoutMs: 30000 # 后台启动后等待端口可用的上限
    token: '' # 可选兜底：dsh web 启动 URL 里的 token（重启后会变）
    credentialsFile: '' # 可选：DSH 凭据文件；默认 $DSH_HOME/.credentials.yaml 或 ~/.dsh/.credentials.yaml
    agentPreset: '' # preset（标准/极简/...）；留空 = 跟随服务端默认；session 创建后不可改
    permissionPreset: '' # 权限预设（沙箱 + 审批策略）；留空 = 不干预
    provider: '' # provider route（deepseek-official / deepseek-account / anthropic/...）；留空 = 兼容旧配置，按 deepseek-official
    model: '' # 模型名；留空 = 该 provider 的默认模型
    reasoningEffort: '' # off/low/high/max；留空 = 模型默认档位

logging:
  level: info # debug | info | warn | error

idle:
  watchdogMinutes: 15 # 空闲超时自动停止，0 关闭
```

配置文件路径可用 `--config-dir` CLI 参数覆盖（如 `lark-remote --config-dir /path/to/dir`）。

> **不要把真实 config.yaml 提交进仓库。**

### DSH agent（DeepSeek Harness，HTTP+WS 直连）

DSH 与其他 5 个 agent 不同：agent runner 不持有本地子进程，而是连到**全机共享**的 DSH Web Host（默认 `http://127.0.0.1:3080`，HTTP+WebSocket）。DSH 未运行时，lark-remote 会在后台 detached 拉起 `dsh web`，lark-remote 退出不会停止它；已在运行则直接复用。DSH 0.2.x 的 `/api/*` 和 `/api/remote.mux` 要求认证。lark-remote 读取 DSH 的持久凭据文件（`$DSH_HOME/.credentials.yaml`，未设置 `DSH_HOME` 时为 `~/.dsh/.credentials.yaml`），用其中 `client-connection/browser-session` 的签名密钥现签一个短时效 v1 cookie；这个 cookie 在 `dsh web` 重启后仍然有效，所以不需要每次手动更新 token。

后台拉起的 DSH 工作目录是 `DSH_HOME`，不会读取某个项目目录下的 `.env`。需要给 DSH 进程注入环境变量时，放在 `$DSH_HOME/.env` 或 lark-remote 的启动环境中。一个 `DSH_HOME` 约定只跑一个 DSH；端口用固定值（默认 3080），不要用 `--port 0`。

可用配置项（`agentPreset`/`permissionPreset`/`provider`/`model`/`reasoningEffort` 可在 `/config` 卡片改写保存；`token`/`credentialsFile` 仅 YAML 配置，不在卡片展示或保存）：

- `agents.dsh.host`：DSH Web Host base URL，默认 `http://127.0.0.1:3080`。**修改会触发停放当前 dsh session 到恢复槽**（下次消息新建会话，避免 host 不一致导致 session 历史归属错乱）。
- `agents.dsh.manageProcess`：未探测到 DSH 时是否由 lark-remote 拉起，默认 `true`。子进程以 detached 方式运行，lark-remote 退出、重启都不会停止它；设为 `false` 时只连接已运行的 DSH。
- `agents.dsh.dshHome`：启动 DSH 时使用的 `DSH_HOME`，同时决定启动锁和日志目录（`$DSH_HOME/lark-remote/`）。留空时按 `$DSH_HOME` → `~/.dsh` 解析。
- `agents.dsh.dshCommand`：`dsh` 可执行文件，默认从 `PATH` 查找 `dsh`。
- `agents.dsh.startTimeoutMs`：后台拉起后等待端口响应的上限，默认 `30000` 毫秒。
- `agents.dsh.token`：可选的 YAML 兜底凭据，填 `dsh web` 启动 token 或整条启动 URL。**只在配置文件里使用，不在 `/config` 卡片展示或保存**，避免启动 token 出现在飞书卡片上。只有在默认凭据文件不可读（例如 DSH 使用了不同的 `DSH_HOME` 且未配置 `credentialsFile`）时才需要；正常自动模式下无需维护。
- `agents.dsh.credentialsFile`：DSH 凭据文件路径（YAML 配置项）。留空时按 `$DSH_HOME/.credentials.yaml` → `~/.dsh/.credentials.yaml` 解析。lark-remote 只读取 `client-connection/browser-session` 记录，不修改文件、不打印密钥；文件权限必须是 `0600`。
- `agents.dsh.agentPreset`：preset（standard / code / minimal / cordis 等，随服务端 profile bundle 变化）。**session 创建时固定，中途切换服务端返回 `agent-preset-conflict`**；切换 agentPreset 会清空当前 dsh session（session 历史是在该 preset 下产生的，换 preset 等于换语义上下文）。
- `agents.dsh.permissionPreset`：权限预设（沙箱模式 + 审批策略，如 `read-only` / `workspace-write` / `danger-full-access`）。与 `agentPreset` 不同，它**可以中途切换**；lark-remote 在会话首次 run 前执行一次 `/permission <preset>` 对齐，同一 session 不重复覆盖。留空 = 不干预，跟随 DSH 当前会话/服务端默认。保存配置时如果 turn 正在运行，新预设从下一轮开始生效，不会在当前审批下面突然改权限。执行 `/permission` 失败时 run 会 fail closed（不发 prompt）。
- `agents.dsh.provider`：DSH provider route（`deepseek-official`、`deepseek-account`、`anthropic` 等，随 DSH 目录变化）。留空 = 兼容旧配置，按 `deepseek-official` 处理。**切换 provider 不清 session**：下一次 run 用新 provider 重新对齐；显式配置的 provider 不可用时 run 直接失败，不会静默回退。飞书卡片的 provider 下拉来自 DSH 实时目录。
- `agents.dsh.model`：模型 ID；保留 session，会话首次 run 时对齐一次（`session.selectModel`，同一 session 不重复调用）。留空 = 该 provider 的默认模型（provider 也未配置时跟随服务端默认）。
- `agents.dsh.reasoningEffort`：off / low / high / max（随模型目录变化）；保留 session。模型不支持当前档位时，切换 provider/model 会重置到合法档位。

#### 给 DSH 增加 Provider

飞书卡片只切换 DSH 里已经存在的 provider，不接收 API key。新增 provider 在 DSH 侧完成：

1. Web UI：打开 `http://127.0.0.1:3080` → 设置 → Models → 添加模型提供商。第三方 provider 从 pi-ai 目录选择；自定义网关选「自定义模型 API」，填 Provider ID、baseURL、协议、模型和 API Key。密钥由 DSH 的 credentials 服务保存，不写进 `cordis.patch.yml`。
2. 或编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，给 `llm-pi-ai` 增加 `providers`：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
```

配置生效后，重新打开 `/config`，provider 下拉会出现新 provider；选择它和模型，保存后下一次消息生效。

跑 dsh 期间如果服务端发出 `approval/requested`，lark-remote 会把它渲染成 run 卡底部的审批区，显示命令/工具、模型给出的 justification，并提供「允许一次 / 拒绝」。允许只对这一次调用生效，不会改变会话权限预设。如果 `$events` 审批通道不可用（旧版 DSH 或凭据没有 answer 能力），卡片回退为「请到 DSH Web UI 处理」并保留 turn 存活；在 Web UI 先处理时，飞书审批区也会自动撤掉。

---

## 四、运行

```bash
bun run dev      # 开发（bun 直跑 TS）
lark-remote      # 全局安装后直接用
```

lark-remote 启动后不在终端输出，运行日志写入 `~/.lark-remote/logs/`（见下）。同一 `configDir` 只允许一个实例；重复启动会退出并提示已有 pid。连接飞书成功后，lark-remote 会向最近私聊用户发送启动通知，包含启动时间和进程号。

lark-remote 运行期间会**阻止系统自动休眠**，以免远程连接不上（macOS 用 `caffeinate`、Windows 用 `SetThreadExecutionState`）——典型用法是人不在电脑前远程使用，系统一旦休眠飞书连接即断。只阻止系统自动休眠，不影响显示器睡眠；lark-remote 退出（含异常退出）后自动解除。该行为恒开启，无配置开关。注意：MacBook 合盖睡眠无法阻止（除非接电源并外接显示器）。

日志按日期轮转，落在 `~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log`（每天一个子目录，路径由 configDir 推导，级别由 `logging.level` 配置）。

---

## 五、命令

直接发非 `/` 开头的消息即转发给 Claude。以 `/` 开头走内置命令，**部分命令支持单字母别名**（`/help /h`、`/status /s`、`/stop /t`、`/exit /e`、`/resume /r`、`/config /c`、`/order /o`、`/download /d`）：

| 命令                                        | 别名 | 行为                                                                                                                                                         |
| ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/help`                                     | `/h` | 显示命令列表                                                                                                                                                 |
| `/cd <path>`                                | -    | 切换 Claude 工作目录（支持 `~`、绝对/相对路径，会清空当前会话，下次消息开新对话）                                                                            |
| `/cd`                                       | -    | 不带参数时显示当前目录                                                                                                                                       |
| `/ls [dir\|file]`                           | -    | 弹出目录/文件卡片；点击目录切换，点击 30MB 内文件发送到飞书；条目 >30 时分页（可直接输入页码跳转），卡片内可按关键词筛选本层条目。传文件路径时列出该文件本身 |
| `/download <path>`                          | `/d` | 直接下载（发送）指定文件到飞书，上限 30MB                                                                                                                    |
| `/ws save <name>`                           | -    | 把当前目录保存为命名别名                                                                                                                                     |
| `/ws use <name>`                            | -    | 切换到别名目录（清空会话）                                                                                                                                   |
| `/ws remove <name>`                         | -    | 删除别名                                                                                                                                                     |
| `/ws` `/ws list`                            | -    | 列出所有别名（卡片，带「使用」「删除」按钮，可按名称/路径关键词筛选）                                                                                        |
| `/resume [agent] [N]`                       | `/r` | 列出/切换当前目录的 agent session（卡片，分页，默认每页 5 个）                                                                                               |
| `/resume <id>`                              | -    | 手动切换到指定 session id                                                                                                                                    |
| `/active`                                   | -    | 列出本进程内存中正在进行中的任务（包括 Agent 任务和 Bash 命令）                                                                                              |
| `/new`                                      | -    | 清空当前 session（清 `sessionId` + `sessionCwds`，**工作目录保留**），下次消息开新对话                                                                       |
| `/status`                                   | `/s` | 显示工作目录、会话目录（不同时）、session、模型、进程状态                                                                                                    |
| `/stop`                                     | `/t` | 终止当前 agent 进程（SIGTERM 后立即 SIGKILL，不等宽限期）                                                                                                    |
| `/ps`                                       | -    | 查询是否有进程在跑                                                                                                                                           |
| `/config`                                   | `/c` | 查看配置（卡片交互：下拉/输入选择，保存按钮落盘）                                                                                                            |
| `/order save <text>`                        | `/o` | 保存常用指令                                                                                                                                                 |
| `/order` `/order list`                      | `/o` | 列出已保存的指令（卡片，可给指令起别名、编辑、删除）                                                                                                         |
| `/order edit <orderId\|序号> <新文本>`      | `/o` | 编辑指令文本（卡片「编辑」按钮是主入口，保留别名和使用统计）                                                                                                 |
| `/order alias add <orderId\|序号> <别名名>` | `/o` | 给指令绑定别名（也可在卡片上「＋别名」操作），之后输入 `$name` 即展开                                                                                        |
| `/order alias rm <orderId\|序号>`           | `/o` | 移除指令的别名                                                                                                                                               |
| `/exit`                                     | `/e` | 退出 lark-remote                                                                                                                                             |
| `/restart`                                  | -    | 原地自重启 lark-remote：新进程同 config 接管，启动通知稍后送达                                                                                               |
| `/clone <name>`                             | -    | 复制分身：克隆配置到新目录并扫码创建新应用，完成后自动绑定并拉起新实例                                                                                       |

### 命令详解

#### `/cd` 与 `/ls`：目录导航

- **`/cd <path>`** 支持 `~`（展开为 home 目录）、绝对路径和相对路径（相对当前目录）。切换后会清空 session，因为 `--resume` 会恢复 Claude 记忆中的旧 cwd，不清则文件读写错乱。
- **`/ls [dir]`** 返回 CardKit 2.0 卡片，列出当前目录的**全部**子目录和文件；传 `[dir]` 可列出指定子目录（等价于 bash `ls <dir>`）。点击目录按钮即浏览该目录（`ls.browse`，不切换 cwd），"切换"按钮把工作目录切换到当前浏览的绝对路径（`ls.switch`，校验目标存在且是目录）。点击文件按钮会把 30MB 内的文件上传并发送到当前飞书私聊，超过限制会返回错误提示。
- **「返回」按钮回到本次 `/ls` 的起点**：`/ls <dir>` 的起点是 `<dir>` 本身（所以起点卡片上没有「返回」，只有「切换」）；进入子目录后「返回」回到 `<dir>`，**不会把你丢回 workspace 工作目录**。不带参数的 `/ls` 起点即当前工作目录，行为与以前一致。翻页、刷新都不会丢掉这个起点。
- **`/ls <file>`** 传文件路径时不再报 `Not a directory`，而是渲染一张单文件卡片（路径、大小、修改时间，附「下载」与「上级」按钮），方便先确认文件是否存在再决定是否下载。
- **分页跳转**：`/ls`、`/ws`、`/resume`、`/active`、`/order` 的列表超过一页时，分页栏除「上一页/下一页」外还有一个页码输入框；输入页码后按回车提交即可直接跳到该页（超出范围会 clamp 到最后一页，非法输入给出提示且不刷新卡片）。
- **关键词搜索**：`/ls` 与 `/ws` 卡片上半区各有一行搜索输入框，输入关键词后**按回车提交**（飞书 CardKit 的 input 没有逐键回调，只能整条提交）。`/ws` 匹配别名或完整路径，`/ls` 只匹配**当前层**条目名（不递归子目录），均大小写不敏感、子串包含。筛选态下翻页/刷新/排序/使用/删除会保留关键词，进子目录/上级/返回/切换则清除筛选（换目录后旧关键词无意义）；取消筛选点搜索行右侧的**「清除筛选」**按钮（清空输入框再回车在部分客户端不会触发回调，不作依赖）。计数与页码都按过滤后的结果计算。

#### `/download`：直接下载文件

**`/download <path>`**（别名 `/d`）把指定文件直接上传并发送到当前飞书私聊，不需要先进 `/ls` 卡片再点文件按钮。路径规则与 `/ls` 一致：支持 `~`（展开为 home 目录）、绝对路径与相对路径（相对当前工作目录，需先 `/cd`）。上限 30MB，与飞书 `im/v1/files` API 一致；目录、不存在的路径、超限文件都会返回明确的错误提示而不发送。

```text
/download ~/reports/2026H1.pdf     # 直接发送该文件
/d lr.zip                          # 相对当前工作目录
```

#### `/ws`：workspace 别名

把常用目录保存成短名字，避免每次手敲长路径。别名持久化在 `~/.lark-remote/workspace.json`（原子写入：先写临时文件再 rename）。

```text
/ws save proj        # 保存当前目录为 "proj"
/ws use proj         # 切换到 proj 目录
/ws                  # 卡片展示所有别名（等价于 /ws list）
/ws remove proj      # 删除 proj
```

#### `/resume`：切换历史 session

每个 agent（claude/codex/opencode/pi/kimi/dsh）的对话都有一个 session id，lark-remote 默认在每次 run 后记住它，下条消息用 `--resume` 续上。`/resume` 用来在历史 session 之间切换：

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
（`stopGraceMs` 只服务空闲超时自动停止的收尾流程，默认 5s，不可由用户调整）。
运行卡片上的「⏹ 终止」按钮行为相同。

#### `/restart`：自重启 lark-remote

`/restart` 让 lark-remote 进程原地重启：旧进程在持锁期间 spawn 一个 detached 继任者
（继承同一命令行参数，即同一 `--config-dir`），回复「♻️ lark-remote 重启中（新进程
pid N），启动通知稍后送达…」后干净退出并释放单例锁；新进程等旧进程死亡后走正常
锁 acquire 接管（最多等 20s，超时仍继续尝试 acquire——若旧进程真的还活着会撞锁
退出，不会出现双实例）。重启完成后向最近私聊联系人发送启动通知。

- **无单字母别名**：`/r` 仍归 `/resume`，请使用全词 `/restart`（`/help` 卡片上的
  `/restart` 按钮行为与手打一致）。
- **重启前请先 `/stop` 或等任务完成**：进行中的 claude/bash run 不会被保留，旧进程
  退出后其内存状态随之消失（jsonl 里的 session 仍在，可用 `/resume` 恢复上下文）。
- **spawn 失败不会退出旧进程**：若无法拉起继任者（如日志目录不可写），会收到
  「重启失败：…，旧进程仍在运行」，lark-remote 继续服务。
- **开发形态注意**：`bun run dev` 重启的是源码、`bun dist/cli.js` 重启的是 dist——
  改完代码后不 `bun run build` 就 `/restart`，新进程跑的还是旧 dist。

#### `/clone`：复制分身

**`/clone [name]`**（`/help` 卡片的「/clone」按钮可直接点击开始，等价无参调用）在当前配置目录旁生成一份"分身"配置目录（`<configDir>-<name>`，省略名字时随机生成「2 位数字 + 2 位字母数字」后缀），除飞书 `appId/appSecret` 外全部配置原样复制，然后引导你扫码创建一个全新的飞书应用：

1. 二维码以**图片消息**直接发进私聊（也可在浏览器打开链接创建，约 10 分钟内有效）；
2. 等待扫码期间一切消息都进入分身流程，不会转发给 coding agent：输入「重发」重新生成二维码，输入 `/Q` 取消（不写任何配置），其他输入会收到引导提示；
3. 扫码成功后自动完成绑定（新应用侧的 openId 直接写入新目录的 `startup-contact.json`，无需再发消息认领），workspace 别名、常用指令、工作目录与会话状态一并同步（会话按新应用 openId 重绑，自动恢复即可续聊），并自动拉起指向新目录的新实例（启动后新应用会收到它的启动通知）；
4. 原应用收到完成回执：新应用 App ID、配置目录、进程号。手动启动命令为 `lark-remote --config-dir <新目录>`。

名字不能包含路径分隔符、不能以 `.` 开头/以点或空格结尾，也不能是 Windows 保留设备名（`con`/`nul`/`com1` 等）；目标目录已存在时会拒绝并提示换名。

### 入站媒体：自动落盘并注入 prompt

往飞书私聊发图片、文件、视频、语音或表情，lark-remote 会自动下载并保存到
**当前工作目录**的 `.lark-remote-temp/<YYYYMMDDHHmm>/`（按分钟分子目录）。
附件路径会自动写进 agent 的 prompt，agent 用现有 Read/Bash 工具读本地文件，
**runner 无需任何改造**。

- 文件消息保留原始文件名（自动 sanitize 防路径穿越）；图片消息按
  `image_<HHmmss>_<n>.<ext>` 命名；视频、语音、表情保留原名，没有原名时按
  MIME 类型或文件头推断扩展名（例如 `.mp4`、`.opus`）；
- 同一分钟内的多条消息合并成一个回合。先发图再发文字，或先发文字再发图，
  agent 收到的 prompt 相同，且同时包含文字与附件路径；
- 发图时不再单独回复一条「已保存」提示：路径已经在 agent 的 prompt 里。
  只发附件、不配文字时，lark-remote 不启动 agent，只回复「已保存 N 个文件」
  并提示你说一句话即可开始处理；
- 同名冲突自动加序号，不覆盖；单文件上限默认 100 MB
  （config.yaml `inboundMedia.maxFileSizeMb` 可调）。飞书要求大于 100 MB 的文件
  分片下载，本工具暂不支持分片，所以上限调得再高也保存不了更大的文件；
- 未设置工作目录时会提示先 `/cd` 或 `/ws use`；
- 收到卡片、位置、投票、日程等不支持的媒体消息时，lark-remote 只回复一条
  「暂不支持」提示，不会把这些消息当成你的输入发给 agent；
- 合并窗口为 700 ms。窗口内到达的文字与附件算同一个回合；
- **`.lark-remote-temp/` 建议加入项目的 `.gitignore`**：lark-remote 不会自动清理
  或修改这些文件，避免临时文件被提交。

config.yaml 可选配置（默认即可用）：

```yaml
inboundMedia:
  enabled: true
  dirName: '.lark-remote-temp'
  maxFileSizeMb: 100
```

`enabled: false` 时不会保存附件，但会收到一条「已关闭」的提示（不静默）。

### 快捷别名 `$name`

给收藏的指令起个别名，输入 `$name` 即触发该指令，适合高频短语：

```text
/order save 跑全量测试
/order alias add 1 all        # 给第 1 条指令绑定别名 all（序号按 /order 列表顺序）
$all                          → 展开为 "跑全量测试"（等价于执行该指令）
/order alias add 2 h
$h /tmp/a.txt                 → 展开为 "请读取文件并分析 /tmp/a.txt"
```

- **卡片是主入口**：`/order` 卡片每条指令有「＋别名」按钮，点击弹出输入框即可
  绑定/修改别名；已绑定的指令显示 `$name` 标签，旁边 ✕ 删除别名。
  命令 `/order alias add|rm` 是备选入口；
- **1 条指令 = 1 个别名**，全局唯一，不能与已有别名重名；
- 只匹配消息开头的 `$name`（后接空格或行尾），全词精确匹配，大小写敏感；
- 名称只能包含字母/数字/下划线且**不能数字开头**（`$500` 这类文本永远不会误展开）；
- `!` 开头的 bash 消息和 `/` 开头的命令不展开（`$PATH` 等 shell 变量不受影响）；
- 未注册的 `$xxx` 原样发给 agent，不报错；
- 展开结果以 `/` 开头会走命令路径（可触发 `/cd` 等）；别名展开成 `!` 命令是
  用户自定义行为，注意安全；
- 别名随指令持久化在 `<configDir>/orders.json`，删除指令时别名一并删除；
- 名称不超过 20 个字符（`MAX_ALIAS_NAME_LENGTH`），不能与已有别名重名。

#### 编辑指令文本

`/order` 卡片每条指令有「编辑」按钮，点击弹出输入框（预填当前文本）即可原地修改：

```text
/order save 跑全量测试       # 第 1 条
/order edit 1 跑全量测试 v2   # CLI 备选路径（卡片是主入口）
```

- 编辑**保留别名**（`alias`）、**使用统计**（`usedAt`）和创建时间（`createdAt`），只动 `text`；
- 长度上限 200 字符，与 `/order save` 一致；超长或空白会返回错误 toast 并停留在编辑卡；
- 文本未变化时短路写盘（mtime 不变），避免无意义磁盘 IO。

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
你: /cd ~/projects/api
你: /ws save backend
你: /cd ~/projects/web
你: /ws save frontend
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

每次 Claude run 正常路径只创建一张 CardKit 2.0 卡片，并持续原地更新。thinking、
tool_use / tool_result 恒常展示（不做配置开关）：

- **thinking**：始终展示，标题显示本地时间戳
- **正文**：保留最新滚动窗口，正文前显示本地时间戳
- **tool_use / tool_result**：始终展示，旧工具自动折叠，工具标题显示本地时间戳
- **运行状态**：正在思考、调用工具或输出
- **终态**：完成、出错、中断、空闲超时；终态会移除停止按钮
- **表情回应**：你的原消息上，处理中先打 `Typing`；结束时按终态补打 `Done`（完成）/ `ERROR`（出错）/ `Alarm`（空闲超时）/ `SHHH`（用户 `/stop`）。bash（`!`）命令始终打 `Done`。key 来自飞书官方表情清单，新增终态映射要和上面的终态清单一并更新。

卡片有严格 UTF-8 字节预算，是有损进度摘要，不是完整 transcript。

---

## 八、异常处理

| 情况                        | 行为                                                        |
| --------------------------- | ----------------------------------------------------------- |
| claude 进程被外部 kill      | lark-remote 报错但不崩溃，下一条消息正常处理                |
| claude 长时间无输出（挂起） | 15 分钟空闲超时自动终止进程，原卡片显示超时，queue 解除阻塞 |
| lark-remote 异常退出        | 残留 claude 进程被清理（启动时读 pid 文件 kill 孤儿）       |
| 同一 configDir 重复启动     | 第二个实例直接退出并提示已有 pid                            |
| 飞书限流（99991400）        | 自动 sleep 200ms 重试一次                                   |
| `/ls` 点击文件发送失败      | 返回 `发送文件失败: ...`，30MB 以上文件在上传前拒绝         |
| 消息并发到达                | 串行处理（Promise 链），不会启动多个 claude 进程            |
| `/cd` 后发消息              | 清空 session，开新对话（不带 `--resume`）                   |

---

## 九、测试

```bash
bun run test        # vitest 全部测试
bun run typecheck   # tsc --noEmit 静态检查
```

测试覆盖：config、session、workspace、runner（JSONL 解析 + exit code）、card（状态机、渲染、
stream 生命周期）、lark-remote（work queue + control lane + 空闲超时自动停止 + 降级）、router 以及 integration。

---

## 十、深入文档

| 想了解                     | 看哪里                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 整体设计、JSONL 事件、坑点 | [`architecture/design.md`](architecture/design.md)                                                                      |
| 单卡流式架构与飞书验收     | [`architecture/streaming-card.md`](architecture/streaming-card.md)                                                      |
| 新增 agent 接入模板        | [`guides/add-new-agent.md`](guides/add-new-agent.md)                                                                    |
| Codex 配置卡片指南         | [`guides/codex-config.md`](guides/codex-config.md)                                                                      |
| 飞书 CardKit 2.0 组件参考  | [飞书开放平台官方文档](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/component-json-v2-overview) |
| 入门指南                   | [`getting-started.md`](getting-started.md)                                                                              |
