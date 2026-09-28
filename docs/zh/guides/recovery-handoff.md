# 异常恢复交接

## 范围与约束

Pi、Codex、Claude remote 桥共用恢复交接逻辑，不复制完整 transcript，
不自动重放已经执行过的工具，不把任务流水写入 MemOS 长期事实层。
用户下一条普通消息触发接续；不在失败后自动重复执行原任务。
独立 CLI 可以从交接文件或 ai-memory 的确切作用域读取记录；本功能不改写 CLI hooks。

交接包含旧 session ID、原始记录路径（找不到则明确标记）、工作目录、
模型、失败类型、最近成功回合标识、失败回合的用户请求与有界输出摘录。
摘录是未经验证的历史资料，不是执行授权或“测试通过”的证明。

## 状态

1. 每个成功回合更新有界本地 checkpoint。
2. 上下文超限、其他错误、无 result 的流结束和 watchdog 超时保存 pending 交接。
   用户停止或审批拒绝不触发自动恢复。
3. 上下文超限时，下一条普通消息使用新 session；其他失败优先恢复原 session。
4. 只有匹配旧 session 或同一恢复链的 session 才注入交接。
   `/new`、切目录或切到无关 session 不得自动带入旧任务。
5. 新 session ID 一旦出现即保存到恢复链；成功结束才消费 pending。
   启动/接续失败保留 pending，重启可重试，不丢旧 transcript。

## 持久化与 ai-memory

本地文件在 `<configDir>/recovery/`，目录 0700、文件 0600。
key 包含 bridge 配置目录、用户、cwd、agent；不跨用户/项目/agent 取“最近一个”。
ai-memory 使用独立 workspace `remote-recovery` 和哈希 project，
仅调用 `memory_handoff_begin/list/accept`，不抢占普通 SessionStart handoff。
通过摘要内稳定 recovery ID 做去重，按确切 handoff ID 确认。
调用有超时、响应大小上限；服务故障不阻塞正常任务或删除本地记录。
正文不上传原始用户请求、工具输出、凭据或 transcript 内容，仅上传恢复定位信息。

## 验收

- 三个 agent 均覆盖超限、进程/连接故障、成功确认与连续失败。
- 新会话接续时保留原 session、路径与成功 checkpoint。
- 普通 HTTP 400 不误判成上下文超限。
- 不同用户、目录、agent、bridge 实例不串交接。
- spawn 失败、重启、用户 `/new`、并行切 session 不丢记录或覆盖新指针。
- ai-memory 离线/超时/错误返回、本地写失败不会误报交接成功。
- 不以低 token 冒烟替代真实长任务验收。
