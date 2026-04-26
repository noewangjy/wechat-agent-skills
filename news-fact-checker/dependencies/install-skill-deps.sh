#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash news-fact-checker/dependencies/install-skill-deps.sh [codex|cursor|claude|agents] [--root DIR]

Install or update the recommended dependency skills for news-fact-checker:
  - last30days
  - last30days-cn

Examples:
  bash news-fact-checker/dependencies/install-skill-deps.sh codex
  bash news-fact-checker/dependencies/install-skill-deps.sh cursor
  bash news-fact-checker/dependencies/install-skill-deps.sh claude
  bash news-fact-checker/dependencies/install-skill-deps.sh agents
  bash news-fact-checker/dependencies/install-skill-deps.sh codex --root /tmp/test-skills
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1" >&2
    exit 1
  fi
}

sync_repo() {
  local name="$1"
  local repo="$2"
  local dest="$DEST_ROOT/$name"

  if [ -d "$dest/.git" ]; then
    local current_origin
    current_origin="$(git -C "$dest" remote get-url origin 2>/dev/null || true)"
    if [ -n "$current_origin" ] && [ "$current_origin" != "$repo" ] && [ "$current_origin" != "${repo%.git}" ]; then
      echo "ERROR: $dest exists but points to a different origin: $current_origin" >&2
      exit 1
    fi
    echo "==> Updating $name in $dest"
    git -C "$dest" pull --ff-only
    return
  fi

  if [ -e "$dest" ]; then
    echo "ERROR: $dest already exists and is not a git repository" >&2
    exit 1
  fi

  echo "==> Cloning $name into $dest"
  git clone --depth 1 "$repo" "$dest"
}

TARGET="codex"
CUSTOM_ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    codex|cursor|claude|agents|openclaw|clawhub)
      TARGET="$1"
      shift
      ;;
    --root)
      if [ $# -lt 2 ]; then
        echo "ERROR: --root requires a directory path" >&2
        exit 1
      fi
      CUSTOM_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$TARGET" in
  codex)
    DEFAULT_ROOT="$HOME/.codex/skills"
    ;;
  cursor)
    DEFAULT_ROOT="$HOME/.cursor/skills"
    ;;
  claude)
    DEFAULT_ROOT="$HOME/.claude/skills"
    ;;
  agents|openclaw|clawhub)
    DEFAULT_ROOT="$HOME/.agents/skills"
    ;;
  *)
    echo "ERROR: unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

DEST_ROOT="${CUSTOM_ROOT:-$DEFAULT_ROOT}"

require_cmd git
mkdir -p "$DEST_ROOT"

sync_repo "last30days" "https://github.com/mvanhorn/last30days-skill.git"
sync_repo "last30days-cn" "https://github.com/Jesseovo/last30days-skill-cn.git"

cat <<EOF
Done.

Installed dependency skills into:
- $DEST_ROOT/last30days
- $DEST_ROOT/last30days-cn

Recommended runtime notes:
- last30days: python3.12+ recommended
- last30days-cn: python3 required
- optional for last30days-cn: pip install jieba
- optional crawler boost for last30days-cn: pip install playwright && playwright install chromium
EOF
