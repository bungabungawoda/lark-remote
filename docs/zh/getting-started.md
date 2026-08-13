[English](../en/getting-started.md) | 简体中文

# 入门指南

这份文档会让你从零开始，把 lark-remote 跑起来，并且学会基本的维护。**只要会按步骤操作、会复制粘贴命令**，就能搞定。

---

## 0. 这个项目是干嘛的？

简单说：**用飞书聊天控制电脑里的 AI 写代码**。

 Imagine：
- 你在飞书私聊里发一句「帮我看下 src/index.ts，加个错误处理」；
- 你电脑上的 Claude Code（一个 AI 程序员）就开始读文件、改代码、跑测试；
- 整个过程的进度实时显示在飞书的一张卡片上；
- 完成后卡片显示「✅ 已完成」，你打开电脑一看——代码真的改好了！

lark-remote 就是飞书和 Claude Code 之间的「传话筒」。

---

## 1. 你需要准备什么

> 操作系统仅支持 macOS / Linux，**暂不支持 Windows**。

| 工具 | 是什么 | 怎么装 |
|------|--------|--------|
| **Node.js 20+** | 让 JavaScript 程序能在电脑上跑的环境 | 去 https://nodejs.org 下载 LTS 版，双击安装 |
| **Bun** | 更快的 JavaScript 运行时，本项目用它 | 装好 Node 后，终端粘贴 `npm install -g bun` 回车 |
| **飞书账号** | 用来聊天 | 手机应用商店下载「飞书」App，注册登录 |
| **Claude Code CLI** | 那个 AI 程序员 | 终端运行 `npm install -g @anthropic-ai/claude-code`，然后输入 `claude` 按提示用浏览器登录一次 |

> **什么是「终端」？**
> Mac 上叫「Terminal」（启动台搜索 Terminal），Windows 上叫「PowerShell」或「命令提示符」。就是那个黑底白字、能输入命令的窗口。

> **怎么用终端粘贴命令？**
> 把命令复制到剪贴板，在终端窗口里按 `Ctrl+V`（Windows）或 `Cmd+V`（Mac）回车即可。

---

## 2. 把项目代码拉到本地

打开终端，输入：

```bash
cd ~/projects      # 放代码的文件夹；没有就先 mkdir -p ~/projects
git clone <仓库地址> lark-remote
cd lark-remote
```

> `<仓库地址>` 替换成项目实际的 git 地址（例如 `git@github.com:你的名字/lark-remote.git`）。问大人要，或者从 GitHub 项目页右上角绿色「Code」按钮复制。

---

## 3. 安装项目依赖

在终端继续输入：

```bash
bun install
bun run build
```

`bun install` 会读 `package.json`，把项目用到的所有外部库下载到 `node_modules/` 文件夹。第一次会下载比较多东西，耐心等 1-2 分钟。

`bun run build` 把 TypeScript 代码编译成 JavaScript，放到 `dist/` 文件夹。

如果这两步没报错（exit code 0），就成功了。报错的话看最后几行，常见原因是网络不通——换一个网络再试。

---

## 4. 第一次启动：扫码创建飞书机器人

```bash
bun run dev
```

`bun run dev` 直接用 Bun 跑 TypeScript 源码，**开发时用这个最方便**。

第一次跑时，终端会出现一个**二维码**。打开飞书 App → 右上角扫一扫 → 扫这个二维码 → 飞书会自动帮你建一个「自建应用」（也就是机器人），把凭据写进 `~/.lark-remote/config.yaml`。

**完事之后终端会继续往下跑，最后会等在那里不动**——这是正常的，说明 bridge 已经在监听飞书消息了。

> **如果终端报「非交互环境」错误**：说明你的终端不支持弹二维码。改成手动建应用：
> 1. 浏览器打开 https://open.feishu.cn 登录飞书；
> 2. 「开发者后台」→「创建企业自建应用」，填名字和描述；
> 3. 应用详情页 →「添加应用能力」→ 启用「机器人」；
> 4. 「事件与回调」→「事件配置」→ 添加事件：`im.message.receive_v1`（接收消息）、`card.action.trigger`（卡片点击）；订阅方式选「长连接」；
> 5. 「权限管理」→ 搜索并开通 `im:message`；
> 6. 「凭证与基础信息」→ 复制 App ID 和 App Secret；
> 7. 编辑 `~/.lark-remote/config.yaml`（不存在就新建），填入：
>    ```yaml
>    feishu:
>      appId: cli_xxxxxxxx
>      appSecret: xxxxxxxxxx
>    ```
> 8. 重新跑 `bun run dev`。

---

## 5. 在飞书里发消息

现在打开飞书 App，找到刚才创建的机器人（在「通讯录」→「我的机器人」或者搜索应用名），私聊它。

发一句：

```
你好
```

机器人会回你一张卡片，里面是 Claude 的回复。**恭喜！lark-remote 跑起来了！** 🎉

---

## 6. 几个最常用的命令

在飞书私聊里发 `/` 开头的就是命令。**记住这 7 个就能日常用了**：

| 命令 | 作用 | 例子 |
|------|------|------|
| `/help` | 看所有命令 | 直接发 `/help` |
| `/cd <路径>` | 切换 Claude 工作的文件夹 | `/cd ~/projects/my-game` |
| `/status` | 看当前状态（在哪个文件夹、模型、有没有在跑） | 直接发 `/status` |
| `/stop` | Claude 跑飞了/卡住了，强制停 | 直接发 `/stop` |
| `/new` | 清空当前对话，重新开始 | 直接发 `/new` |
| `/resume` | 看历史会话，点按钮恢复 | 直接发 `/resume` |
| `/exit` | 关掉 bridge | 直接发 `/exit` |

**直接发非 `/` 开头的话**就是和 Claude 聊天。比如：

```
/cd ~/projects/my-game
帮我把得分逻辑改成：每消除一行加 10 分
```

---

## 7. 工作流示例：远程改代码

假设你在学校，想改家里的项目：

```
你: /cd ~/projects/my-game
bot: [卡片：已切换到 /Users/you/code/my-game]

你: 看下 main.py，把所有 print 换成 logging.info
bot: [卡片实时更新：📖 读文件 → ✏️ 修改 → ✅ 完成]
     ✅ Claude · 已完成
     Token: 输入 1.2K · 输出 800 · Cache 90%

你: 跑下测试
bot: [卡片：🔧 运行 pytest → 显示测试结果]
```

回家打开电脑一看，代码真的改好了，测试也跑通了。

---

## 8. 怎么关掉 bridge

两种方式：

1. **在飞书里发** `/exit` —— 优雅退出；
2. **在终端按** `Ctrl+C` —— 强制退出。

退出后飞书机器人就不再回消息了。要再用就重新 `bun run dev`。

---

## 9. 看日志：出了问题怎么排查

bridge 启动后不在终端输出，日志写在文件里：

```
~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log
```

`YYYY-MM-DD` 是今天的日期（如 `2026-07-20`），`<pid>` 是进程号。

**用 Mac 的 Preview 或 VSCode 打开这个文件**，往下翻找 `error` 或 `warn` 字样。看不懂没关系——把这一段复制给大人或 AI 看，问「这是什么错误」。

> 如果 `/exit` 退出了但下次启动报「已有 pid」，说明进程没干净退出。删掉 `~/.lark-remote/lark-remote.pid` 这个文件再启动即可。

---

## 10. 改代码后必做的两件事

如果你改了 `src/` 里的 TypeScript 代码，**改完必须跑这两个命令验证**：

```bash
bun run typecheck   # 检查类型错误，必须 0 error
bun test            # 跑全部测试，必须全绿
```

两个都过了才算改完。有一个红了就先修，再改下一步。

> 测试是什么？就是项目里写好的「自动检查小程序」，确保你的改动没把已有功能弄坏。本项目有 200+ 个测试文件，跑一遍大概 1 分钟。

---

## 11. 项目的文件夹长啥样

```
lark-remote/
├── src/                ← 源代码（你主要改这里）
│   ├── index.ts        ← 程序入口
│   ├── bridge/         ← 串行队列、空闲超时自动停止
│   ├── runner/         ← 调用各种 AI CLI（Claude/Codex/OpenCode/Pi/Kimi）
│   ├── card/           ← 飞书卡片渲染
│   ├── router/         ← 命令分发
│   ├── config/         ← 配置文件读写
│   ├── session/        ← 历史会话读取
│   └── ...
├── tests/              ← 测试代码
├── docs/               ← 文档（你现在看的就是这里）
│   ├── getting-started.md  ← 本文
│   ├── usage.md            ← 详细使用指南
│   ├── architecture/       ← 设计与坑点
│   └── guides/             ← 操作手册
├── scripts/            ← 运维脚本
├── README.md           ← 项目说明
└── package.json        ← 项目依赖与脚本
```

---

## 12. 想加新 AI 怎么办

lark-remote 现在支持 5 种 AI：Claude、Codex、OpenCode、Pi、Kimi。想接入第 6 种？

→ 看 [`guides/add-new-agent.md`](guides/add-new-agent.md)，里面有完整的 10 步模板。

---

## 13. 下一步看什么

| 想了解 | 看哪份文档 |
|--------|-----------|
| 所有命令的详细用法 | [`usage.md`](usage.md) |
| 整体设计、JSONL 事件、踩过的坑 | [`architecture/design.md`](architecture/design.md) |
| 单卡流式输出怎么工作的 | [`architecture/streaming-card.md`](architecture/streaming-card.md) |
| Codex 怎么配置 | [`guides/codex-config.md`](guides/codex-config.md) |

---

## 14. 遇到问题怎么办

1. **先看日志**：`~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log`（`YYYY-MM-DD` 是当天日期，如 `2026-07-20`），找 `error`；
2. **跑测试**：`bun run typecheck && bun test`，看哪里坏了；
3. **查已知的坑**：项目已有踩坑记录，大概率踩过同样的坑；
4. **问 AI**：把日志错误段复制给 Claude/ChatGPT，问「这是什么错误，怎么修」；
5. **实在搞不定**：记录下复现步骤，问大人或提 issue。

加油！🚀
