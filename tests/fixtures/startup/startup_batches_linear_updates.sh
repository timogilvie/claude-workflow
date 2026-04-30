#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

main_body="$(awk '/^main\(\)/{flag=1} flag{print} /^}\s*$/{if(flag){exit}}' "$RUNNER")"
phase_body="$(awk '/^startup_run_task_phases\(\)/{flag=1} flag{print} /^}\s*$/{if(flag){exit}}' "$RUNNER")"
linear_batch_fn="$(awk '/^linear_batch_set_state\(\)/{flag=1} flag{print} /^}\s*$/{if(flag){exit}}' "$RUNNER")"

if [[ -z "$main_body" || -z "$phase_body" ]]; then
  echo "failed to extract runner functions" >&2
  exit 1
fi

if ! grep -q 'linear_batch_set_state "In Progress"' <<<"$main_body"; then
  echo "main() does not batch set Linear state" >&2
  exit 1
fi

if grep -q 'linear_set_state' <<<"$phase_body"; then
  echo "startup_run_task_phases still calls per-issue linear_set_state" >&2
  exit 1
fi

if ! grep -q 'progress_update "\$startup_id" linear done' <<<"$phase_body"; then
  echo "startup_run_task_phases no longer marks linear progress done" >&2
  exit 1
fi

# Verify new failure-and-fallback logging patterns
if ! grep -q 'WARN: Batch Linear state update' <<<"$linear_batch_fn"; then
  echo "linear_batch_set_state does not log WARN on batch failure" >&2
  exit 1
fi

if ! grep -q 'INFO: Linear state' <<<"$linear_batch_fn"; then
  echo "linear_batch_set_state does not log INFO on fallback success" >&2
  exit 1
fi

if ! grep -q 'failed_details' <<<"$linear_batch_fn"; then
  echo "linear_batch_set_state does not track per-issue failure details" >&2
  exit 1
fi
