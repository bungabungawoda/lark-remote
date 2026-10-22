# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.9] - 2026-10-22

### 新增

- **运行卡片看得出长期目标跑到哪了**：DSH 会话可以带一个跨回合自动续跑的目标（objective / phase / 轮次）。此前卡片只看单个回合，目标还在续跑时你从卡上看不出来。现在状态行下方直接显示 `🎯 目标进行中 · 第 r/N 轮` 与目标摘要，长目标收进折叠面板并保留全文，回合开始就能看见而不是等收尾；摘要与轮次来自宿主投影，卡片不自行推断
- **`goal_continuing` 终态**：本轮结束但目标仍 active 时，卡片标题写「本轮结束（目标继续）」，摘要首行同调，并附一句「宿主会自动开始第 r+1 轮」。它与「已完成」是两件事：任务还在跑

### 修复

- **本轮结束不再被当成任务完成**：目标仍 active 时宿主会立刻起下一轮，会话永远不空闲。旧实现按回合收尾，卡片写着「已完成」而任务还在跑，你随后点压缩会被服务端拒。现在终态与按钮都以目标为准，这类卡片不给压缩按钮
- **中断后的卡片上压缩按钮不再是死按钮**：可压缩记录改在运行收尾的 `finally` 里写，且在「这个工作区的槽位还归不归本轮」守卫之外。停止（`/stop`、卡片上的停止按钮、抢占式立即执行）都会先摘掉槽位，等收尾走到守卫时已经不成立——记录跟着守卫走就永远不落，中断后的终态卡点压缩一律回「该任务已结束或不属于当前会话」。渲染侧共用同一判据：本轮没有会话、开跑前也没有会话时不渲染按钮，不给一个注定失败的点击
- **`/stop` 在多个工作区并行时不再假报已停止**：槽位按工作区为键，旧实现停在第一条命中就返回，只停一个却回「已停止」，另一个无声继续。现在遍历所有命中的运行与后台任务，并把实际停止数量回报出来（多条时提示已停止 N 个）；按 runId 停某一条仍然只停那一条
- **停止不会把配置变更多拖一轮**：中断时不再立即回收常驻的 runner 实例——队列链可能在等待窗口里推进下一条消息并拿走同一实例，立即回收会让那条回合并无人托管长驻连接，进程残留到空闲超时且占着写锁。改为只标记待替换，由下一次即将开跑、且该工作区确实空闲时换新实例；只看一眼的调用（探压缩能力、杀后台任务）不会被顺手换实例
- **排队卡不再停在旧状态**：移除排队条目与「已撤销」卡更新收口到同一处，调用方不再需要手工配对（漏一处就永久停在「等待中」，而映射已被消费、之后再无修正机会）；卡片的更新请求失败会重试一次，一次网络抖动不再让卡停在旧视图

### 变更

- **英文架构文档补齐本轮叙述**：停止范围与中断交接、可压缩记录与槽位所有权解耦、按钮可见性判据、队列移除与撤销卡收口，以及目标终态与目标视图，中英两侧一致，不再一边落后

## [0.5.8] - 2026-10-21

### 修复

- **DSH 的 `/resume` 列表卡看得出会话内容**：此前 DSH 会话的列表卡只有 session id 和时间，必须逐条点进详情才知道哪一条是要找的会话。DSH 0.2.x 的列表响应里已带着会话标题与每轮的输入/输出，现在把它们映射成「标题 / 最近输入 / 最后输出」直接渲染，行上有预览就不再逐条去拉分页详情（那一次会按上限把整段历史拉回来）；字段缺失或标题只是占位符时回退原有行为。详情卡头部同样优先用服务端的末轮输入作「最近输入」，并在它与会话标题不同时分成两段展示，不再把用户自己说的话挂在「AI 标题」下面
- **后台任务卡里的命令不再被截断**：活过本轮的后台任务（终端里起的后台进程）原先按固定字数截断，用户没法核对卡上那条命令到底是要停哪个。现在短命令内联展示、中等长度用代码块整段展示、只有确实很长的脚本或链式命令才收进折叠面板，且面板里保留完整原文——命令正是你要核对、要复制的对象，任何情况下不再 truncate
- **停止按钮不再被挤成「🟥…」**：命令与停止按钮原先并排同一行（命令列 `grow`、按钮列 `auto`），长命令的最小内容宽度会把按钮压成一个色块。现在命令独占一行，停止按钮在下一行独占一列
- **运行卡片收尾后保留状态行**：终态原先会把「⏱ 耗时 · 🧰 步数 · 📊 上下文」整行去掉，回看卡片时看不出这一跑花了多久、做了多少步。现在保留：耗时定格，步数与上下文显示该回合最后一次投影的快照

### 变更

- **模型输出被服务方内容审核截断时不再算「运行出错」，并会自动续跑一次**：上游把 `finish_reason: content_filter` 归一成普通错误，它既不在默认的重试判据里（空响应/限流/服务错误/超时/传输），也不会触发换模型，于是一次多为误报的判定就把整个回合判死——跑了很久的回合在最后一步被截断，已写入磁盘的改动都还在，卡片上却只有一句英文内部报文。现在错误卡说明三件事：谁拦的、改动还在、下一步可做什么（重试仍被拦截时换模型或稍后再试）；桥接层同时在同一会话补一条「从上次中断的位置继续，不要重复已完成的步骤」，只补一次，且若运行期间会话指针已被 `/new`、`/resume` 移动过就跳过，避免把旧会话接回来
- **DSH 在卡片上的显示名统一为 `DSH`**：各 agent 的显示名收敛到同一张表，启动注册与没有注册表时的回退路径共用同一份数据，不再出现同一 agent 在不同位置叫法不同
- **重复实现单源化，无行为变化**：档位取中位、工具摘要、卡片头部/按钮/字段行、队列管理与配置卡渲染等此前写了两遍的实现合并为单一来源；测试专用生产钩子移除；同主题测试套件合并、共享夹具抽出（用例覆盖不减）
- **文档里的测试锚点改指存活文件**：套件合并删掉了若干测试文件，贡献指南与架构设计文档按路径点名的锚点因此指向不存在的路径，已改指承接其覆盖的文件。无行为变化

## [0.5.7] - 2026-10-20

### 新增

- **DSH 运行的工具调用与运行状态进卡**：此前 DSH 直连的运行卡片只有正文、看不到任何工具调用。现在工具块以原生折叠面板呈现（与思考块同款交互，点标题展开、不经过服务端往返），运行中或失败的默认展开，正文按卡片内工具数量分配截断预算；摘要识别 DSH 的工具名与参数（`glob`、`web_search`、`todo_write`、`subagent`、`job_*`、`terminal_*` 等），标题显示不下时按**显示宽度**做中间省略——保住工具名与路径结尾，而不是从尾部切掉文件名。卡片还会投影 DSH 的 `session/control` 状态流（步数与上下文占用），并在首帧列出仍在后台运行的任务（终端里 `run_in_background` 起的进程活过了本轮），终态卡片可直接停止它们
- **恢复卡片能看出思路**：DSH 的历史块分 `text` / `reasoning` / `tool-call` 三类，此前只认 `text`，于是一个真实会话里 371 段思考、12 段正文的恢复卡只剩一串工具调用。现在思考映射成 thinking、正文映射成回复，工具调用与结果合成同一个面板（标题带工具名与命令，失败标 `❌`，正文是输出）
- **`/resume` 卡保住「我上一句 + 你最后一句」**：卡片只显示最后 N 个块，用户最关心的「我刚说了什么、它最后答了什么」常被中间的工具往返挤出窗口。现在这两句有独立名额

### 修复

- **手机端窄屏排版**：状态行原先用并排短列布局，窄屏上会被挤成竖排（「运行中」三个字竖着排），且列宽由客户端决定、服务端控制不了。改为单行单块 + ` · ` 分隔，并补上本轮耗时
- **卡片元素总数上限按实测收敛**：飞书拒绝的判据是递归 `elements` 成员数量，此前记录有误。现在运行卡片同时受字节预算与元素预算约束，超限时从最旧的步骤开始省略，不再整卡发送失败
- **DSH 的停止不再假报已停止**：回合跑在共享的 `dsh web` 宿主里，退出本地进程带不走它。停止现在分两步——prompt 还没被回合取走时从宿主收件箱撤回，已被取走才发取消并用 `session/list.running` 轮询确认；无法确认时明确告知「可能仍在后台运行」，而不是报一句已停止。取消确认落地前，下一条消息由门禁拦住，避免会话级取消打到新回合；每次提交的在途身份另存一份，下次启动对账：清掉残留的待执行 prompt，对仍开着的回合只提示不代杀
- **排队与压缩的回合归属**：排队中的 prompt 此前可能在上一个回合结束时被收尾，现在绑定到自己的回合；`/compact` 执行前先探服务端是否还有在途回合；进程退出时取消尚未收尾的回合，不留无人订阅的孤儿回合
- **空闲判定改用会话状态**：此前靠事件流静默推断，工具往返密集时容易误判。现在读 `session/list.running`，事件探测降为兜底
- **回顾卡不再被系统注入内容灌满**：DSH 的 `user/message` 里混着 agent 指令、技能清单、运行期上下文、压缩检查点等注入项，此前照单全收，回顾卡上看不见用户真正说过的话。现在按类型过滤，系统通知单独标 `🔔`
- **Windows 与 CI 稳定性**：退出路径的取消与凭据检查统一走平台判定；若干用例的凭据路径断言跟随 `path.join`，不再写死 POSIX 字面量

### 变更

- **英文文档补齐 DSH 部分**：`docs/en/architecture/design.md` 补上停止与取消确认的叙述，`docs/en/architecture/streaming-card.md` 更正工具折叠的口径（此前写的「连续工具超过阈值折叠」已被实现取代），两侧不再有互相矛盾的说法
- **用户文档纠正过期说法**：`/order` 别名的命令形态与存储位置（英文侧仍写已移除的 `/order alias <name> <text>` 与 `aliases.json`，实际是 `alias add|rm <orderId|序号>`、随指令存在 `orders.json`）、`/ws save` 示例多带一个实际不生效的路径参数、贡献指南要求 `bun run test` 而入门文档教的是 `bun test`、README 里真机用例的缺失目录前缀
- **注释与文档整理**：入站消息两篇架构文档改为描述当前实现，测试文件头不再点名已不存在的文件。无行为变化

## [0.5.6] - 2026-10-18

### 新增

- **DSH 的提问（`ask_user_question`）转写到飞书运行卡片**：agent 运行中提出的问题现在渲染成卡片底部的提问区——选项按钮（单选 ⚪/🔵、多选 ⬜/☑️）、「自定义答案（Other）」输入、多选时的「✅ 提交答案（已选 N 项）」，以及底部统一的「⏭️ 跳过回答」。回答按题目编码回 DSH。plan-review 那类把计划全文放在正文里的提问，卡片用折叠面板承载（超出字节预算时截断），不会让你在看不到计划的情况下做选择。飞书卡 30 分钟没人回答时只把这一路交回 DSH Web UI，不取消回合，卡片保留「可在 DSH Web UI 继续回答」的提示

### 修复

- **断线重连后重投的提问不再让勾选与答案错位**：同一个提问在 `$events` 重连后会被重新投递，此前协调器沿用旧一路的计时、已记录的答案也不会落到新视图，卡片上勾着的选项与真正将要提交的可能不是同一份。现在重投会重新计时并回填已记录的答案
- **带前台期限（timed）的提问不再走飞书卡片**：它按自己的期限结算，卡片的 30 分钟窗口与它对不上，在卡片上答了也可能已被丢弃。现在这类提问直接交给 DSH Web UI 的倒计时处理
- **没有选项的多选题不再变成答不了的卡片**：卡片上没有任何可勾内容、而答案编码又不接受多选，等于无解。现在按可作答的自由文本题处理

### 变更

- **英文文档补齐 DSH 部分**：`docs/en/architecture/design.md` 补上直连与凭据签发、审批与提问转写、压缩能力声明；`docs/en/usage.md` 补 `manageProcess` / `dshHome` / `dshCommand` / `startTimeoutMs` / `permissionPreset` 五项配置说明，并纠正一处过期说法——原先写着 `token` 可以在 `/config` 卡片里编辑，实际该字段早已移出卡片
- **注释与发布条目整理**。无行为变化

## [0.5.5] - 2026-10-18

### 新增

- **`/config` 卡片可以切换 DSH 的 provider**：新增 `agents.dsh.provider`。卡片里的 provider 下拉取自 DSH 的实时目录（打开卡片时强制刷新，在 DSH 侧新增 provider 后不必重启 lark-remote）。切换 provider 不清空会话，下一次运行用新 provider 重新对齐；显式配置的 provider 不可用时运行直接失败，不会静默改用别的 provider。模型留空时用该 provider 的默认模型
- **DSH 支持压缩（Compact）**：运行卡片的压缩按钮对 DSH 生效，走 DSH 的命令通道、只在会话空闲时执行。按钮的渲染与执行改用同一份「该 agent 是否声明支持压缩」判据，不再出现能点下去但必然失败的按钮
- **DSH 权限预设与飞书审批转发**：新增 `agents.dsh.permissionPreset`（沙箱模式 + 审批策略），在会话首次运行前用 `/permission` 对齐一次；DSH 不提供该命令时运行 fail closed，不会带着用户没选的权限继续跑。运行期间的审批请求渲染成卡片底部的「允许一次 / 拒绝」，允许只对当次调用生效；旧版 DSH 没有应答通道时回退为「请到 DSH Web UI 处理」，回合保持存活
- **DSH 未运行时由 lark-remote 后台拉起**：探测不到 DSH Web Host 时自动以后台脱离方式启动 `dsh web`（默认最多等 30 秒端口就绪），lark-remote 退出或重启都不会停止它；已在运行则直接复用。设 `agents.dsh.manageProcess: false` 可改为只连接已在跑的实例，`dshHome` / `dshCommand` / `startTimeoutMs` 分别指定启动目录、可执行文件与等待上限

### 变更

- **DSH 凭据改为自动签发**：DSH 0.2.x 起接口要求认证。lark-remote 默认读取 DSH 的持久凭据文件（`$DSH_HOME/.credentials.yaml`，未设置 `DSH_HOME` 时为 `~/.dsh/.credentials.yaml`，文件权限必须是 `0600`），用其中的浏览器会话签名密钥现签一个短时效凭据，`dsh web` 重启后不需要再手动更新 token。`agents.dsh.token` 降级为凭据文件不可读时的 YAML 兜底，并且不再出现在 `/config` 卡片上——启动 token 每个进程随机生成、重启即换，写进飞书卡片既会过期又多余
- **opencode 会话读取适配 2.0**：会话列表与历史改用 2.0 的导出结构（同时保留 1.x 的读法），工具执行结果按新形态解析
- **DSH 配置卡片文案精简**：权限预设不再在卡片上堆长段说明

### 修复

- **第一条消息是图片/文件时不再被静默丢弃**：会话归属绑定只发生在文本消息入口，媒体入口此前只做只读检查。全新安装的用户第一条消息若是图片/文件，媒体下载被丢掉、绑定也永远完不成。现在文本与媒体走同一个授权入口
- **点停止后执行位不再被卡住**：DSH 会接受 HTTP 连接但可能永不返回（卡住的模型请求），运行协程于是停在等待处，`/stop` 和空闲超时都腾不出该工作目录的执行位。请求加上默认 60 秒超时并可取消
- **opencode 后台服务不可用时不再让卡片挂一小时**：2.0 的对话走共享后台进程，该进程不可用时以前没有任何提示，卡片要等完整的重试退避（约 1 小时）才结束。现在直接报错并给出 `opencode service restart` 的处置提示
- **审批应答发送失败时保留重试入口**：连接断开或进程退出导致应答没送达时，卡片此前静默停在可点状态，用户以为已经批准。现在写明失败原因并保留原按钮重试（应答成功才消费该次审批的一次性标识）
- **DSH「本 run」token 不再少算**：跑了多趟工具往返的回合只统计了最后一条用量，现在按回合汇总该回合内所有调用
- **运行结束的使用量归属本轮自己的会话**：回合中途 `/new` / `/resume` / `/cd` 会移动全局会话指针，收尾按全局指针读取用量会把别的会话的 token 记到这条运行上
- **中断后迟到的上一轮错误不再影响新一轮**：回合加了代际标识，回调落地前复核归属；同时清理了唤醒后遗留的兜底定时器，高频事件不再持续堆积
- **替换连接时先等旧连接销毁完成**：不再让两个 agent 服务进程重叠，同一会话不会被两个进程同时持有；陈旧实例锁的接管改为「原子改名 + 复核」两步，中间不再可能被第三个进程插入
- **恢复会话时不再错认前缀相同的会话 id**：文件名匹配从「包含子串」改为按 `<id>.jsonl` / `_<id>.jsonl` 结尾匹配，完整 id 的前缀或相似 id 不再命中；读取 DSH 会话内容也加上目录守卫，会话属于另一个工作目录时 fail closed
- **思考过程不再被换行切碎**：同一条思考的增量按字拼接，此前每段增量都插一个换行

## [0.5.4] - 2026-10-12

### 修复

- **codex「本 run」token 少算（多步运行只统计了最后一步）**：codex 每发起一次模型调用就记一条 token 用量，一个回合里有几趟工具往返就有几条，而运行结束卡片与 `/resume` 末尾统计此前只取最后一条。于是一个跑了 7 趟工具往返的回合，实际输出 3,648 个 token 只显示 679、未命中缓存的输入 3,022 只显示 212。现在按回合汇总该回合内所有调用的用量，与 codex 自己按回合统计的结果逐字段一致；「Context」仍显示最后一次调用的上下文窗口占用，累计用量与 `Total` 的取法不变。恢复会话时服务端可能重放上回合的用量，已按回合标识丢弃。更早的、不带回合标识的记录保持原读法

### 变更

- **测试注释与用例类型对齐**：一处用例注释改为不点名具体消息；两处 app-server 用例的类型写法与协议定义对齐（这些文件不在既有类型检查覆盖范围内，改动不影响运行时行为）。无行为变化

## [0.5.3] - 2026-10-12

### 修复

- **中断后紧接着发下一条消息，不再报 `thread already has an active writer`**：点停止打断正在运行的 codex 时，中断流程会把复用的运行实例从缓存摘掉并立即销毁连接，而队列链在这一步的等待窗口里就把下一条消息发了出去、并已取到同一个实例——那条运行的长驻连接于是挂在无人托管的实例上，`codex app-server` 进程要等空闲超时（默认 30 分钟）才回收，期间一直持有该会话的写锁，同一会话的下一次恢复因此被拒。现在中断只把实例标为「待替换」，统一由下一次运行收尾时回收，标过的实例不再返回缓存；被摘掉的实例也会在运行结束时主动关闭连接，不再挂 30 分钟的超时。逐条消息新建实例的 agent 不受影响，行为照旧

### 变更

- **注释里的运维数据与仓库外引用改为占位描述**。无行为变化

## [0.5.2] - 2026-10-11

### 修复

- **codex 运行结束卡片的 token 统计不再翻倍**：codex app-server 实时上报的输入 token 按协议口径已包含命中缓存的部分，而卡片契约要求它表示「未命中缓存的输入」。入口没做减法时，Input 会等于整个上下文用量、缓存占比的分母被重复计数、Total 再被「总量与分项之和取大」抬高一倍（实测同一轮 36 万显示成 72 万）。现在实时通知与 jsonl 兜底读取两条入口统一减掉缓存部分
- **压缩卡片的「压缩前」不再显示摘要调用自身的用量**：codex 把生成摘要那次调用自己的 token 记录写在压缩事件之前，此前「压缩前」取的是紧贴压缩事件的那一条，于是把摘要调用的消耗当成压缩前的上下文窗口（实测 36 万的窗口显示成 20 万）。现在按压缩事件自带的摘要调用用量回退一条，取压缩前最后一次真实窗口；更早的、不带该字段的数据保持原读法
- **排队卡片不再复述「你正在排队」**：占用执行位的是普通消息时，卡片仍写着「正在执行: 💬 消息」并附一句「消息将按顺序执行…」，这两行对用户没有新信息。现在只有可能挡住队列、需要用户归因的任务（Compact、命令）才自报身份；Compact 占用时仍额外说明压缩结束后会按顺序执行你的消息

### 变更

- **消除一处全量测试并发下的时序假红**：bash 退出清理用例在收到首个事件后立刻读取 shell 自己写入的 pid 文件，而重定向落盘可能晚于该事件，整套测试并发跑时会随机报文件不存在。改为与同一用例里另一处 pid 文件相同的有界等待。无行为变化

## [0.5.1] - 2026-10-09

### 修复

- **旧卡片上的 Compact 按钮点下去不再报「该任务已结束或不属于当前会话」**：Compact 按钮只带本轮 run 的标识，此前按「每个工作目录最新一条 run」反查会话，而 compact 动作走串行队列——排队期间后续 run 收尾会覆盖那一个槽位，旧卡片于是必然失效。现在每条 run 收尾时按自己的标识记下会话与 agent，按钮自证身份，排队多久都不失效；Compact 也改为按该 run 自己的目录反查，中途切过目录不会压错会话
- **同一会话的多条排队卡片不再互相顶掉**：队列条目此前复用飞书卡片的消息 id 当身份，同一会话里多条卡片撞同一个 key，先入队的那条被后面的覆盖、状态更新串到别的卡片上。改为每次入队铸造独立身份
- **排队卡片会说清「在等谁」**：Compact 与普通消息共用同一条串行队列，Compact 占着执行位时新消息卡片仍写「位置: 第 1 位 / 前面还有: 0 条」，看着像马上就能轮到自己。现在没有等待中的消息时头部改为「等待当前任务结束」、正文写明正在执行的是 Compact 并收起位置行；占用者是 Compact 时「⚡ 立即执行」在渲染层置灰、执行层再加一道守卫，「❌ 撤销」保持可用
- **codex 多 agent 会话不再把会话指针写坏**：codex app-server 会把子 agent 的开轮通知一起推过来，此前不判断归属，子线程的事件覆盖了本轮的线程标识，顶层会话指针被写成子线程标识——该值在会话索引里不是键，之后恢复会话报 `cannot resume an unloaded multi-agent v2 sub-agent`，`/restart` 也救不回来。现在通知按线程归属过滤；审批结算仍按请求标识走，子 agent 的审批照常可以回答
- **带 `dsh` 的卡片不再静默退回默认 agent**：agent 名单此前被手抄成多份并发生漂移，收敛为单一来源、校验由该名单派生，消除「用错 reader → 未找到 session」的静默降级

### 变更

- **消除两处宿主环境相关的测试假红**：宿主带上本机没有的 locale（macOS 常见的 `LC_ALL=C.UTF-8`）时，bash 每次启动都往 stderr 打 setlocale 警告，让输出断言随机变红，测试 setup 阶段现在剔掉该变量（保留 UTF-8 解析所需项）；JSON-RPC 退出计时用例的计时起点从进程启动改到收到 `initialize` 应答，慢速 Windows runner 上不再因启动耗时超过阈值而误红
- **英文架构文档补齐**：`docs/en/architecture/design.md` 增补与中文侧对应的五个章节，英中两侧不再不对称
- **注释与用例名整理**：让公开仓库里的引用都能落地。无行为变化

## [0.5.0] - 2026-10-07

### 新增

- **CI 增加 Windows 全量验证**：新增 `windows-latest` job（install → typecheck → test → build → `--version`/`--help` 冒烟）。此前只有 ubuntu job，被平台门控跳过的用例在 CI 里是盲区，win32 独有回归只能靠本地发现

### 修复

- **一次发多图/多文件不再只保存 1 个**：飞书客户端「一次选多图/多文件」会背靠背秒发成多条独立消息，SDK 层 600ms 去抖把它们合并成一条——只保留最后一条的 `messageId`，却把多条消息的附件求并集。下载侧于是拿同一个 `messageId` 去下所有文件，除最后一条外全部报 234003（HTTP 400）。现关掉 SDK 这层合批（`chatQueue` 串行与卡片动作通道保留），合批交回项目自身的合并窗口
- **Windows 上会话偶尔「消失」**：按工作目录查会话时，大小写/分隔符/尾斜杠的归一不统一，`C:\Work` 与 `c:/work/` 被当成两个目录，`/resume` 列表会漏列。现统一走同一套判等键
- **Windows 上含 `<>:"|?*` 或尾点的文件名落盘失败**：入站附件名现在会剥掉 win32 非法字符与尾部点/空格（win32 会静默剥离它们，导致落盘名与记录名不一致）
- **Windows 上可能误杀其他工作目录的 agent**：pid 文件名此前只按消毒后的目录名区分，`/w/a+b` 与 `/w/a_b` 会撞同一个文件，启动时的孤儿回收可能杀掉对方工作目录里存活的 agent。现后缀掺入原始目录的哈希
- **`~` 开头的配置目录在 Windows 上不展开**：`~\` 形式此前不识别

### 变更

- **注释与测试命名整理**：让公开仓库里的引用都能落地。无行为变化

## [0.4.5] - 2026-10-07

### 修复

- **消息不再漂移到新会话**：紧跟在文字消息之后点击「新会话」「切换工作目录」「继续会话」等会变更会话的卡片按钮时，此前消息可能落到新会话里执行。现在这类卡片动作会先等消息合并窗口落地（消息仍绑定旧会话/旧目录），再执行动作；同时入队时刻固定会话代际，堵住「已开新会话后又被旧消息把旧会话复活」的漏判

### 变更

- **内部清理重构**：删除生产死代码与重复测试脚手架，统一内部命名，无行为变化

## [0.4.4] - 2026-10-04

### 修复

- **opencode 的工具卡片能显示完整命令了**：opencode 的 ACP 在参数流式阶段先发 `tool_call`（参数为空、标题只回落成工具名），真正的命令/路径随后由 `tool_call_update` 携带。此前卡片只显示 `Bash` 看不到执行了什么；现在按调用 id 原地回填参数，命令与路径正常展示。顺带修掉同一命令被重复渲染成 `ls — ls` 的摘要去重问题
- **思考内容的省略计数不再虚增**：增量刷新时，旧逻辑把「前 N 字符已省略」标记自身的文本也计进被丢弃的正文，每帧约虚增 14 字符。现在只累计真实丢弃的正文，显示量始终不超过上限

### 变更

- **`!` 命令失败用例去掉宿主 locale 依赖**：原先匹配 stderr 文案（`command not found`），中文 locale 下 bash 输出「未找到命令」导致用例稳定误红。改为断言确定性信号——命令名回显、非零退出码、诊断块呈现

## [0.4.3] - 2026-09-24

### 新增

- **富文本消息的顶层附件也能落盘了**：`@larksuite/channel` 从 `0.3.0` 升到 `0.7.1`。富文本（`post`）消息在**正文之外**的顶层附件区（`<file key=… name=…/>`，文件夹为 `<folder …/>`）此前不产出资源、会被当噪声丢掉；现在按序号识别并保存到当前工作目录，附件绝对路径照常写进 agent 提示词。往群里发一条「正文 + PDF」的富文本消息，agent 拿到的和普通文件消息一致（文件夹不产资源，只保留正文）
- **Windows 上收摊改走协议通道**：进程终止不再依赖跨进程 `SIGTERM`（win32 上本就不可靠），各 runner 统一登记「协议停止请求」，由 agent 自己响应后退出

### 修复

- **审批重投不再永不过期**：同一个 `requestId` 被重复投递时重新计时，并保证一个 requestId 最多只有一条待触发计时器。此前重投会留下两条计时器——要么审批永远等不到超时（server 无限等待），要么旧计时器提前把新窗口咬掉
- **Windows 防休眠此前从未生效**：`SetThreadExecutionState` 的 flags 因 Int32 溢出被截断，脚本一直静默失败。现按无符号 32 位、以十进制字面量传参，并把非终止错误升级为终止错误，让失败能落到告警分支而不是无声无息
- **资源下载超时不再静默**：超时只停止等待，底层下载照跑，晚到的结果由回调补做清理——避免「界面说超时、文件其实落了盘却没人管」
- **租户 token 失效会自动恢复**：识别 `tenant_access_token` 失效（飞书业务码 `99991663` 与 HTTP 401）并刷新后重试，不再让整条消息处理链失败
- **卡片 patch 失败不再成为无人接的 rejection**：流式卡片的 patch 由 throttle 触发、脱离 await 链（`Throttle.fireSoon` 丢掉 promise），业务码异常时改为记 warn 并原样透传返回值；需要抛出的场景收敛到带 await 的更新入口

### 变更

- **平台能力收口**：进程终止统一走 `Terminator` 抽象（删除 `ProcessStopper` 兼容壳），路径、进程身份、休眠能力按平台各自实现
- **claude 权限模式取值口径修正**：`permissionMode` 的 `default` 表示**省略该参数**（不是 CLI 的取值），与其他 agent 的配置语义对齐
- **测试套件平台无关化**：消除用例与 fixture 对宿主平台的隐性依赖（Windows 上全量失败从 25 条降到 0）；同步 CLI 探测通道短路，不再依赖本机装了哪些 agent CLI
- **测试临时目录统一自清**：文件级钩子 + 全局兜底清扫，消除 `%TEMP%` 泄漏，被强杀或超时的场景也能收拾干净

## [0.4.2] - 2026-09-19

### 新增

- **`/ws` `/ls` 列表卡关键词搜索**：两张列表卡各多出一行搜索输入框，输入关键词后**按回车提交**即可筛选。`/ws` 匹配别名或完整路径，`/ls` 只匹配**当前层**条目名（不递归子目录），均大小写不敏感、子串包含；计数与页码一律按过滤后的结果计算。筛选词不落服务端（只随卡片回调 payload 传递，且仅非空时注入），服务端保持零状态，未筛选时的卡片形态与旧版完全一致。筛选态下翻页/刷新/排序/使用/删除会保留关键词，进入其他目录或切换工作目录则清除筛选（换目录后旧关键词没有意义）

### 修复

- **卡片提交指引不再写「点 ✓」**：飞书移动端的 `input` 组件没有提交图标，只有键盘的回车/完成键（真机反馈）。所有用户可见文案统一为「按回车提交」，包括分页页码跳转、别名编辑、指令文本编辑与审批卡的修改意见
- **取消筛选改走显式按钮**：「清空输入再回车」在部分客户端不会触发回调（官方文档未承诺空串会发回调），实测清空后回车没有反应。现在筛选态下搜索行右侧会出现**「清除筛选」**按钮，走显式标记强制清除，不再依赖「读不到输入值」这一隐式条件
- **别名编辑卡不再把「留空提交」当删除入口**：同一处隐式条件问题，删除别名统一走列表卡别名旁的 ✕

### 变更

- 卡片布局文档（中英）补齐 CardKit `input` 的三条约束：没有逐键回调所以「边输边过滤」做不到、文案不写「点 ✓」、取消语义要有显式控件；`design.md` 中「input 提交图标」的表述改为「input 提交回传」（图标只是桌面端的一种触发方式）
- 英文文档补齐 `/ws` `/ls` 关键词搜索：`README.en.md` 与 `docs/en/usage.md` 的命令表和功能段跟上中文口径

## [0.4.1] - 2026-09-18

### 新增

- **入站消息统一处理（图 + 文合并为一个回合）**：图片、文件、视频、语音、表情、富文本内嵌图一律自动保存到当前工作目录（`.lark-remote-temp/<时间目录>/`），附件绝对路径**自动写进 agent 的提示词**，不再需要你把"文件已保存"提示卡整段转述给 agent。同一静默期窗口（700 毫秒）内到达的文字与附件合并成一个回合：先发图再发文字、先发文字再发图，agent 拿到的内容完全相同
- **附件按种类命名**：视频/语音/表情保留原文件名；无原名时按 MIME 类型或文件头自动补扩展名（`.mp4` / `.opus` / `.gif` 等）
- **不支持消息类型明确回执**：卡片、位置、投票、日程、合并转发等拿不到内容的消息，回一条"暂不支持"提示，不再把占位符静默塞给 agent；纯附件无文字时只回执"已保存 N 个文件" + 引导语，不自动起回合（避免误耗 token）
- **`--advance-help` 高级配置参考**：命令行可输出高级配置项说明
- **OpenCode 配置卡支持回合空闲超时**：`turnIdleTimeoutMinutes`（默认 30 分钟，0 关闭），回合长时间无输出自动结束

### 修复

- **P0：以图片占位符开头的消息被误当 shell 命令执行**：飞书会把"图片 + 文字"合成富文本，图片被渲染成 `![image](…)` 后首字符恰好是 `!`，命中 `!` 命令判定，整段用户消息被送进 shell 执行。现在命令识别有前置条件：仅当消息是纯文本、剥离结构占位符后仍以 `/` 或 `!` 开头时才按命令处理，其余一律按文本转发

### 变更

- `inboundMedia.maxFileSizeMb` 默认值 50 → **100 MB**（更大的飞书文件需要分片下载，SDK 不支持，超限提示里已写明）

## [0.4.0] - 2026-09-15

### 新增

- **运行期间阻止系统休眠**：运行中自动阻止系统休眠（macOS 用 `caffeinate`、Windows 用 `SetThreadExecutionState`）——典型用法是人不在电脑前远程使用，系统一旦休眠连接即断。只阻止系统休眠，不影响显示器睡眠；退出（含异常退出）后自动解除，helper 意外退出也会留痕兜底。注意：MacBook 合盖睡眠无法阻止（除非接电源并外接显示器）
- **入站媒体保存提示带完整路径**：收到的图片/文件落盘后，提示带目录完整路径，方便直接定位

### 修复

- **卡片更新瞬态失败自动重试**：飞书卡片更新遇到连接瞬时中断等瞬态传输错误时就地重试（最多 3 次），不再把失败直接落到未处理 rejection 上导致进程退出
- **Kimi 审批卡恢复完整 Bash 命令**：审批卡片按 `toolCallId` 关联流式参数，恢复展示完整命令而非截断片段
- **Kimi 权限模式文案对齐 kimi 0.40+ 语义**：`yolo` 现指「必要时询问」而非完全放行，完全自动请选 `auto`；README 与配置文档同步更新

### 变更

- **文档自称统一**：README、使用文档与架构文档中的自称统一为 lark-remote

## [0.3.0] - 2026-09-13

### 新增

- **`/clone [name]`（复制分身）**：把当前配置目录克隆为一份新分身（`<configDir>-<name>`，省略名字时随机生成后缀；除飞书 `appId`/`appSecret` 外全部复制），引导你扫码创建全新飞书应用——二维码以图片消息直接发进私聊，约 10 分钟内有效。扫码成功后自动完成绑定并把 workspace 别名、常用指令、工作目录与会话状态一并同步到分身，随后自动拉起新实例（新应用会收到它的启动通知），原应用回执新应用 App ID、配置目录与进程号。等待扫码期间消息不转发给 agent：输入「重发」重新生成二维码，`/Q` 取消。`/help` 卡片的「/clone」按钮可直接点击开始
- **一键复制分身按钮**：`/help` 卡片按钮区新增「/clone」，与无参 `/clone` 等价

### 变更

- **首次绑定简化**：未绑定时首条私聊消息（任意内容）即完成 owner 绑定，移除原 4 位 PIN。飞书自建应用私聊入口本身由 owner 掌控，把应用分享出去才属主动行为；绑定成功会回执确认

### 修复

- **Codex / Kimi CLI 版本探测走平台 spawn 收口**：CLI 可执行文件探测统一经由跨平台 spawn 层，修复 Windows 下的探测兼容性问题
- **`bun run test:live` 退出码**：在 `bun run` 下正确透传退出码，不再误报失败

## [0.2.2] - 2026-09-12

### 修复

- **Windows `!` 命令修复**：解析 `bash` 时跳过 `system32` / `SysWOW64` 下的 WSL 启动器（那不是 Git Bash），并从 PATH 中的 `Git\cmd` 目录反推 `Git\bin\bash.exe` / `Git\usr\bin\bash.exe`；修复 `!` 命令被整条丢进 WSL 执行后因旧版 Node 解析不了新语法而报 `SyntaxError` 的问题
- **`lark-remote update` 不再被运行中的实例阻塞**：裸子命令 `update` / `version` / `help` 现在与 `--update` / `--version` / `--help` 等价；此前裸 `update` 会被当作位置参数落进守护进程路径去抢单例锁，被运行中的实例以 "already running" 挡下

### 变更

- **移除 `/reconnect` 命令**：路由分发、`/help` 按钮、Bridge 与 FeishuConnector 的重连实现及文档一并删除；重连需求已由 `/restart` 覆盖
- **消息合并提示**：飞书把极短间隔连发的多条消息合并成一条时，首行命令之后若还有以 `/` 开头的整行，会在执行第一条命令的同时提示被忽略的原始内容，不再静默丢弃
- **旧 Node 运行时友好化**：`dist/cli.js` 作为入口保持极旧 Node 可解析（避免 `??` / `?.` 语法），版本检查在加载应用模块图前由 preflight 处理；Node < 18 时给出明确的人话报错而非解析错误

## [0.2.1] - 2026-09-11

### 新增

- **Windows 正式支持**：原生 Windows 支持已在真机完成验证，README / getting-started 的平台前置条件从「macOS / Linux，暂不支持 Windows」更新为 macOS / Linux / Windows 10+

### 变更

- **安全文档措辞更新**：README 安全警告与 `SECURITY.md` 反映 Claude 审批模式——`permissionMode` 可配置（默认 `bypassPermissions`，配置为其他值即启用飞书卡片交互式审批），不再表述为「固定 bypassPermissions」；审批卡片描述从 Codex 专属改为 Claude / Codex / Kimi 通用

## [0.2.0] - 2026-09-11

### 新增

- **Windows 平台支持（预发布）**：新增跨平台平台层（`src/platform/`）——路径、可执行文件发现、进程终止、spawn、shell 的抽象与 posix / win32 双实现；命令拉起统一走 `cross-spawn`，posix 行为零变化。Windows 尚未正式发布，README 前置条件已相应标注
- **`/download <path>`（别名 `/d`）**：把本地文件直接发到会话，不经 `/ls` 卡片。路径规则同 `/ls`（`~` 展开、相对 cwd、30MB 上限），目录 / 不存在 / 超限给出明确错误
- **`/ls <file>` 单文件卡**：传入文件路径渲染单文件卡（完整路径、大小、修改时间、「📎 下载」+「上级」按钮），不再报 `ls: xxx: Not a directory`
- **分页栏页码跳转**：所有分页卡片（`/ls`、`/ws`、`/resume`、`/active`、`/order`）支持在分页栏输入页码直达；越界钳到末页，非数字输入报错且不刷新卡片
- **扫码向导跨平台**：二维码渲染改用 `qrcode-generator`，Windows 全块渲染 + 静区 + 图片兜底

### 修复

- `/ls` 的「返回」改为回到浏览起点（`/ls <dir>` 指定的目录），不再跳回 workspace cwd；浏览起点随卡片 payload 传递，翻页 / 刷新 / 上级 / 目录按钮不会丢失
- codex 会话兼容 rollout ≥0.153.4 的 `item_completed` 词表，修复 `/resume` 标题丢失
- compact 卡片空内容渲染「Compact 完成」，不再显示通用空占位
- 信息保真：notices 改为时间线消息渲染、省略提示固定置顶、工具卡片消除孤立代理项
- Windows：隐藏 cmd.exe 控制台窗口（`windowsHide`）

### 变更

- **移除 `output.showThinking` / `showToolUse` / `showToolResult` 配置项与 `/config` 的「📤 输出」页签**：thinking、工具调用与工具结果恒常展示；旧配置文件的 `output` 段在加载时自动忽略，并在下次保存时从磁盘清理
- 代码精简：ACP / translator / session 共享层下沉（`BaseAcpTranslator` / `BaseAcpRunner` / two-pass 扫描），死代码清理与平行重复收敛
- 依赖：`qrcode-terminal` 换为 `qrcode-generator`；新增 `cross-spawn`（Windows 命令拉起）
- 测试基建：新增 scoped typecheck（`tsconfig.test-infra.json`）覆盖 `tests/lib/**` 共享工厂；跨平台测试稳定化（win32 路径归一化、并行 vitest 内存上限）

## [0.1.13] - 2026-09-04

### 修复

- kimi ACP Compact 等待机制重构：等待协议终态（complete / cancel / unknown）再收尾，移除「30s 超时即视为成功」的假完成路径——Compact 实际失败或被取消时如实反馈

### 变更

- 代码与测试清理：死导出/死字段清理、bridge usage 统计收敛、router 样板收敛、session 公共件下沉（`ttl-cache` / `recency`）、ACP 共享层下沉
- 测试治理：超大测试文件按主题拆分、agent choices 测试表驱动化、弱断言收敛、移除无效测试
- 移除未使用的 `@types/form-data` 依赖

## [0.1.12] - 2026-08-29

### 修复

- opencode ACP stream error 实时上报：tail opencode 日志即时捕获错误行，配额类错误秒级报错，不再挂起卡片等待超时

### 变更

- codex 会话历史读取轻量化：长会话生成轻量摘要，模型目录异步加载，减少启动阻塞
- CI 覆盖率门禁纳入 `src/index.ts`，覆盖率统计更完整

## [0.1.11] - 2026-08-24

### 新增

- kimi ACP 支持 Bash 命令自主执行：`terminal/*` reverse RPC 将 Bash 工具下放到本地子进程（一次性 `bash -c <script>`），yolo/auto 模式自主跑命令，manual 模式仍走审批；run 卡片显示带真实命令与本地输出的 Bash 面板，并过滤 kimi 自产的双份 Bash 通知

### 变更

- kimi ACP 能力声明：`fs` 保持关闭（走本地磁盘兜底，避免未实现的 `fs/*` RPC 报 `METHOD_NOT_FOUND`），`terminal` 打开

## [0.1.10] - 2026-08-22

### 新增

- `/order` 卡片指令文本编辑：卡片「编辑」按钮弹出输入框原地修改（保留别名/使用统计/创建时间），CLI `/order edit <orderId|序号> <新文本>` 备选入口；长度上限 200 字符、空白提交报错、文本未变化短路写盘

### 修复

- cardAction 直返白名单补齐：`order.textInput` 与 `approval.planFeedback` 不再被 fire-and-forget 的 `enqueueImmediate` 吞掉返回值（编辑卡停留编辑界面 / 计划审批意见 toast 消失）
- DSH `selectModel` 写放大：`session.selectModel`（会写服务端全局默认）改为每 session 首次 run 对齐一次，不再每次 run 重复写；启动期 `/stop` 会取消刚创建的 session 并产出 `interrupted` 终态而非静默返回
- order 末页删空守卫：删除末页唯一指令后 `offset` 回退到非空页（不再出现空白卡）
- 计划审批意见门控：仅 `ExitPlanMode` 工具审批接受修改意见，其他审批类型拒绝
- 计划文件跨 run 重置：`doStartProcess` 清空会话内追踪的计划文件，避免旧计划被 `resolvePlanContent` 误读
- finalizeRun fallback 卡按 `compactSupported` 门控 Compact 按钮（无 `runCompact` 能力的 agent 不再渲染死按钮）

### 变更

- ESLint 告警清零（0 errors 0 warnings）
- 注释与文档同步 DSH 接入（"5 个 agent"→"6 个 agent"）

## [0.1.9] - 2026-08-20

### 新增

- ExitPlanMode 计划审批：计划全文折叠展示 + 五决策对齐 TUI（自动放行 / 附意见 / 采纳修改）
- 卡片别名管理重构：`alias-store` 并入 `alias-resolve`，`/order` 卡片新增「＋别名」交互（绑定/修改/删除，已绑定指令显示 `$name` 标签 + ✕）
- DSH / connection-based runner 启动 / 配置热更 / 失败路径修复

### 变更

- 别名 API 由「触发词 → 文本」改为「指令 → 别名」：`/order alias add <orderId|序号> <别名>` 绑定、`/order alias rm` 移除；别名随指令持久化在 `orders.json`，删除指令时别名一并删除；名称不能为保留子命令、不能数字开头
- 用户文档同步别名卡片化交互，移除 `/order alias <name> <text>` 旧用法

### 修复

- 别名卡片成功回调：携带 `card` 替换 pre-click 卡，删除文案对齐新交互
- kimi ACP runner 模型下发：迁移到纯 ACP 后 `session/set_config_option` 必须紧跟 `session/new|resume` 下发，否则实际跑的是默认模型

## [0.1.8] - 2026-08-19

### 新增

- DSH（DeepSeek Harness）Agent 接入：纯 HTTP 连接 DSH Web Host（无本地子进程），支持会话创建/续跑、`selectModel` 模型对齐、SSE mux 事件订阅、会话历史读取
- `/config` DSH 配置卡：Host 地址 / 会话 preset / 模型 / 推理强度，模型与预设目录预取动态加载（失败回退固定兜底清单）
- AskUserQuestion 公共契约（`question-common`）：标准提问审批事件工厂 + 按序答案映射，claude / codex / kimi / pi 统一接入
- Codex AskUserQuestion：支持自由文本题、补充说明（user_note）、`autoResolutionMs` 透传为单请求审批超时
- Kimi elicitation 表单回编 + request_permission 兜底桥
- 工具权限审批卡（`kind === 'tool'`）：ExitPlanMode 等非命令工具展示工具名 + 用途说明，计划审批语义
- 提问卡单选/多选图标区分（⚪/🔵 vs ⬜/☑️）、自由文本题输入框、自定义答案回显

### 变更

- claude session usage 扫描对齐 codex 语义：非累计字段为末轮（本 run）scope，累计走 `cumulative*` 字段
- Compact 按钮能力门控放开到所有 `runCompact` 能力 runner（claude / codex / kimi / opencode / pi）
- claude `/config` 权限模式下拉排除 `manual`（`default` 的别名，避免等价重复项）
- workspace 保存即触达：`save` 内部调用 `touch`，新保存的工作区排在列表最前
- DSH 可用性探测跳过二进制检查（HTTP-only Agent）

### 修复

- claude session usage 扫描：修复第三方网关（如 DeepSeek）将零 usage 写在占位行、真实 usage 只在末行导致的 per-run 统计全 0（改为按 message id 逐字段 max 聚合）
- 审批答案重复投递（重复 nonce 二次点击）改为中性提示，不再误报"提交失败"
- usage 统计一致性护栏：本 run 超出累计时显式标记 `⚠️ 累计异常`（只标记不修正，便于排查数据源问题）

## [0.1.7] - 2026-08-18

### 新增

- pi RPC 模式 runner：通过持久连接复用共享 `ConnectionManager`，支持审批与上下文压缩
- kimi / opencode ACP 模式 runner：纯 ACP 持久连接，支持审批 + Compact
- 共享 ACP / JSON-RPC 连接层（`runner/common/acp`、`runner/common/jsonrpc`）：统一 codex / kimi / opencode / pi 的连接管理
- 入站图片/文件自动落盘：往飞书私聊发图片/文件自动保存到 `.lark-remote-temp/`，可直接让 agent 处理
- `/order alias`：注册快捷别名，输入 `$name` 即展开
- 会话分页/截断共享辅助模块（`session/common/pagination`）
- Codex 命令审批卡片示例图

### 变更

- codex runner 统一走 app-server 审批模式；移除 codex/kimi/opencode/pi 的 exec/jsonl 旧模式与死代码
- `codex-bundled-test-helpers` 迁移至 `tests/lib/`
- 用户文档：新增入站文件、`/order alias`、kimi acp 配置说明

### 修复

- 修复文档引用指向被排除的本地文档导致的破链

## [0.1.6] - 2026-08-14

### 新增

- Codex App Server 集成：通过 stdio JSON-RPC 持久连接 Codex CLI，支持审批流（文件读写/命令执行）、Compact 上下文压缩、空闲超时自动断开
- Approval 审批系统：`approval-coordinator` 协调超时/取消/回复，`approval-render` 渲染审批按钮卡片
- Codex runner 工厂：自动选择直连模式或 App Server 模式
- `rollout-reader`：Codex App Server rollout 开关读取
- Run card 审批区域渲染 + context limit 百分比显示
- 架构文档：`docs/zh/guides/codex-config.md`

### 修复

- `/update` 命令移除自动重启逻辑
- Codex 配置枚举回归官方标准值

## [0.1.5] - 2026-08-14

### 新增

- `/update` / `/update check` 命令：检查 npm registry 最新版本并一键升级，升级后自动重启 bridge；开发模式（`--dev`）下自动拒绝自更新
- `--update` CLI 参数：非交互式升级（适用于 cron / 脚本自动化），升级后退出
- `checkUpdateOnStartup` 配置项：启动时静默检查版本更新并推送提示（默认关闭）
- 纯内存 session index（`session-index.ts`）：替代旧的 `readCwdFromJsonl`，完整 `cwdSet` 支持 EnterWorktree 连续搬迁 A→B→C 场景
- `verify-test-classification.ts` 脚本：测试分类校验工具

### 修复

- `/ws`、`/order` 卡片分页从 5 条/页调整为 15 条/页，修复飞书 ErrCode 11310 元素超限
- CLI `--dev` 帮助文本内部术语"看门狗"替换为用户可理解的"空闲超时自动停止"

### 变更

- 移除 husky / lint-staged pre-commit 和 pre-push 钩子及相关 devDependencies
- `sessions.ts` 重构：迁移到 `SessionIndex` + `parseSessionJsonl`，移除 `readCwdFromJsonl`

## [0.1.4] - 2026-08-13

### 新增

- 工作区列表支持 `lastUsedAt` 排序，最近使用的 workspace 排在前面；排序切换 UI 移至卡片上方，明确显示当前模式与切换目标
- `/config` 卡片：未安装的 Coding Agent 沉底排序，已安装 agent 保持注册顺序；探测结果过期（`undefined`）时保持原位不误沉底

### 修复

- `/ws`、`/order` 卡片分页降为 15 条/页，修复飞书 ErrCode 11310 元素超限
- workspace 排序相关 P2/P3 review findings 修复

## [0.1.3] - 2026-08-12

### 新增

- Agent 可用性探测：启动时自动检测本机已安装/可用的 Agent CLI（`which` 探测），不可用的 Agent 会在 `/config` 卡片中标注；探测失败不阻塞启动，打开 `/config` 时会重试
- 首次运行引导：PIN 绑定成功后自动设置默认工作目录，并发送欢迎卡片 + 帮助卡片
- `message.patch` 业务码可观测性探针
- Context 统计支持显示占比：codex 上报 `context window` 上限时，卡片按百分比展示上下文用量

### 修复

- `displayTitle`/`summary` 跳过 task-notification 注入
- 修复 `scanClaudeSessions` 对迁移到其他目录的会话的遗漏（S2）
- 修复 probe 生命周期、工厂回退、卡片回调等评审发现的问题（F1-F8）

### 变更

- 提取 `createAgentRegistries` 工厂，统一各 Agent 注册逻辑
- 移除 Agent 二进制路径配置，CLI 名称改为硬编码
- 移除 `pnpm-lock.yaml`，统一使用 `bun.lock` 管理依赖
- 新增 husky lint-staged pre-commit / pre-push 钩子（提交前 lint + typecheck）
- 启用 npm provenance（构建产物可溯源）

### 测试

- 合并 stub 工厂、净化 fixtures、移除冗余测试
- 新增 configContainer 锚点测试（含 codex 负向断言）

## [0.1.2] - 2026-08-10

### 修复

- claude / opencode / kimi 的 Agent 工厂改为从 `configContainer` 读取配置，避免使用过期闭包导致配置不生效
- codex / kimi 的 `readSessionContent` 增加 cwd 校验，防止越界读取会话
- `listClaudeSessions` / `isClaudeSessionActive` 支持跨目录回退，处理会话迁移后的定位
- 修复 `handleQueueInput` 竞态：替换任务在 await 之前注册
- 完成卡片 `resume.use` 携带 agent 字段，确保会话 reader 路由正确

### 维护

- 升级 `@vitest/coverage-v8` 至 4.1.10
- 移除 CLI 子进程 smoke test，清理测试套件

## [0.1.1] - 2026-08-09

版本号 0.1.0 → 0.1.1，无用户可见功能变更。

## [0.1.0] - 2026-08-06

Initial release.

### Added

- Feishu private-chat ↔ local coding agent bridge (Claude Code / Codex / opencode / pi / Kimi)
- CardKit 2.0 single-card streaming: one card per run, updated in place via `im.v1.message.patch`
- Run card: thinking, text, tool summaries; terminal states (done/error/interrupted/idle_timeout/finalizing)
- Bash card: `!<cmd>` executes bash with streaming card output (bypasses serial queue)
- Serial work queue + stop control lane for concurrency safety
- 5 agent runners with JSONL/NDJSON parsing, lifecycle management, and orphan process handling
- 5 session readers with unified contract (`listSessions`/`readSessionContent`)
- `/config` interactive card (agent-aware): switch agent, model, reasoning effort, idle watchdog
- `/order` global prompt storage with `order.exec` dispatch
- `/resume` paginated session list with per-agent filtering
- `/active` in-memory dashboard of running sessions
- `/cd`, `/ls` (paginated file browser), `/ws` (workspace aliases)
- `/restart` in-place self-restart with process handoff
- `/stop` immediate SIGKILL; stop button on run cards
- QR-code scan-to-create wizard for first-time Feishu app setup
- Single-instance lock per config directory
- Startup notification to most recent private chat
- Session persistence across bridge restarts (`last-session.json`)
- Agent switch session restore with `previousSessions`/`arrivalSessions` dual-field design
- Idle watchdog with configurable timeout
- Run card progressive degradation under 28KB budget (text > thinking > tools)
- 28KB+ budget enforcement using `Buffer.byteLength` (UTF-8)
- Dedup TTL workaround for SDK `safety.dedup` toggle button issue
- `classifyRejection` for SDK throttle/detach rejection (recoverable 4xx → log only)
- `SpawnHeartbeat` for spawn-stage stall detection (30s, log-only)
- Atomic file writes (tmp + rename, EXDEV fallback)
- Daily log rotation (file-only, no stdout)
- Node.js 20+ compatible (zero Bun runtime APIs in src/)
- Bilingual documentation (Chinese + English)
- MIT License

### Security

- Full-permission agent execution (hardcoded `bypassPermissions`/`approval_policy=never`)
- Designed for single-user p2p private chat only — never add bot to group chats
- Credentials stored locally in `config.yaml`, never committed to repository
- Live Feishu API tests gated behind `FEISHU_LIVE_TEST=1` (external contributors can run full test suite without credentials)

[0.1.0]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.0
[0.1.1]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.1
[0.1.2]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.2
[0.1.3]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.3
[0.1.4]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.4
[0.1.5]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.5
[0.1.6]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.6
[0.1.7]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.7
[0.1.8]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.1.8
[0.2.1]: https://github.com/bungabungawoda/lark-remote/releases/tag/v0.2.1
