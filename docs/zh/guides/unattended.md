# 无人值守长任务

在实例的 `config.yaml` 顶层设置 `unattended: true`，重建并在空闲时重启该实例。
默认关闭，不改变其他实例的交互行为。不修改全局 Claude/Codex/Pi 设置。

- Claude 禁用 AskUserQuestion、EnterPlanMode、ExitPlanMode，传入
  `--permission-prompts none`。旧客户端仍发出的 control_request 只拒绝，
  不创建审批卡，不进入五分钟审批超时杀进程路径。
- Codex 在 thread/start 和 thread/resume 关闭
  `features.default_mode_request_user_input`。残余提问返回空 answers，不伪造
  用户选择；残余权限请求拒绝而不是自动授予。
- Pi 保留配置里的工具白名单，普通 prompt 附加长任务执行约定。
- 三者都要求完成实施与验证、保存进度、尊重用户限制、如实报告外部阻塞。
  slash 命令原样传递。没有自动无限续轮、额外预算或“忽略所有拒绝”的机制。

权限仍独立配置：Claude 使用 `claude.permissionMode: bypassPermissions`；
Codex 使用 `agents.codex.approvalPolicy: never` 和
`agents.codex.sandbox: danger-full-access`；Pi 使用
`read,bash,edit,write,grep,find,ls`。这些设置不授予 root 权限，不绕过文件
所有权、只读挂载、组织策略或用户明确禁令。

保留 `idle.watchdogMinutes: 15`。这是无事件超时，不是任务总时长限制。
30 分钟会话空闲回收仅在 turn 结束后适用。无人值守不保证模型永不 end_turn；
真正的长期自主执行需要另行设计有验收条件、预算和终止条件的任务调度器。

验证边界：mock 测试覆盖无交互响应、会话复用、权限参数和提示传递；
真实 CLI 探针单独验证能力；真实飞书消息往返仍需对应实例的实际消息。
