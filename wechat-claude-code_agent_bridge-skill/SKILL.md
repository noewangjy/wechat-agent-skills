---
name: wechat-claude-code-agent-bridge
description: >-
  微信 ↔ 本地 Claude Code CLI 桥接：支持文字、图片、文件收发、会话续接、微信侧切换 model 和
  permission-mode。用户提到微信桥接 Claude Code、手机微信控制 Claude Code、ClawBot 对
  Claude Code 联调、远程用微信驱动 Claude Code 做代码任务时使用。
---

# 微信 ↔ Claude Code CLI 桥接

用微信连接本机运行的 `claude` CLI（Claude Code）。桥接服务基于 `claude -p --output-format stream-json`，支持：

- 文字消息转发给 Claude Code
- 图片保存到本地，并在 prompt 中**按需提示**：仅当用户请求需要时 Claude 才读取（多模态模型用 `Read` 工具，纯文本模型用视觉类 MCP 工具）；单纯发图不附要求则 Claude 可以不读
- 文件、语音、视频落盘后把本地路径交给 Claude Code
- 使用 `session_id` 自动续接上下文（`--resume`）
- 微信端控制 `/model` / `/permission` / `/stop` / `/clear` / `/send`

如果需要修改和微信桥接相关的底层协议，可以参考 `wechat_agent_bridge_skills/openclaw-weixin` 原版 SDK。

## 目录说明

| 路径 | 作用 |
|------|------|
| `templates/` | 可独立运行的 Node 桥接服务 |
| `templates/src/ilink.ts` | 微信 ilink（ClawBot）HTTP API：收发消息、媒体加解密（与 Codex 版共享实现） |
| `templates/src/bridge.ts` | 主循环：`getupdates` + `claude -p --output-format stream-json` |
| `templates/src/usage-footer.ts` | token / 成本 footer（Anthropic 模型定价，成本优先取 `result.total_cost_usd`） |
| `templates/bridge.config.example.json` | 配置模板，复制为 `bridge.config.json` |

## 前置条件

- Node.js >= 18
- 已安装并登录 `claude` CLI（`claude auth login`，或用 `ANTHROPIC_API_KEY` 环境变量）
- 微信侧已完成 ClawBot / ilink 机器人绑定

## 安装与启动

```bash
cd wechat-claude-code_agent_bridge-skill/templates
cp bridge.config.example.json bridge.config.json
# 编辑 bridge.config.json：至少设置 cwd 为项目根目录
npm install
npm run setup
npm start
```

## 微信端指令

- `/help` - 查看帮助
- `/status` - 查看当前 bridge 状态
- `/clear` - 清除会话、终止任务、清空队列和追问
- `/stop` - 终止当前任务
- `/stopall` - 终止当前任务并清空队列和追问
- `/send <路径>` - 发送服务器上的文件到微信
- `/model` - 查看当前模型
- `/model <名称>` - 设置下一轮执行使用的模型（`sonnet` / `opus` / `claude-sonnet-4-6` 等）
- `/model clear` - 恢复 Claude Code 默认模型
- `/permission` - 查看当前 permission-mode
- `/permission default | acceptEdits | plan | auto | dontAsk | bypassPermissions` - 切换模式

## permission-mode 速查

| 模式 | 含义 |
|------|------|
| `default` | 每个写操作都提示（非交互式下近似只读） |
| `acceptEdits`（默认推荐） | 自动批准 Edit + 常用 Bash（mkdir/touch/mv/cp 等） |
| `plan` | 只读分析模式 |
| `auto` | 自动执行（需账户支持） |
| `dontAsk` | 仅执行预批准工具，其他自动拒绝 |
| `bypassPermissions` | 跳过所有检查（**仅在信任目录使用**） |

也可在 `bridge.config.json` 里设置：

- `allowedTools`: `["Bash(git:*)", "Edit", "Read"]`（透传 `--allowedTools`）
- `disallowedTools`: 同上，透传 `--disallowedTools`
- `dangerouslySkipPermissions: true` → 传 `--dangerously-skip-permissions`（覆盖 permission-mode）
- `bareMode: true` → 传 `--bare`：跳过**所有全局配置**（包括 `claude mcp add` 配置的全局 MCP、`~/.claude/CLAUDE.md`、hooks、OAuth 等），仅供 CI / 隔离环境使用。默认 `false`，以便桥接直接继承用户本机已经配好的 MCP server 与偏好。
- `bareMode: true` → 传 `--bare`：跳过**所有全局配置**（包括 `claude mcp add` 配置的全局 MCP、`~/.claude/CLAUDE.md`、hooks、OAuth 等），仅供 CI / 隔离环境使用。默认 `false`，以便桥接直接继承用户本机已经配好的 MCP server 与偏好。

## 重要限制

本桥接使用的是非交互式 `claude -p`。因此：

- 支持稳定的消息桥接、会话续接（`--resume <session-id>`）、图片路径输入和文件回传
- **不支持**像 Cursor 版那样对每一次工具调用做微信侧逐条审批
- 需要通过 `/permission` + `allowedTools` 控制整体执行范围，而不是在工具执行中途弹微信确认

## 会话续接的细节

- 每轮 `result` 事件中的 `session_id` 会被写入 `bridge-state.json`
- 下一轮消息默认用 `--resume <sessionId>` 续接，保持对话上下文
- 超过 `sessionTimeoutMs`（默认 30 分钟）未活动 → 自动起新会话
- `/clear` 或 `/permission <mode>` 会重置当前用户的续接 session

## 发送文件给微信

如果希望 Claude Code 把本机文件主动发回微信，让它在回复中输出：

```text
[SEND_FILE:/绝对路径/文件.ext]
```

桥接层会自动识别并上传该文件（≤25MB）。
