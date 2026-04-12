#!/usr/bin/env bash
set -euo pipefail

# Write agent lifecycle status into the wavemill dashboard status file.
# Environment:
#   WAVEMILL_SESSION - tmux session name
#   WAVEMILL_ISSUE   - issue identifier (for example HOK-1221)
# Usage:
#   wavemill-status-writer.sh <status>

session="${WAVEMILL_SESSION:-}"
issue="${WAVEMILL_ISSUE:-}"

[[ -n "$session" && -n "$issue" ]] || exit 0

printf '%s\n' "${1:-}" > "/tmp/${session}-${issue}-status.txt"
