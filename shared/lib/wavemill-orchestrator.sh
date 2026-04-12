#!/opt/homebrew/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTUP_RUNNER="$SCRIPT_DIR/wavemill-startup-runner.sh"

PLAN_FILE="${WAVEMILL_LAUNCH_PLAN:-${2:-}}"

if [[ -z "$PLAN_FILE" || ! -f "$PLAN_FILE" ]]; then
  echo "wavemill-orchestrator.sh is deprecated." >&2
  echo "Use wavemill-mill.sh to create a launch plan and start tmux." >&2
  echo "Compatibility mode: set WAVEMILL_LAUNCH_PLAN or pass /tmp/<session>-launch-plan.json as the second argument." >&2
  exit 1
fi

exec "$STARTUP_RUNNER" "$PLAN_FILE"
