#!/usr/bin/env bash
# Wednesday installer (source).
#
#   ./install.sh              install/update into ~/wednesday and put the
#                             `wednesday` and `wednesday-mcp` commands on PATH
#   ./install.sh --no-link    install only; print the commands to run by hand
#   ./install.sh --dir PATH   use a different directory
#
# macOS and Linux. On Windows, run the git clone + npm install + npm link steps
# from README.md in a terminal.
set -euo pipefail

REPOSITORY="lab1207/Wednesday"
REPO_URL="https://github.com/${REPOSITORY}.git"
DIR="${WEDNESDAY_HOME:-$HOME/wednesday}"
LINK=1

while (($# > 0)); do
  case "$1" in
    --dir)
      DIR="${2:?--dir needs a path}"
      shift 2
      ;;
    --no-link)
      LINK=0
      shift
      ;;
    --help|-h)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

fail() {
  printf 'wednesday install failed: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required; install Node 24+ from https://nodejs.org and retry."
command -v npm >/dev/null 2>&1 || fail "npm is required; install it with Node.js and retry."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 24 )); then
  fail "Node.js 24 or newer is required (found $(node -v))."
fi

if [[ -d "$DIR/.git" ]]; then
  printf 'Updating %s...\n' "$DIR"
  git -C "$DIR" pull --ff-only
else
  printf 'Cloning %s into %s...\n' "$REPOSITORY" "$DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi

cd "$DIR"
npm install --no-audit --no-fund

if (( LINK )); then
  if npm link; then
    printf '\nwednesday %s installed.\n' "$(node -p "require('./package.json').version")"
    printf 'Commands on PATH: wednesday, wednesday-mcp\n'
  else
    printf '\nInstalled in %s, but npm link failed (a global-prefix permission issue).\n' "$DIR"
    printf 'Either run npm link with a writable prefix, or start the server with:\n'
    printf '  node bin/wednesday-mcp.js\n'
  fi
else
  printf '\nInstalled in %s (not linked).\n' "$DIR"
fi

cat <<'EOF'

Next:
  wednesday setup
  # registers the MCP server with every harness it finds (Claude Code,
  # Claude Desktop, Codex, Cursor, OpenCode), backing up each file it touches.
  #   wednesday setup --dry-run   print the plan, write nothing
  #   wednesday setup --all       also create configs for clients not installed

  wednesday team add demo coder=<model> reviewer=<model> --shape auto
  wednesday team use demo

See README.md and docs/MCP.md.
EOF
