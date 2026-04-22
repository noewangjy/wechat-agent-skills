# news-fact-checker 依赖 Skills

`news-fact-checker` 推荐预装两个“最近 30 天研究”外部 Skill，用来补充截图事实核查里的社区线索、传播路径和近期上下文：

- `last30days`
  - 仓库：`https://github.com/mvanhorn/last30days-skill`
  - 用途：英文/全球社区近 30 天研究，覆盖 Reddit、X、YouTube、GitHub、Hacker News、Web 等
- `last30days-cn`
  - 仓库：`https://github.com/Jesseovo/last30days-skill-cn`
  - 用途：中文互联网近 30 天研究，覆盖微博、小红书、B 站、知乎、抖音、微信公众号、百度、头条等

这些依赖不会 vendoring 到本仓库；安装脚本会直接把上游仓库 clone 到用户本机的技能目录，便于后续单独更新。

## 安装位置

- Codex：`~/.codex/skills/last30days`、`~/.codex/skills/last30days-cn`
- Cursor：`~/.cursor/skills/last30days`、`~/.cursor/skills/last30days-cn`
- OpenClaw / ClawHub：`~/.agents/skills/last30days`、`~/.agents/skills/last30days-cn`

## 一键安装

```bash
# 安装到 Codex 技能目录
bash news-fact-checker/dependencies/install-skill-deps.sh codex

# 安装到 Cursor 技能目录
bash news-fact-checker/dependencies/install-skill-deps.sh cursor

# 安装到 OpenClaw / ClawHub 技能目录
bash news-fact-checker/dependencies/install-skill-deps.sh agents
```

也可以指定自定义目录，便于测试：

```bash
bash news-fact-checker/dependencies/install-skill-deps.sh codex --root /tmp/news-fact-checker-skill-test
```

## 运行前提示

- `last30days` 建议 `python3.12+`
- `last30days-cn` 需要 `python3`
- 若要让 `last30days-cn` 覆盖更多中文平台，建议额外执行：

```bash
pip install jieba
pip install playwright
playwright install chromium
```

## 更新依赖

脚本对已存在的依赖目录会执行 `git pull --ff-only`。如果用户在依赖目录里有本地改动，更新会失败，此时应先手动处理依赖目录的工作区。
