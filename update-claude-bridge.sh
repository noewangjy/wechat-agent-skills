#!/usr/bin/env bash
# 一键更新并重启微信 ↔ Claude Code 桥接
#
# 默认行为：
#   1. 从脚本所在仓库目录拉取 origin/main（--ff-only，不允许 merge）
#   2. 进入 wechat-claude-code_agent_bridge-skill/templates 跑 npm install
#   3. 重启名为 wechat-claude 的 tmux 会话（kill 旧 → 后台起新）
#   4. 打印 tmux 查看 / 退出方法
#
# 参数：
#   --session <name>   自定义 tmux 会话名（默认 wechat-claude）
#   --no-restart       只更新 + 安装依赖，不动 tmux / 不重启
#   --branch <name>    拉取的远端分支（默认 main）
#   -h, --help         帮助

set -euo pipefail

# ---- 配色 ----
if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"; C_BOLD="$(printf '\033[1m')"
  C_RED="$(printf '\033[31m')"; C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"; C_BLUE="$(printf '\033[34m')"; C_DIM="$(printf '\033[2m')"
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_DIM=""
fi
info()  { printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*"; }
ok()    { printf '%s✓%s %s\n'   "${C_GREEN}${C_BOLD}" "${C_RESET}" "$*"; }
warn()  { printf '%s⚠%s  %s\n'  "${C_YELLOW}${C_BOLD}" "${C_RESET}" "$*"; }
err()   { printf '%s✗%s %s\n'   "${C_RED}${C_BOLD}"   "${C_RESET}" "$*" >&2; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---- 解析参数 ----
SESSION="wechat-claude"
BRANCH="main"
DO_RESTART=1

while [ $# -gt 0 ]; do
  case "$1" in
    --session)    [ $# -ge 2 ] || { err "--session 需要一个参数"; exit 2; }; SESSION="$2"; shift 2 ;;
    --branch)     [ $# -ge 2 ] || { err "--branch 需要一个参数";  exit 2; }; BRANCH="$2";  shift 2 ;;
    --no-restart) DO_RESTART=0; shift ;;
    -h|--help)    usage ;;
    *)            err "未知参数：$1"; usage ;;
  esac
done

# ---- 定位仓库根（脚本所在目录） ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
TEMPLATE_DIR="$REPO_ROOT/wechat-claude-code_agent_bridge-skill/templates"

if [ ! -d "$REPO_ROOT/.git" ]; then
  err "$REPO_ROOT 不是 git 仓库，脚本应放在仓库根目录"
  exit 1
fi
if [ ! -d "$TEMPLATE_DIR" ]; then
  err "找不到 $TEMPLATE_DIR"
  exit 1
fi

cd "$REPO_ROOT"

# ---- ① 检查工作区整洁度 ----
info "检查本地 git 状态..."
if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交改动："
  git status --short
  printf '%s请先 commit / stash / 丢弃，再运行本脚本。%s\n' "${C_YELLOW}" "${C_RESET}"
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  warn "当前分支是 '$CURRENT_BRANCH'，不是 '$BRANCH'。将尝试直接 pull，分支不一致时 --ff-only 会失败。"
fi

# ---- ② 拉取更新 ----
info "git fetch origin..."
git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
BASE="$(git merge-base HEAD "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  ok "已经是最新：$(git log -1 --oneline)"
elif [ "$LOCAL" = "$BASE" ]; then
  info "即将应用的新 commit："
  git log --oneline "HEAD..origin/$BRANCH" | sed 's/^/    /'
  git pull --ff-only origin "$BRANCH"
  ok "已更新到 $(git log -1 --oneline)"
elif [ "$REMOTE" = "$BASE" ]; then
  warn "本地领先远端 $(git rev-list --count "origin/$BRANCH..HEAD") 个 commit，无需 pull。"
  git log --oneline "origin/$BRANCH..HEAD" | sed 's/^/    /'
else
  err "本地和远端已分叉。请手动处理后再运行本脚本。"
  exit 1
fi

# ---- ③ 安装依赖 ----
info "进入 $TEMPLATE_DIR 安装依赖..."
cd "$TEMPLATE_DIR"
if ! command -v npm >/dev/null 2>&1; then
  err "找不到 npm，请先安装 Node.js 18+"
  exit 1
fi
npm install --silent
ok "npm install 完成"

# ---- ④ 可选：重启 tmux 会话 ----
if [ "$DO_RESTART" -eq 0 ]; then
  warn "已按 --no-restart 跳过服务重启。"
  printf '\n%s手动启动方法：%s\n' "${C_BOLD}" "${C_RESET}"
  printf '    cd %s\n' "$TEMPLATE_DIR"
  printf '    npm start\n\n'
  exit 0
fi

if ! command -v tmux >/dev/null 2>&1; then
  warn "未检测到 tmux，跳过自动重启。"
  printf '\n%s你可以手动前台启动：%s\n' "${C_BOLD}" "${C_RESET}"
  printf '    cd %s && npm start\n\n' "$TEMPLATE_DIR"
  exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  info "终止旧 tmux 会话：$SESSION"
  tmux kill-session -t "$SESSION"
fi

info "在 tmux 会话 '$SESSION' 中后台启动服务..."
# 进入 templates 目录后再起，避免 npm 的 cwd 影响
tmux new-session -d -s "$SESSION" -c "$TEMPLATE_DIR" 'npm start'
sleep 1

if tmux has-session -t "$SESSION" 2>/dev/null; then
  ok "服务已在 tmux 会话 '$SESSION' 中启动"
else
  err "启动失败，tmux 会话不存在。请尝试手动运行 'cd $TEMPLATE_DIR && npm start' 查看错误"
  exit 1
fi

# ---- ⑤ 告诉用户怎么用 ----
cat <<EOF

${C_BOLD}——— 更新完成 ———${C_RESET}

查看日志：
    ${C_GREEN}tmux attach -t ${SESSION}${C_RESET}

退出但不停止服务（在 tmux 里）：
    按 ${C_BOLD}Ctrl+B${C_RESET}，再按 ${C_BOLD}D${C_RESET}

停止服务：
    ${C_DIM}tmux kill-session -t ${SESSION}${C_RESET}

列出所有 tmux 会话：
    ${C_DIM}tmux ls${C_RESET}

EOF
