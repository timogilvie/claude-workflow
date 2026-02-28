# HOK-845 Plan: Fix Control Pane Crash in Monitor Loop

## Problem Summary
The tmux control pane monitor process is generated from a heredoc in `shared/lib/wavemill-mill.sh` and runs with `set -euo pipefail`. During active task monitoring (especially around PR creation/merge transitions), the monitor can exit unexpectedly, crashing the control pane.

## Findings from Code Research
1. `pr_state` is called in the monitor loop but is not defined in monitor scope.
   - Call site: `shared/lib/wavemill-mill.sh` (monitor heredoc), around `elif [[ "$(pr_state "$PR")" == "CLOSED" ]]; then`
   - In the standalone monitor process, this becomes a `command not found` error and can terminate execution under `set -e`.
2. `local debug_flag` is used in non-function scope inside the monitor loop.
   - Locations: two eval blocks in the monitor loop.
   - In bash, `local` outside a function returns non-zero (`local: can only be used in a function`), which also triggers termination under `set -e`.
3. Existing shell regression checks miss these failure modes.
   - `tests/check-shell.sh` does not include `pr_state` in critical monitor functions.
   - Current function-call detection is not reliably catching command substitution calls like `$(pr_state "$PR")`.
   - There is no guard that forbids `local` in monitor top-level loop code.

## Implementation Plan

### Phase 1: Fix monitor runtime crash paths
1. Update monitor heredoc in `shared/lib/wavemill-mill.sh`:
   - Add a monitor-scope `pr_state()` helper near other GitHub functions.
   - Replace top-level `local debug_flag=""` with plain assignment (`debug_flag=""`) in both eval blocks.
2. Keep behavior unchanged except crash prevention:
   - `pr_state` should remain non-fatal and return empty string on API error.
   - eval hook invocation semantics remain unchanged.

Validation after Phase 1:
- `bash -n shared/lib/wavemill-mill.sh`
- `bash tests/check-shell.sh`

### Phase 2: Add monitor-loop crash containment
1. Refactor monitor per-issue processing into a dedicated function (for example `monitor_issue_state`) so:
   - loop-local variables use valid `local` scope by construction
   - one issue’s processing error does not terminate the whole monitor process
2. Wrap per-issue invocation with explicit failure handling:
   - on error, log issue id + context and continue to next issue
   - keep the monitor loop alive even if a single status check command fails unexpectedly
3. Add a lightweight error trap for diagnosability:
   - emit line number and last command on unexpected errors before continuing or exiting
   - avoid silent control-pane termination

Validation after Phase 2:
- `bash -n shared/lib/wavemill-mill.sh`
- `bash tests/check-shell.sh`

### Phase 3: Strengthen shell regression tests
1. Extend `tests/check-shell.sh` critical function list to include `pr_state`.
2. Add explicit monitor heredoc guards:
   - Assert `pr_state()` is defined in extracted monitor heredoc.
   - Assert no `local` declarations appear in non-function monitor-loop sections (targeted check for the loop region).
   - Assert per-issue processing is invoked through a guarded call path (to prevent full-loop exits from uncaught failures).
3. Keep checks deterministic and lightweight (no tmux/network needed).

Validation after Phase 3:
- `bash tests/check-shell.sh`

### Phase 4: End-to-end smoke and PR preparation
1. Run project-level relevant tests/lint for shell and workflow safety:
   - `bash tests/run-custom-tests.sh` (or nearest existing command set if this script delegates)
2. Inspect diff for minimality and ensure no unrelated changes.
3. Commit with clear message.
4. Create PR:
   - Title: `HOK-845: Prevent monitor control pane crash during PR state transitions`
   - Body includes required `## Summary`, `## Changes`, and `## Test plan` sections.
   - Link PR to `HOK-845`.

## Risk Assessment
- Medium risk: changes touch monitor control-flow and failure semantics.
- Main risk: containment logic accidentally masking errors or miscounting active tasks.
  - Mitigation: target checks to known problematic patterns and keep them scoped to monitor heredoc content.
  - Mitigation: keep failure-handling behavior explicit in logs and preserve existing task-state transitions.

## Success Criteria Mapping
- Implementation matches issue: monitor no longer exits on PR state checks or eval debug flag setup.
- Lint/tests pass: shell checks pass with new regression guards.
- No regressions: PR detection/merge handling behavior remains unchanged except improved robustness and better crash isolation.
