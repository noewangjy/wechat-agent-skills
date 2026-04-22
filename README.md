# 🔍 WeChat AI Agent Bridge — 微信接入 AI 编程代理

> **把微信变成你的 AI 事实核查入口。**  
> 截图发给微信机器人，几分钟后收到深度验证报告。

在 GPT Image 2 让任何人都能一键生成以假乱真的社媒截图的今天，你需要一个触手可及的事实核查工具——不是装一个新 App，不是打开一个网页，而是在你每天用的**微信**里，把截图丢过去，等一杯咖啡的时间，拿到一份带原始链接和权威来源的验证报告。

本项目将 **微信** 与 **OpenAI Codex CLI** / **Cursor Agent CLI** 桥接，让你可以在微信对话中直接驱动本地 AI Agent——不仅能核查新闻，还能远程写代码、操作文件、执行任何 Agent 能做的事。

---

## ✨ 核心能力

| 场景 | 说明 |
|------|------|
| **新闻事实核查** | 发一张新闻截图 → Agent 自动 OCR、多源搜索、交叉验证 → 返回真伪判断 + 原帖链接 + 权威媒体报道 |
| **远程 AI 编程** | 在微信里给 Agent 下指令，它在你的服务器上读代码、改文件、跑测试 |
| **图片/文件处理** | 发图片、文件、语音给微信机器人，Agent 可以直接读取和处理 |
| **会话记忆** | 自动续接上下文，不用每次重新描述问题 |
| **权限管控** | Cursor 版支持微信端逐条审批危险操作；Codex 版通过 sandbox 模式控制 |

---

## 📁 项目结构

```
wechat_agent_bridge_skills/
├── README.md                              ← 你在这里
├── news-fact-checker/                     ← 新闻截图事实核查 Skill
│   ├── SKILL.md
│   └── dependencies/                      ← 推荐预装依赖 skills 的清单与安装脚本
│       ├── README.md
│       ├── install-skill-deps.sh
│       └── skills.lock.json
├── wechat-codex_agent_bridge-skill/       ← 微信 ↔ OpenAI Codex CLI 桥接
│   ├── SKILL.md
│   ├── 快速启动.md
│   └── templates/                         ← 可独立运行的 Node 桥接服务
├── wechat-cursor_agent_bridge-skill/      ← 微信 ↔ Cursor Agent CLI 桥接
│   ├── SKILL.md
│   ├── 快速启动.md
│   └── templates/                         ← 可独立运行的 Node 桥接服务
└── openclaw-weixin/                       ← 微信 ilink 通信协议 SDK (fork)
```

---

## 🚀 快速开始

### 前置条件

- **Node.js 18+**
- 已安装并登录你选择的 Agent CLI:
  - **Codex 用户**: `codex login`
  - **Cursor 用户**: `agent --version`（确认 CLI 可用）

### 一、选择你的 Agent，启动桥接

<details>
<summary><b>方案 A：OpenAI Codex CLI（推荐 Codex 订阅用户）</b></summary>

```bash
# 1. 进入桥接目录
cd wechat-codex_agent_bridge-skill/templates

# 2. 安装依赖
npm install

# 3. 创建配置（编辑 cwd 为你的项目目录）
cp bridge.config.example.json bridge.config.json

# 4. 微信扫码绑定（只需一次）
npm run setup

# 5. 用 tmux 在后台启动
tmux new-session -d -s wechat-codex 'npm start'
```

验证运行状态：

```bash
tmux attach -t wechat-codex    # 查看日志
# Ctrl+B, D 退出 tmux（不会终止进程）
```

</details>

<details>
<summary><b>方案 B：Cursor Agent CLI（推荐 Cursor Pro 订阅用户）</b></summary>

```bash
# 1. 进入桥接目录
cd wechat-cursor_agent_bridge-skill/templates

# 2. 安装依赖
npm install

# 3. 创建配置（编辑 cwd 为你的项目目录）
cp bridge.config.example.json bridge.config.json

# 4. 微信扫码绑定（只需一次）
npm run setup

# 5. 用 tmux 在后台启动
tmux new-session -d -s wechat-cursor 'npm start'
```

验证运行状态：

```bash
tmux attach -t wechat-cursor
# Ctrl+B, D 退出 tmux
```

</details>

### 二、安装新闻事实核查 Skill 与推荐依赖

桥接跑起来后，还需要让 Agent 知道怎么做事实核查。

**Codex 用户**（将 Skill 安装到 Codex 技能目录）：

```bash
# 复制 skill 到 Codex 能读到的位置
mkdir -p ~/.codex/skills/news-fact-checker
cp news-fact-checker/SKILL.md ~/.codex/skills/news-fact-checker/SKILL.md

# 推荐：在首次配置时一并安装最近 30 天研究依赖
bash news-fact-checker/dependencies/install-skill-deps.sh codex
```

上述脚本会把：

- `last30days` 安装到 `~/.codex/skills/last30days`
- `last30days-cn` 安装到 `~/.codex/skills/last30days-cn`

**Cursor 用户**（将 Skill 安装到 Cursor 技能目录）：

```bash
mkdir -p ~/.cursor/skills/news-fact-checker
cp news-fact-checker/SKILL.md ~/.cursor/skills/news-fact-checker/SKILL.md

# 推荐：在首次配置时一并安装最近 30 天研究依赖
bash news-fact-checker/dependencies/install-skill-deps.sh cursor
```

上述脚本会把：

- `last30days` 安装到 `~/.cursor/skills/last30days`
- `last30days-cn` 安装到 `~/.cursor/skills/last30days-cn`

如果你在 OpenClaw / ClawHub 环境里使用这些 skills，可执行：

```bash
bash news-fact-checker/dependencies/install-skill-deps.sh agents
```

会安装到：

- `~/.agents/skills/last30days`
- `~/.agents/skills/last30days-cn`

依赖详情见 `news-fact-checker/dependencies/README.md`。这两个依赖 skill 的定位是：

- `last30days`：补充最近 30 天的英文/全球社区讨论、开发者反馈、跨平台热度
- `last30days-cn`：补充最近 30 天的中文平台传播、热搜轨迹、社区反馈

这样用户在初次配置完成后，Agent 就已经具备了“截图核查 + 最近 30 天上下文研究”的组合能力。

### 三、开始使用

打开微信，找到你绑定的 ClawBot 机器人对话，发送一张新闻截图，然后说：

> **"帮我验证一下这个新闻是不是真的"**

等待 1-3 分钟，你会收到一份包含以下内容的验证报告：

```
✅ 经核实，此消息属实。

Meta 于4月21日宣布将在美国员工电脑上安装追踪软件...

参考链接：
- 原文：Reuters — https://www.reuters.com/...
- BBC：https://www.bbc.com/...
```

或者：

```
❌ 经核实，此消息为假。

截图中的"官方公告"实际不存在，相关官方账号从未发布过此内容。
多家辟谣平台已确认该信息为伪造。
```

---

## ⚙️ 配置参考

### Codex 版 `bridge.config.json`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `cwd` | `""` | **必填**，Agent 的工作目录 |
| `codexPath` | `"codex"` | Codex CLI 路径 |
| `model` | `""` | 模型名称，留空用默认 |
| `sandboxMode` | `"workspace-write"` | `read-only` / `workspace-write` / `danger-full-access` |
| `agentTimeoutMs` | `1800000` | 单次任务超时（毫秒） |
| `enableSession` | `true` | 会话续接 |
| `allowedUserIds` | `[]` | 白名单，空 = 不限制 |

### Cursor 版 `bridge.config.json`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `cwd` | `""` | **必填**，Agent 的工作目录 |
| `agentPath` | `"agent"` | Cursor CLI 路径 |
| `model` | `""` | 模型名称，留空用默认 |
| `force` | `true` | `true` = 自动执行所有工具；`false` = 需微信逐条确认 |
| `agentTimeoutMs` | `1800000` | 单次任务超时（毫秒） |
| `showToolCalls` | `true` | 是否在微信显示工具调用过程 |
| `allowedUserIds` | `[]` | 白名单，空 = 不限制 |

---

## 📱 微信端指令

两个版本通用：

| 指令 | 作用 |
|------|------|
| `/help` | 查看帮助 |
| `/clear` | 清空当前会话 |
| `/stop` | 终止当前任务 |
| `/stopall` | 终止任务 + 清空队列 |
| `/send <路径>` | 发送服务器文件到微信 |
| `/model` | 查看当前模型 |
| `/model <名称>` | 切换模型 |
| `/model clear` | 恢复默认模型 |

Codex 版额外支持：

| 指令 | 作用 |
|------|------|
| `/status` | 查看桥接状态 |
| `/sandbox` | 查看 / 切换 sandbox 模式 |

---

## 🔐 安全须知

- **`credentials.json`** 和 **`bridge-state.json`** 是本地凭据文件，**不要提交到 Git**（已在 `.gitignore` 中排除）
- 使用 `allowedUserIds` 限制哪些微信用户可以使用你的 Agent
- Codex 版：通过 `sandboxMode` 控制 Agent 执行权限
- Cursor 版：`force: false` 时，每次危险操作都需要微信端确认
- **不要将 `cwd` 指向你不信任的仓库**——Agent 可以读写其中所有文件

---

## 🏗️ 架构概览

```
┌──────────┐     ilink API      ┌──────────────┐     exec/query     ┌────────────┐
│  微信用户 │ ◄──────────────► │  Node 桥接层  │ ◄────────────────► │ Agent CLI  │
│  (手机)   │   ClawBot 协议    │  (bridge.ts)  │   codex exec      │ (Codex /   │
└──────────┘                    └──────────────┘   agent --query     │  Cursor)   │
                                      │                              └────────────┘
                                      │ 媒体解密/编码                       │
                                      ▼                                    ▼
                                 本地文件系统                        你的项目代码
                               (图片/文件缓存)                    + 互联网搜索能力
```

**数据流**：微信消息 → ilink 长轮询 → 桥接层分发 → Agent CLI 执行 → 结果回传微信

---

## 🛠️ 进阶用法

### 作为通用 AI 助手

桥接本身不限于事实核查——它是一个通用的微信 ↔ Agent 桥接层。你可以：

- 发消息让 Agent 帮你写代码、调 bug
- 发文件让 Agent 分析
- 安装其他 Skill 扩展 Agent 能力
- 在微信里切换模型（`/model gpt-5.4`）

### 自定义 Skill

参考 `news-fact-checker/SKILL.md` 的格式，你可以为 Agent 编写任何 Skill：

```yaml
---
name: my-custom-skill
description: >
  简要描述这个 skill 做什么，以及什么时候触发。
---

# Skill 标题

## 工作流程

### Step 1: ...
### Step 2: ...
```

### 多用户部署

在 `bridge.config.json` 中设置 `allowedUserIds` 和 `replyAllowedUserIds`，可以精细控制哪些微信用户能发指令、哪些能查看 Agent 回复。

---

## ❓ 常见问题

<details>
<summary>扫码时显示二维码但扫不上？</summary>

检查服务器网络是否能访问微信 ilink 域名。企业网络可能需要配置代理。
</details>

<details>
<summary>发消息后没有任何回复？</summary>

1. 检查 tmux 会话中的日志：`tmux attach -t wechat-codex`
2. Codex 用户：确认已 `codex login`
3. Cursor 用户：确认 `agent --version` 可用，或已设置 `CURSOR_API_KEY`
4. 检查 `bridge.config.json` 中的 `cwd` 路径是否存在
</details>

<details>
<summary>支持群聊吗？</summary>

目前仅支持 ClawBot 机器人的 **私聊** 对话。
</details>

<details>
<summary>tmux 重启后怎么恢复？</summary>

```bash
# 再次启动即可，会话状态保存在 bridge-state.json
tmux new-session -d -s wechat-codex 'cd /path/to/templates && npm start'
```
</details>

<details>
<summary>Codex 版和 Cursor 版选哪个？</summary>

| | Codex 版 | Cursor 版 |
|---|---|---|
| 需要的订阅 | OpenAI Codex | Cursor Pro |
| 权限模型 | sandbox 模式 | 逐条微信审批 |
| 适合 | 批量任务、自动化 | 需要精细控制的场景 |
</details>

---

## 🤝 贡献

欢迎提交 Issue 和 PR。如果你编写了有趣的 Skill，也欢迎提交到本仓库分享。

---

## 📄 License

MIT

---

> **免责声明**：事实核查结果基于 AI 的搜索和分析能力，不构成专业的新闻审核意见。对于重大决策，请以官方信源为准。
