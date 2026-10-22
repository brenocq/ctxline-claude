#!/usr/bin/env bash
# Installs the ctxline status line and the agent-color script into ~/.claude:
#   install.sh [--dry-run]
# Run from a checkout, it installs that checkout's statusline.js and agent-color.js; piped from
# curl, it downloads both from the fork's breno-dev branch. It then sets statusLine (refreshed
# every second, fed by `capcom record-limits` when capcom is on PATH) and subagentStatusLine in
# ~/.claude/settings.json, backing up what it replaces and leaving every other setting alone.
set -euo pipefail

readonly REPO_URL="https://raw.githubusercontent.com/brenocq/ctxline-claude/breno-dev"
readonly HOOKS_DIR="$HOME/.claude/hooks"
readonly SETTINGS_FILE="$HOME/.claude/settings.json"

readonly GREEN=$'\033[0;32m' YELLOW=$'\033[1;33m' RED=$'\033[0;31m' CYAN=$'\033[0;36m'
readonly DIM=$'\033[2m' NC=$'\033[0m'

die() {
  printf '%sError: %s%s\n' "$RED" "$*" "$NC" >&2
  exit 1
}

ok() {
  printf '%s✓ %s%s\n' "$GREEN" "$*" "$NC"
}

# Prints the directory holding this script when it holds both files to install; prints nothing
# when the script arrived on stdin or sits outside a checkout.
checkout_dir() {
  local self=${BASH_SOURCE[0]:-} dir
  [[ -n $self && -f $self ]] || return 0
  dir=$(cd -P -- "$(dirname -- "$self")" && pwd -P)
  if [[ -f $dir/statusline.js && -f $dir/agent-color.js ]]; then
    printf '%s\n' "$dir"
  fi
}

download() {
  local url=$1 dest=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest"
  else
    die "neither curl nor wget found; install one, or run this script from a checkout"
  fi
}

# Sets statusLine and subagentStatusLine in settings.json (created when missing), written through
# a temporary file so a failure leaves the old file in place.
write_settings() {
  MAIN=$1 SUB=$2 node - "$SETTINGS_FILE" <<'EOF'
const fs = require('fs');
const file = process.argv[2];
let settings = {};
if (fs.existsSync(file)) {
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`${file} is not valid JSON (${e.message}); fix it and run the installer again`);
    process.exit(1);
  }
}
settings.statusLine = { type: 'command', command: process.env.MAIN, refreshInterval: 1 };
settings.subagentStatusLine = { type: 'command', command: process.env.SUB };
fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n');
fs.renameSync(`${file}.tmp`, file);
EOF
}

main() {
  local dry=0
  case ${1:-} in
    '') ;;
    --dry-run) dry=1 ;;
    *)
      printf 'usage: %s [--dry-run]\n' "${0##*/}" >&2
      exit 2
      ;;
  esac

  printf '\033[38;5;173m█%s \033[38;5;239m█%s %sctxline%s %s· statusline for Claude Code%s\n\n' \
    "$NC" "$NC" "$CYAN" "$NC" "$DIM" "$NC"

  [[ -d $HOME/.claude ]] || die "Claude Code not found (~/.claude is missing); install it first: https://github.com/anthropics/claude-code"
  command -v node >/dev/null 2>&1 || die "node not found; the status line runs on Node.js 18 or later"

  local src from feed='' main_cmd sub_cmd
  src=$(checkout_dir)
  from=${src:-$REPO_URL}
  if command -v capcom >/dev/null 2>&1; then
    feed='capcom record-limits | '
  else
    printf '%scapcom not found: the main line runs without its usage limits feed%s\n' "$YELLOW" "$NC"
  fi
  main_cmd="${feed}node \"$HOOKS_DIR/statusline.js\""
  sub_cmd="node \"$HOOKS_DIR/statusline.js\" subagent"

  if ((dry)); then
    printf 'would install %s/statusline.js -> %s/statusline.js\n' "$from" "$HOOKS_DIR"
    printf 'would install %s/agent-color.js -> %s/agent-color\n' "$from" "$HOOKS_DIR"
    printf 'would set statusLine.command = %s (refreshInterval 1)\n' "$main_cmd"
    printf 'would set subagentStatusLine.command = %s\n' "$sub_cmd"
    return 0
  fi

  if [[ -z $src ]]; then
    printf '%sDownloading from %s...%s\n' "$YELLOW" "$REPO_URL" "$NC"
    src=$(mktemp -d "${TMPDIR:-/tmp}/ctxline.XXXXXX")
    # Expanded now: src is local to main and out of scope when the trap runs.
    # shellcheck disable=SC2064
    trap "rm -rf -- '$src'" EXIT
    download "$REPO_URL/statusline.js" "$src/statusline.js"
    download "$REPO_URL/agent-color.js" "$src/agent-color.js"
  fi

  local stamp
  stamp=$(date +%s)
  mkdir -p "$HOOKS_DIR"
  if [[ -f $HOOKS_DIR/statusline.js ]]; then
    cp "$HOOKS_DIR/statusline.js" "$HOOKS_DIR/statusline.js.backup.$stamp"
  fi
  cp "$src/statusline.js" "$HOOKS_DIR/statusline.js"
  cp "$src/agent-color.js" "$HOOKS_DIR/agent-color"
  chmod +x "$HOOKS_DIR/statusline.js" "$HOOKS_DIR/agent-color"
  ok "Installed statusline.js and agent-color from $from"

  if [[ -f $SETTINGS_FILE ]]; then
    cp "$SETTINGS_FILE" "$SETTINGS_FILE.backup.$stamp"
  fi
  write_settings "$main_cmd" "$sub_cmd" || die "could not update $SETTINGS_FILE"
  ok "Set statusLine and subagentStatusLine in $SETTINGS_FILE (any backups end in .backup.$stamp)"

  printf '\nRestart Claude Code or start a new session.\n\n'
  printf 'To uninstall:\n'
  printf '  - Remove ~/.claude/hooks/statusline.js and ~/.claude/hooks/agent-color\n'
  printf "  - Remove the 'statusLine' and 'subagentStatusLine' sections from ~/.claude/settings.json\n"
}

main "$@"
