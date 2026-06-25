# peekMyAgent

[English README](README.md) | [完整用户手册](docs/user-guide.md)

## 从这里开始

如果你的 Claude Code 已经可以正常使用，最快试用方式是：

```bash
git clone https://github.com/fengjikui/peekMyAgent-public.git
cd peekMyAgent-public
npm link

peekmyagent open
cd <你的项目目录>
peekmyagent claude -c
```

然后正常使用 Claude Code。打开 `http://127.0.0.1:43110`，或者再次运行 `peekmyagent open`，就可以查看捕获到的请求。

更完整的步骤见：[用户使用手册](docs/user-guide.md)。

## 项目简介

peekMyAgent 是一个本地优先的 Agent 请求观察面板，用来查看 Claude Code、OpenClaw 等 coding agent 在调用模型前，实际组装并发送给模型服务商的内容。

它可以帮助你理解：

- Agent 带了哪些 system prompt、用户消息和历史上下文。
- 工具列表、工具参数 schema 和工具结果是如何进入请求的。
- 多轮对话、工具调用、子 Agent 请求在模型请求层面是什么样子。
- 服务商返回的 usage、响应内容和原始 JSON 结构。

peekMyAgent 不是用来“破解隐藏提示词”的工具。它是一个本地调试和审计工具，只应该用于你自己明确授权记录的本地 Agent 会话。

## 当前可用能力

- 打开本地 dashboard：`http://127.0.0.1:43110`。
- 通过 `peekmyagent claude ...` 启动 Claude Code 并捕获模型请求。
- 通过 `peekmyagent openclaw ...` 启动 OpenClaw 并捕获模型请求。
- 在时间线中查看用户输入、system 摘要、tools、tool calls、tool results、response、token usage 和 Raw JSON。
- 识别并展示 Claude Code 子 Agent 请求。
- 在 Claude Code 内通过 `/peekmyagent` 打开 dashboard。
- 通过 slash commands 暂停、恢复、停止或清空当前 recording。
- 在 dashboard 底部输入框直接向被监听的 Agent 发送消息。

## 环境要求

- macOS 或类 Unix shell 环境。
- Node.js 18 或更高版本。
- 已经安装并配置好的 Claude Code 或 OpenClaw。
- 你的模型服务商配置需要先在当前终端里能正常工作。

如果 `claude` 本身不可用，请先修好 Claude Code 配置：

```bash
claude --version
claude -p --output-format text "Reply OK"
```

## 从源码安装

```bash
git clone https://github.com/fengjikui/peekMyAgent-public.git
cd peekMyAgent-public
npm link
```

确认命令可用：

```bash
peekmyagent --help
```

如果不想使用 `npm link`，也可以直接运行：

```bash
node bin/peekmyagent.mjs --help
```

下面的示例默认使用 `peekmyagent`。如果没有执行 `npm link`，把它替换为 `node /path/to/peekMyAgent-public/bin/peekmyagent.mjs` 即可。

## Claude Code 快速开始

打开 dashboard：

```bash
peekmyagent open
```

通过 peekMyAgent 启动 Claude Code：

```bash
cd <你的项目目录>
peekmyagent claude -c
```

然后正常使用 Claude Code。捕获到的请求会出现在 dashboard 中。

如果你明确想让 Claude Code 跳过权限确认，可以把 Claude Code 自己的参数放在 `claude` 后面：

```bash
peekmyagent claude -c --dangerously-skip-permissions
```

这个参数属于 Claude Code，不属于 peekMyAgent。它会绕过 Claude Code 的常规权限检查，只建议在你信任的仓库中使用。

再次打开 dashboard：

```bash
peekmyagent open
```

只打印 dashboard 地址，不自动打开浏览器：

```bash
peekmyagent open --print
```

默认地址：

```text
http://127.0.0.1:43110
```

## 恢复 Claude Code 会话

恢复指定 Claude Code 会话：

```bash
peekmyagent claude -r <session-id>
```

继续上一次 Claude Code 会话：

```bash
peekmyagent claude -c
```

当 Claude Code 使用 `-c/--continue` 或 `-r/--resume` 时，peekMyAgent 可能会找到当前项目/会话对应的历史 recording。交互式终端会询问你是复用已有 recording，还是创建新的 recording。

也可以显式指定策略：

```bash
peekmyagent --reuse claude -c
peekmyagent --new claude -c
peekmyagent --ask claude -r <session-id>
```

## 安装 Claude Code Slash Commands

安装 Claude Code skill 和 slash-command 模板：

```bash
peekmyagent install-claude-skill --commands
```

默认会安装：

- `~/.claude/skills/peekmyagent-control/SKILL.md`
- `~/.claude/commands/peekmyagent.md`
- `~/.claude/commands/peekmyagent-status.md`
- `~/.claude/commands/peekmyagent-pause.md`
- `~/.claude/commands/peekmyagent-resume.md`
- `~/.claude/commands/peekmyagent-stop.md`
- `~/.claude/commands/peekmyagent-clear.md`

之后可以在 Claude Code 中使用：

```text
/peekmyagent
/peekmyagent-status
/peekmyagent-pause
/peekmyagent-resume
/peekmyagent-stop
/peekmyagent-clear
```

命令含义：

- `/peekmyagent`：打开或打印 dashboard 地址。
- `/peekmyagent-status`：把当前 Claude Code session 关联到 dashboard，并输出捕获说明。
- `/peekmyagent-pause`：继续转发请求，但暂停保存请求内容。
- `/peekmyagent-resume`：恢复保存请求内容。
- `/peekmyagent-stop`：停止当前 recording，但保留已经捕获的内容。
- `/peekmyagent-clear`：停止并从 dashboard 列表中移除当前 recording。

注意：slash commands 不能反向修改一个已经运行中的 Claude Code 进程环境。要做精确的 provider 请求捕获，推荐从一开始就用 `peekmyagent claude ...` 启动或恢复 Claude Code。

## Dashboard 结构

dashboard 主要分为三块：

- 左侧：项目、会话、live watch 和内置证据包列表。
- 中间：请求时间线，包括用户输入、Agent 请求、模型回复、工具调用、工具结果、子 Agent 流程、token usage 和可折叠摘要。
- 右侧：原始 JSON 和归一化后的结构化内容。

常用按钮：

- `展开上行`：查看某次请求的完整上行内容。
- `System`：查看 system prompt block。
- `Tools`：查看工具描述和参数 schema。
- `Tool calls`：查看模型下发的工具调用。
- `Tool results`：查看回传给模型的工具结果。
- `Response`：查看捕获到的模型响应。
- `Raw`：查看原始 JSON。

如果当前来源是 live Claude Code 或 OpenClaw watch，底部输入框可以直接向该 Agent 发送消息：

- `Enter` 发送。
- `Shift + Enter` 换行。

## OpenClaw

通过 peekMyAgent 启动 OpenClaw：

```bash
peekmyagent openclaw agent --session-key agent:main:my-session --message "hello"
```

如果不传 OpenClaw 子命令，peekMyAgent 会运行：

```bash
openclaw --profile peekmyagent chat
```

OpenClaw 集成使用隔离的 `peekmyagent` profile，不会直接修改你的主 profile。

更多说明见：[OpenClaw profile watch](docs/openclaw-profile-watch.md)。

## Demo Viewer

无需真实运行 Agent，也可以打开内置证据包：

```bash
npm run view
```

或者选择一个具体 demo：

```bash
node bin/peekmyagent.mjs dev view --demo openclaw-subagent --open
node bin/peekmyagent.mjs dev view --demo openclaw-multiturn --open
node bin/peekmyagent.mjs dev view --demo claude-subagent --open
node bin/peekmyagent.mjs dev view --demo claude-proxy-resume --open
```

这适合演示、截图和 UI review。

## 隐私与安全

peekMyAgent 是本地优先工具，但捕获到的数据仍然可能很敏感。

请求中可能包含：

- 用户消息。
- system prompt 和开发者指令。
- 工具描述和工具 schema。
- 工具结果。
- 文件路径。
- 项目上下文。
- 模型参数。
- 原始 provider 请求 body。

建议：

- 初次试用时使用非敏感项目。
- 不要分享包含私有代码、密钥或专有 prompt 的 dashboard 截图。
- 不要把本地 dashboard 暴露到公网。
- 输入敏感内容前可以使用 `/peekmyagent-pause`。
- 不再需要某条 recording 时使用 `/peekmyagent-clear`。

## 常见问题

### 找不到 `peekmyagent`

在仓库目录执行：

```bash
npm link
```

或者使用直接路径：

```bash
node /path/to/peekMyAgent-public/bin/peekmyagent.mjs open
```

### 43110 端口被占用

重启 daemon：

```bash
peekmyagent restart --print --no-open --force
```

或者关闭 daemon：

```bash
peekmyagent shutdown --force
```

### Claude Code 提示模型不可用

先确认 Claude Code 本身可用：

```bash
claude -p --output-format text "Reply OK"
```

如果这里失败，先修模型服务商配置。

如果普通 shell 里可用，但 dashboard 底部发送框失败，请从同一个 shell 环境重启 peekMyAgent：

```bash
source ~/.zshrc
peekmyagent restart --print --no-open --force
```

然后重新通过 wrapper 启动 Claude Code：

```bash
peekmyagent claude -c
```

### slash commands 能看到 session，但没有新请求

通常说明 Claude Code 已经先启动了，peekMyAgent 没法反向改写它的 provider base URL。

要做精确捕获，请退出 Claude Code，然后用 peekMyAgent 恢复：

```bash
peekmyagent claude -r <session-id>
```

## 开发检查

常用 smoke tests：

```bash
npm run smoke:cli
npm run smoke:dashboard-open
npm run smoke:agent-send
npm run smoke:daemon-claude
npm run smoke:run-claude
npm run smoke:agent-trace-view
npm run smoke:timeline-display
npm run smoke:openclaw-subagent
npm run smoke:openclaw-multiturn
```

检查 dashboard client 语法：

```bash
node --check src/viewer/client.js
```

## 更多文档

- [用户使用手册](docs/user-guide.md)
- [Claude Code 当前会话控制](docs/claude-code-current-session-control.md)
- [OpenClaw profile watch](docs/openclaw-profile-watch.md)
