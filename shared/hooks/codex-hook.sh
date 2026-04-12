#!/opt/homebrew/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shared/hooks/wavemill-hook-protocol.sh
source "$SCRIPT_DIR/wavemill-hook-protocol.sh"

wavemill_hook_check

event="${1:-}"
payload=$(cat 2>/dev/null || true)
[[ -n "$event" ]] || exit 0

case "$event" in
  SessionStart)
    wavemill_hook_write "idle" "$event" "" "codex"
    ;;
  UserPromptSubmit)
    wavemill_hook_write "working" "$event" "" "codex"
    ;;
  PreToolUse)
    detail=$(printf '%s' "$payload" | jq -r '.tool_name // .toolName // .tool.name // .tool // empty' 2>/dev/null || true)
    wavemill_hook_write "working" "$event" "$detail" "codex"
    ;;
  Stop)
    wavemill_hook_write "idle" "$event" "" "codex"
    ;;
  *)
    ;;
esac

exit 0
