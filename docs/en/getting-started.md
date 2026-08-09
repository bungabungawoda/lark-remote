[简体中文](../zh/getting-started.md) | English

# Getting Started Guide

This document will help you get lark-remote up and running from scratch, and teach you the basics of maintaining it. **As long as you can follow steps and copy-paste commands**, you'll be fine.

---

## 0. What Does This Project Do?

In short: **Use Feishu chat to control the AI on your computer to write code**.

Imagine:
- You send a message in a Feishu private chat: "Check src/index.ts and add error handling";
- Claude Code (an AI programmer) on your computer starts reading files, modifying code, and running tests;
- The entire progress is displayed in real time on a Feishu card;
- When done, the card shows "Done", and when you open your computer — the code is actually changed!

lark-remote is the "messenger" between Feishu and Claude Code.

---

## 1. What You Need to Prepare

> Only macOS / Linux are supported. **Windows is not supported yet.**

| Tool | What It Is | How to Install |
|------|-----------|----------------|
| **Node.js 20+** | The environment that lets JavaScript programs run on your computer | Go to https://nodejs.org, download the LTS version, double-click to install |
| **Bun** | A faster JavaScript runtime, used by this project | After installing Node, paste `npm install -g bun` in the terminal and press Enter |
| **Feishu Account** | For chatting | Download the "Feishu" app from your phone's app store, register and log in |
| **Claude Code CLI** | That AI programmer | Run `npm install -g @anthropic-ai/claude-code` in the terminal, then type `claude` and follow the prompts to log in once via the browser |

> **What is the "terminal"?**
> On Mac it's called "Terminal" (search for Terminal in Launchpad), on Windows it's "PowerShell" or "Command Prompt". It's that window with a black background and white text where you can type commands.

> **How do I paste commands in the terminal?**
> Copy the command to your clipboard, then in the terminal window press `Ctrl+V` (Windows) or `Cmd+V` (Mac) and hit Enter.

---

## 2. Clone the Project Code to Your Computer

Open the terminal and type:

```bash
cd ~/projects      # Folder for code; create it first with mkdir -p ~/projects if it doesn't exist
git clone <repository-url> lark-remote
cd lark-remote
```

> Replace `<repository-url>` with the actual git address of the project (e.g., `git@github.com:yourname/lark-remote.git`). Ask an adult, or copy it from the green "Code" button in the top-right corner of the GitHub project page.

---

## 3. Install Project Dependencies

Continue typing in the terminal:

```bash
bun install
bun run build
```

`bun install` reads `package.json` and downloads all external libraries the project uses into the `node_modules/` folder. The first time it will download quite a bit, so be patient for 1-2 minutes.

`bun run build` compiles the TypeScript code into JavaScript and puts it in the `dist/` folder.

If neither of these steps produces errors (exit code 0), you're good. If there are errors, look at the last few lines — a common cause is network issues, so try a different network.

---

## 4. First Launch: Scan QR Code to Create a Feishu Bot

```bash
bun run dev
```

`bun run dev` runs the TypeScript source code directly with Bun, **the most convenient option during development**.

The first time you run it, a **QR code** will appear in the terminal. Open the Feishu app → scan in the top-right corner → scan this QR code → Feishu will automatically create a "custom app" (i.e., a bot) for you and write the credentials into `~/.lark-remote/config.yaml`.

**After that, the terminal will continue running and eventually sit there waiting** — this is normal, it means the bridge is listening for Feishu messages.

> **If the terminal shows a "non-interactive environment" error**: It means your terminal doesn't support displaying a QR code. Create the app manually instead:
> 1. Open https://open.feishu.cn in your browser and log in to Feishu;
> 2. "Developer Console" → "Create Enterprise Custom App", fill in the name and description;
> 3. App details page → "Add App Capability" → Enable "Bot";
> 4. "Events & Callbacks" → "Event Configuration" → Add events: `im.message.receive_v1` (receive message), `card.action.trigger` (card click); select "Long Connection" as the subscription method;
> 5. "Permission Management" → Search and enable `im:message`;
> 6. "Credentials & Basic Info" → Copy the App ID and App Secret;
> 7. Edit `~/.lark-remote/config.yaml` (create it if it doesn't exist), fill in:
>    ```yaml
>    feishu:
>      appId: cli_xxxxxxxx
>      appSecret: xxxxxxxxxx
>    ```
> 8. Run `bun run dev` again.

---

## 5. Send a Message in Feishu

Now open the Feishu app, find the bot you just created (under "Contacts" → "My Bots" or search for the app name), and start a private chat with it.

Send:

```
hello
```

The bot will reply with a card containing Claude's response. **Congratulations! lark-remote is running!**

---

## 6. The Most Common Commands

In a Feishu private chat, anything starting with `/` is a command. **Memorize these 7 and you're set for daily use**:

| Command | What It Does | Example |
|---------|-------------|---------|
| `/help` | Show all commands | Just send `/help` |
| `/cd <path>` | Switch the folder Claude works in | `/cd ~/projects/my-game` |
| `/status` | Show current status (which folder, model, whether something is running) | Just send `/status` |
| `/stop` | Force stop Claude if it's running away or stuck | Just send `/stop` |
| `/new` | Clear the current conversation and start fresh | Just send `/new` |
| `/resume` | View past sessions, click a button to restore one | Just send `/resume` |
| `/exit` | Shut down the bridge | Just send `/exit` |

**Anything not starting with `/` is just chatting with Claude.** For example:

```
/cd ~/projects/my-game
Change the scoring logic so each cleared line adds 10 points
```

---

## 7. Workflow Example: Remotely Modifying Code

Say you're at school and want to modify a project on your home computer:

```
You: /cd ~/projects/my-game
bot: [Card: Switched to /Users/you/code/my-game]

You: Check main.py, replace all print with logging.info
bot: [Card updating in real time: Reading file → Editing → Done]
     Done · Claude
     Token: Input 1.2K · Output 800 · Cache 90%

You: Run the tests
bot: [Card: Running pytest → showing test results]
```

When you get home and open your computer, the code is actually modified and the tests have passed.

---

## 8. How to Shut Down the Bridge

Two ways:

1. **Send** `/exit` **in Feishu** — graceful shutdown;
2. **Press** `Ctrl+C` **in the terminal** — force quit.

After exiting, the Feishu bot will no longer respond to messages. To use it again, just run `bun run dev`.

---

## 9. Reading Logs: How to Troubleshoot Problems

After the bridge starts, it doesn't output to the terminal. Logs are written to files:

```
~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log
```

`YYYY-MM-DD` is today's date (e.g., `2026-07-20`), and `<pid>` is the process ID.

**Open this file with Mac's Preview or VSCode** and scroll through looking for `error` or `warn`. It's okay if you don't understand it — copy the relevant section and show it to an adult or an AI, asking "What is this error?"

> If `/exit` shut down but the next startup says "pid already exists", it means the process didn't exit cleanly. Just delete the file `~/.lark-remote/lark-remote.pid` and start again.

---

## 10. Two Things You Must Do After Changing Code

If you modified TypeScript code in `src/`, **you must run these two commands to verify**:

```bash
bun run typecheck   # Check for type errors, must be 0 errors
bun test            # Run all tests, must all pass
```

Both must pass for the change to be considered done. If either one is red, fix it before moving on.

> What are tests? They're "automatic check programs" written in the project to make sure your changes didn't break existing functionality. This project has 200+ test files, and running them all takes about 1 minute.

---

## 11. What the Project Folder Looks Like

```
lark-remote/
├── src/                ← Source code (this is where you mostly make changes)
│   ├── index.ts        ← Program entry point
│   ├── bridge/         ← Serial queue, watchdog
│   ├── runner/         ← Calling various AI CLIs (Claude/Codex/OpenCode/Pi/Kimi)
│   ├── card/           ← Feishu card rendering
│   ├── router/         ← Command dispatch
│   ├── config/         ← Config file read/write
│   ├── session/        ← Historical session reading
│   └── ...
├── tests/              ← Test code
├── docs/               ← Documentation (you're reading this right now)
│   ├── getting-started.md  ← This document
│   ├── usage.md            ← Detailed usage guide
│   ├── architecture/       ← Design and pitfalls
│   └── guides/             ← How-to manuals
├── scripts/            ← Operations scripts
├── CLAUDE.md           ← AI collaboration rules (red lines, pitfall summaries)
├── README.md           ← Project readme
└── package.json        ← Project dependencies and scripts
```

---

## 12. What If You Want to Add a New AI?

lark-remote currently supports 5 AIs: Claude, Codex, OpenCode, Pi, and Kimi. Want to add a 6th?

→ See [`guides/add-new-agent.md`](guides/add-new-agent.md), which has a complete 10-step template.

---

## 13. What to Read Next

| Want to Learn About | Which Document |
|---------------------|----------------|
| Detailed usage of all commands | [`usage.md`](usage.md) |
| Overall design, JSONL events, lessons learned | [`architecture/design.md`](architecture/design.md) |
| How single-card streaming output works | [`architecture/streaming-card.md`](architecture/streaming-card.md) |
| How to configure Codex | [`guides/codex-config.md`](guides/codex-config.md) |
| Red lines the AI must follow when writing code | [`../../CLAUDE.md`](../../CLAUDE.md) |

---

## 14. What to Do When You Run Into Problems

1. **Check the logs first**: `~/.lark-remote/logs/YYYY-MM-DD/lark-remote-<pid>.log` (`YYYY-MM-DD` is today's date, e.g., `2026-07-20`), look for `error`;
2. **Run tests**: `bun run typecheck && bun test`, see what's broken;
3. **Check the red lines**: The "Red Lines / Common Pitfalls" section in [`../../CLAUDE.md`](../../CLAUDE.md) — chances are someone has fallen into the same pit before;
4. **Ask an AI**: Copy the error section of the log to Claude/ChatGPT and ask "What is this error and how do I fix it?";
5. **Really stuck**: Document the steps to reproduce, then ask an adult or file an issue.

You've got this!
