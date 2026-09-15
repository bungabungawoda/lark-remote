# Security Policy / 安全策略

[English](#english) | [简体中文](#简体中文)

---

## English

### ⚠️ Important: Agent Permissions

lark-remote runs coding agents with their **configured** permission mode. The default Claude configuration is `bypassPermissions` — full permissions, no approval prompts. Approval modes are available and are the safer choice:

- **Claude**: setting `permissionMode` to anything other than `bypassPermissions` (`default` / `acceptEdits` / `auto` / `dontAsk` / `plan`) enables interactive approval — high-risk actions wait for confirmation on the Feishu card.
- **Codex**: defaults to app-server approval mode (`approvalPolicy=on-request`, `workspace-write` sandbox).
- **Kimi**: defaults to `manual` (per-action approval).

Regardless of mode, lark-remote is intended for **single-user, private-chat (p2p) use only**. Never add the bot to group chats.

### Reporting a Vulnerability

If you discover a security vulnerability, please report it privately:

- **GitHub Security Advisory**: [Report a vulnerability](https://github.com/bungabungawoda/lark-remote/security/advisories/new)
- **Email**: Create a GitHub issue marked as "Security" and we will provide a secure contact

Please **do not** file public issues for security vulnerabilities.

### Security Model

| Aspect | Design |
|--------|--------|
| Communication | p2p private chat only — no group chat support |
| Authentication | Feishu app credentials stored locally in `config.yaml` (never committed) |
| Agent permissions | Configurable per agent. Claude defaults to `bypassPermissions` (no approval card); switching it to any other mode adds interactive approval on the Feishu card. Codex defaults to approval mode; Kimi to `manual`. |
| Network | WebSocket long-poll to Feishu servers only |
| Data | All data stays on the host machine; no external data forwarding |

### Known Risks

1. **Host access**: In the default configuration (Claude `bypassPermissions`) agents execute with the same permissions as the user running lark-remote, so they can read, modify, or delete any file accessible to that user. Switching Claude to an approval mode adds a confirmation step, but the agent still executes on the host — approval is a human gate, not a sandbox.
2. **No sandboxing**: There is no sandbox or permission boundary between agents and the host system. An approval prompt controls *whether* a command runs, not what it can reach once approved.
3. **Credential storage**: Feishu app credentials are stored in plaintext in `config.yaml`. Protect this file with appropriate filesystem permissions.

---

## 简体中文

### ⚠️ 重要：代理权限

lark-remote 按各 agent 的**配置**权限模式运行。Claude 的默认配置是 `bypassPermissions`——全权限、不弹审批。审批模式可用，且是更安全的选择：

- **Claude**：把 `permissionMode` 设为 `bypassPermissions` 以外的值（`default` / `acceptEdits` / `auto` / `dontAsk` / `plan`）即启用交互式审批——高风险操作会在飞书卡片上等你确认。
- **Codex**：默认即 app-server 审批模式（`approvalPolicy=on-request`，沙箱 `workspace-write`）。
- **Kimi**：默认 `manual`（逐条审批）。

无论哪种模式，本桥接仅用于**单用户私聊（p2p）场景**。切勿将 bot 添加到群聊。

### 报告安全漏洞

如发现安全漏洞，请通过私密渠道报告：

- **GitHub 安全公告**：[报告漏洞](https://github.com/bungabungawoda/lark-remote/security/advisories/new)
- **邮件**：创建标记为"Security"的 GitHub Issue，我们将提供安全联系方式

请**不要**以公开 Issue 报告安全漏洞。

### 安全模型

| 方面 | 设计 |
|------|------|
| 通信 | 仅 p2p 私聊 — 不支持群聊 |
| 认证 | 飞书应用凭据存储在本地 `config.yaml`（不提交到仓库） |
| 代理权限 | 按 agent 可配置。Claude 默认 `bypassPermissions`（无审批卡），改为其他模式会启用飞书卡片交互式审批；Codex 默认审批模式，Kimi 默认 `manual`。 |
| 网络 | 仅 WebSocket 长连接飞书服务器 |
| 数据 | 所有数据留在宿主机；不转发到外部 |

### 已知风险

1. **宿主访问**：默认配置下（Claude `bypassPermissions`）代理以运行 lark-remote 的用户相同权限执行，可读、改、删该用户可访问的任何文件。把 Claude 切到审批模式会增加一步确认，但代理仍在宿主上执行——审批是人工闸门，不是沙箱。
2. **无沙箱**：代理与宿主系统之间没有沙箱或权限边界。审批提示决定的是命令**是否执行**，而不是执行后能触及什么。
3. **凭据存储**：飞书应用凭据以明文存储在 `config.yaml` 中。请用适当的文件系统权限保护此文件。
