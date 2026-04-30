#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/agent-adapters.sh"

tmp_dir="$(mktemp -d)"
log_file="$tmp_dir/status.log"
stdout_file="$tmp_dir/stdout"
stderr_file="$tmp_dir/stderr"

export STATUS_LOG_FILE="$log_file"
if ! _agent_log_warn "fixture log routing" >"$stdout_file" 2>"$stderr_file"; then
  echo "_agent_log_warn failed when STATUS_LOG_FILE is set" >&2
  exit 1
fi
if [[ -s "$stdout_file" || -s "$stderr_file" ]]; then
  echo "warn log leaked to process stdio when STATUS_LOG_FILE is set" >&2
  exit 1
fi
if [[ ! -s "$log_file" ]]; then
  echo "warn log was not written to STATUS_LOG_FILE" >&2
  exit 1
fi
logged_line="$(cat "$log_file")"
if ! [[ "$logged_line" =~ ^[0-9]{2}:[0-9]{2}:[0-9]{2}\ WARN:\  ]]; then
  echo "warn log format changed in STATUS_LOG_FILE path: $logged_line" >&2
  exit 1
fi

unset STATUS_LOG_FILE
: > "$stdout_file"
: > "$stderr_file"
if ! _agent_log_warn "fixture stderr fallback" >"$stdout_file" 2>"$stderr_file"; then
  echo "_agent_log_warn failed when STATUS_LOG_FILE is unset" >&2
  exit 1
fi
if [[ -s "$stdout_file" ]]; then
  echo "warn log wrote to stdout during stderr fallback" >&2
  exit 1
fi
stderr_line="$(cat "$stderr_file")"
if [[ -z "$stderr_line" ]]; then
  echo "warn log did not write to stderr when STATUS_LOG_FILE was unset" >&2
  exit 1
fi
if ! [[ "$stderr_line" =~ ^[0-9]{2}:[0-9]{2}:[0-9]{2}\ WARN:\  ]]; then
  echo "warn log format changed in stderr fallback path: $stderr_line" >&2
  exit 1
fi

rm -rf "$tmp_dir"
