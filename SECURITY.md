# Security Policy / 安全策略

[English](#english) | [简体中文](#简体中文)

---

## English

### ⚠️ Important: Full-Permission Execution

lark-remote runs coding agents with **full permissions** (bypassing all approval prompts). This is by design — the bridge is intended for **single-user, private-chat (p2p) use only**. Never add the bot to group chats.

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
| Agent permissions | Full bypass — agents can execute any command on the host |
| Network | WebSocket long-poll to Feishu servers only |
| Data | All data stays on the host machine; no external data forwarding |

### Known Risks

1. **Full host access**: Agents execute with the same permissions as the user running lark-remote. This means they can read, modify, or delete any file accessible to that user.
2. **No sandboxing**: There is no sandbox or permission boundary between agents and the host system.
3. **Credential storage**: Feishu app credentials are stored in plaintext in `config.yaml`. Protect this file with appropriate filesystem permissions.

---

## 简体中文

### ⚠️ 重要：全权限执行

lark-remote 以**全权限**运行编码代理（绕过所有审批提示）。这是设计如此 — 本桥接仅用于**单用户私聊（p2p）场景**。切勿将 bot 添加到群聊。

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
| 代理权限 | 全权限绕过 — 代理可执行宿主机上的任何命令 |
| 网络 | 仅 WebSocket 长连接飞书服务器 |
| 数据 | 所有数据留在宿主机；不转发到外部 |

### 已知风险

1. **完整宿主访问**：代理以运行 lark-remote 的用户相同权限执行，可读、改、删该用户可访问的任何文件。
2. **无沙箱**：代理与宿主系统之间没有沙箱或权限边界。
3. **凭据存储**：飞书应用凭据以明文存储在 `config.yaml` 中。请用适当的文件系统权限保护此文件。
