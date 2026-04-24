# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

本仓库是 **微信 ↔ 本地 AI Agent CLI** 的桥接工具集与技能包（Skills）。它让用户可以在微信里给本机运行的 Agent 发图文/文件，驱动 Agent 执行任务（默认场景是新闻截图事实核查，也可以用作通用远程 AI 助手）。

仓库由 4 个相互独立、可单独部署的子项目组成：

| 目录 | 类型 | 作用 |
|------|------|------|
| `wechat-cursor_agent_bridge-skill/` | Node 桥接服务 + Skill | 微信 ↔ **Claude Agent SDK**（与 Cursor / Claude Code 同源工具与权限语义）。默认推荐方案。支持微信侧对每次工具调用逐条审批 |
| `wechat-codex_agent_bridge-skill/` | Node 桥接服务 + Skill | 微信 ↔ **OpenAI Codex CLI**（`codex exec --json`）。不支持逐条工具审批，通过 sandbox 模式控制权限边界 |
| `news-fact-checker/` | 纯 Markdown Skill（无代码） | 新闻截图事实核查的 Agent 提示词。安装到 `~/.cursor/skills/` 或 `~/.codex/skills/` 下供 Agent 调用 |
| `openclaw-weixin/` | TypeScript SDK（Tencent 官方 fork） | 微信 ilink / ClawBot 通信协议 SDK。**仅作参考**，桥接服务已经在 `ilink.ts` 里内联实现了必要部分 |

两个桥接子项目（cursor 版、codex 版）**结构高度对称**：都有 `templates/src/{bridge.ts, ilink.ts, setup.ts, config.ts, inbound-media.ts, types.ts}` 和 `bridge.config.example.json`。修改一边的协议/媒体处理时，通常也要同步到另一边。

## 核心架构

```
微信用户(手机) ──ilink/ClawBot──► Node 桥接层 ──exec/query──► Agent CLI
                                       │                      (Codex 或
                                       │                     Claude Agent SDK)
                               媒体解密/编码/落盘
                                       │
                                       ▼
                               本地文件系统 + 项目代码
```

**关键数据流**（以 cursor 版为例）：

1. `bridge.ts` 主循环轮询微信 `getupdates`
2. 收到消息 → 由 `inbound-media.ts` 解密/下载媒体 → 组装 prompt
3. 调用 Claude Agent SDK 的 `query()`；工具调用经 `permission-gate.ts` 走 `canUseTool` → 把权限请求发到微信 → 等待用户回复 1/2/3 → 放行或跳过
4. Agent 输出按 `maxMessageLength` 分条发回微信

**关键全局规则**（源自 `news-fact-checker/SKILL.md`）：
- 发给微信的单条消息字符上限约 2048，超限会被微信静默替换为"请稍后再试"。news-fact-checker Skill 强制把最终回复压在 **800 字 / 1600 字符**以内。任何新增的"输出到微信"的 Skill 都必须遵守这个约束。

**ilink 协议的对齐点**（源自 `wechat-cursor_agent_bridge-skill/SKILL.md`）：`templates/src/ilink.ts` 的行为与 Tencent 官方 `openclaw-weixin` SDK 对齐，具体包括请求头 `iLink-App-Id` / `iLink-App-ClientVersion` / `X-WECHAT-UIN`、`base_info.channel_version`、CDN 下载 URL 的拼接方式、长轮询超时返回 `{ret:0, msgs:[]}`、`scaned_but_redirect` 时切换 `redirect_host`、可选的 `ILINK_SK_ROUTE_TAG` 环境变量等。修改 `ilink.ts` 时对照 `openclaw-weixin/` 与上游 <https://github.com/Tencent/openclaw-weixin>。

## 常用命令

所有桥接开发命令都在各自的 `templates/` 目录下执行（Node 18+；codex 版实测在 Node 22+ 更稳定）。

### Cursor 版桥接

```bash
cd wechat-cursor_agent_bridge-skill/templates
npm install
cp bridge.config.example.json bridge.config.json   # 改 cwd 为你的 Agent 工作目录
npm run setup       # 扫码绑定微信，生成 credentials.json（只需一次）
npm start           # 启动桥接（tsx src/bridge.ts）
npm run dev         # 带 --watch 的开发模式
```

### Codex 版桥接

```bash
cd wechat-codex_agent_bridge-skill/templates
npm install
cp bridge.config.example.json bridge.config.json
npm run setup
npm start                   # 正常启动
npm run hot                 # 热重载开发模式
npm run typecheck           # tsc --noEmit
npm run test:usage-footer   # usage-footer 冒烟测试
```

### 后台运行

README 推荐用 tmux 跑桥接进程：

```bash
tmux new-session -d -s wechat-cursor 'npm start'
tmux attach -t wechat-cursor    # 查看日志，Ctrl+B D 退出
```

### openclaw-weixin（SDK fork，正常不改）

```bash
cd openclaw-weixin
npm test          # vitest run --coverage
npm run typecheck
npm run build
```

### news-fact-checker Skill 的安装与依赖

Skill 本身无需编译，直接把 `SKILL.md` 复制到 Agent 技能目录即可。依赖 Skill（`last30days` / `last30days-cn`）由脚本统一拉取：

```bash
bash news-fact-checker/dependencies/install-skill-deps.sh cursor   # → ~/.cursor/skills/
bash news-fact-checker/dependencies/install-skill-deps.sh codex    # → ~/.codex/skills/
bash news-fact-checker/dependencies/install-skill-deps.sh agents   # → ~/.agents/skills/
```

该脚本对已存在的依赖目录会执行 `git pull --ff-only`，本地改动会导致更新失败。

## 配置与凭据

- `bridge.config.json`、`credentials.json`、`bridge-state.json` **包含本地凭据，已在 `.gitignore` 中排除，禁止提交**。改配置前先读 `bridge.config.example.json`。
- 关键字段差异：
  - Cursor 版：`force`（是否自动批准所有工具）、`agentPath`、`permissionMode`、`allowDangerouslySkipPermissions`
  - Codex 版：`sandboxMode`（`read-only` / `workspace-write` / `danger-full-access`）、`codexPath`、`enableSession`
- 两版共有：`cwd`（必填，Agent 工作目录）、`model`、`agentTimeoutMs`、`allowedUserIds`、`maxMessageLength`、`showToolCalls`。

## 上游同步工作流（本仓库是 fork）

本地 remote 布局：

| Remote | 指向 | 用途 |
|--------|------|------|
| `origin` | `noewangjy/wechat-agent-skills`（自己的 repo） | 日常 push/pull |
| `upstream` | `kaixindelele/wechat_agent_bridge_skills`（原开源 repo） | 只拉不推，push 已被 `git remote set-url --push upstream DISABLED` 禁用 |

本地分支布局：

| 分支 | 跟踪 | 用途 |
|------|------|------|
| `main` | `origin/main` | 自己的主干，所有开发改动发这里 |
| `upstream` | `upstream/main` | 原开源 repo 的镜像分支，只用于同步 |

**同步原 repo 更新到自己的 main**：

```bash
# 1. 更新本地 upstream 分支
git checkout upstream
git pull                     # 等价于 git fetch upstream && git merge upstream/main

# 2. 合并到自己的 main
git checkout main
git merge upstream           # 或 git rebase upstream（历史更线性）

# 3. 推到自己的 repo
git push origin main
```

不要直接在 `upstream` 分支上修改/提交；它只作为上游镜像使用。
