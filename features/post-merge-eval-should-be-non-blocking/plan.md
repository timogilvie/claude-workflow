# HOK-983 Plan: Make Post-Merge Eval Non-Blocking

## Problem Summary
`shared/lib/wavemill-mill.sh` currently runs the post-merge eval hook synchronously inside the control-pane monitor loop. Even though the comments say "non-blocking", the monitor waits for `_with_timeout ... npx tsx tools/run-eval-hook.ts` to finish before it can continue processing input or other task transitions. That freezes the control pane during a long eval.

## Findings from Code Research
1. The merged-PR path still executes eval inline in the monitor loop.
   - Location: `shared/lib/wavemill-mill.sh`, merged-PR block around the existing `log "  📊 Running post-merge eval..."` call.
   - Impact: the monitor cannot react to keyboard input or schedule another task until the eval process exits.
2. The "completed externally" path has the same synchronous pattern.
   - Location: `shared/lib/wavemill-mill.sh`, post-completion eval block used for cross-repo/manual completion.
   - Impact: the same control-pane freeze exists there too, and the two paths should stay behaviorally aligned.
3. Eval completion state is currently marked immediately after the blocking call returns.
   - `mark_eval_completed()` updates `.tasks[$issue].evalCompleted` in the state file.
   - If eval is moved into the background, completion marking must move with it; otherwise we would either mark too early or rerun eval repeatedly.
4. There is no dedicated helper today for detached eval execution.
   - Challenge eval uses the same synchronous `_with_timeout` pattern.
   - The safest change is to introduce a focused helper for post-merge/post-completion background eval rather than changing unrelated challenge behavior in this task.
5. Existing shell regression coverage is the closest validation surface.
   - `tests/check-shell.sh` already inspects `wavemill-mill.sh`.
   - Repo test entrypoints also include shell syntax and custom tests that can catch monitor regressions.

## Implementation Plan

### Phase 1: Introduce a background post-merge eval launcher
1. Add a small helper in `shared/lib/wavemill-mill.sh` dedicated to detached eval execution for normal mill tasks.
   - Resolve the eval agent the same way current inline code does.
   - Spawn the eval hook in a background subshell with its own log file.
   - After the hook exits, stream or append meaningful status to logs and then call `mark_eval_completed`.
   - Ensure the helper itself returns immediately so the monitor loop stays responsive.
2. Keep failure handling non-fatal.
   - Background eval should still swallow eval-hook failures and mark completion after the attempt, matching the current "best effort, never block workflow" intent.
   - Logging should make it clear whether the background launch succeeded and where output went.

Validation after Phase 1:
- `bash -n shared/lib/wavemill-mill.sh`

### Phase 2: Switch the synchronous monitor paths to the new helper
1. Replace the inline synchronous eval call in the merged-PR path with the new detached helper.
2. Replace the inline synchronous eval call in the completed-externally path with the same helper so both flows remain consistent.
3. Preserve existing guards and semantics:
   - only run when `AUTO_EVAL=true`
   - skip when `evalCompleted=true`
   - keep `validate_agent_set` behavior
   - avoid changing challenge-task handling unless required by implementation details

Validation after Phase 2:
- `bash -n shared/lib/wavemill-mill.sh`
- `bash tests/check-shell.sh`

### Phase 3: Add regression coverage for the non-blocking behavior contract
1. Extend shell checks if needed so the monitor script keeps the detached launch path intact.
   - Prefer lightweight static assertions over slow/integration-heavy tests.
   - Focus on preventing accidental reintroduction of inline `_with_timeout ... run-eval-hook.ts` in the merged/completed monitor paths.
2. If the current shell test suite has an appropriate section, add a targeted assertion there rather than creating a new framework.

Validation after Phase 3:
- `bash tests/check-shell.sh`
- `bash tests/run-custom-tests.sh`

### Phase 4: Full verification and handoff
1. Run the most relevant repo tests for the touched areas.
   - `bash tests/check-shell.sh`
   - `bash tests/run-custom-tests.sh`
   - `npm run test:shell`
2. Review the diff for scope control and confirm the control-pane monitor no longer waits on eval.
3. After implementation approval and completion, proceed with the required self-review and PR workflow from the task instructions.

## Risk Assessment
- Medium risk: the change touches the control-pane monitor and shared state updates.
- Main risks:
  - marking eval complete too early or not at all once execution is detached
  - background jobs writing logs or state in a way that races with the monitor
  - accidentally changing challenge-eval behavior while fixing normal post-merge eval
- Mitigations:
  - keep detached logic isolated in one helper
  - move completion marking into the detached execution path
  - limit scope to standard post-merge/post-completion flows unless a broader change is strictly necessary

## Success Criteria Mapping
- The control pane remains responsive after a PR merge while eval runs in the background.
- Another task can be selected/executed without waiting for eval to finish.
- Eval still runs automatically and updates `evalCompleted` after the background attempt finishes.
- Shell/tests covering the touched monitor logic pass.
