# Lifecycle Scenario Fixtures

This directory contains golden lifecycle scenarios for `tests/lifecycle-scenarios.test.sh`.
Each `*.sh` file registers one scenario and defines two functions:

```bash
register_lifecycle_scenario scenario_name

setup_scenario_name() {
  # Configure controller state, files, git state, and stub variables.
}

assert_scenario_name() {
  local output="$1"
  # Assert on captured phase, stage writes, logs, markers, and cleanup calls.
}
```

The harness extracts the real controller functions from `shared/lib/wavemill-mill.sh`,
stubs external systems, creates an isolated temp worktree, and runs
`monitor_issue_state "$ISSUE"`.

## Adding a Scenario

1. Create `tests/fixtures/lifecycle/<scenario_name>.sh`.
2. Register it with `register_lifecycle_scenario <scenario_name>`.
3. Implement `setup_<scenario_name>` with only the state needed for the case.
4. Implement `assert_<scenario_name>` using the shared assertion helpers.
5. Run `bash tests/lifecycle-scenarios.test.sh`.

Use `MONITOR_ITERATIONS=2` when a production flow requires one controller pass to
record a stage result and the next pass to advance from the newly resolved phase.
Planning approval and coding completion marker flows usually need this.

## Common Setup Helpers

- `create_git_worktree` initializes a minimal git repository at `$WT_DIR`. Use it
  for scenarios that exercise `validate_planning_phase_output`.
- `$FEATURE_DIR` points at `features/$SLUG` inside the scenario worktree.
- `write_stage_result "$FEATURE_DIR" <stage> <status> ...` writes a minimal stage
  result and records the write in `stage_calls`.

## Assertion Helpers

- `check_contains <name> <output> <needle>`
- `check_not_contains <name> <output> <needle>`
- `check_eq <name> <expected> <actual>`
- `check_file_exists <name> <path>`
- `check_file_absent <name> <path>`
- `check_file_content <name> <expected> <path>`

The scenario output includes `phase`, `attention`, `stage_calls`, `phase_calls`,
launch counts, cleanup calls, Linear calls, post-merge eval calls, and logs.

## Stub Controls

Set these variables in `setup_*` to steer common controller branches:

- `CURRENT_PHASE`: current task phase returned by `get_task_phase`.
- `PR` and `PR_BY_ISSUE["$ISSUE"]`: cached PR number.
- `PR_STATUS`: value returned by `pr_state`.
- `VALIDATE_MERGED=true`: makes `validate_pr_merge` succeed.
- `AUTO_EVAL=true` and `EVAL_COMPLETED=false`: enables post-merge eval behavior.
- `LINEAR_UPDATES=true`: enables captured `linear_set_state` calls.
- `CHALLENGE_TASK=true`, `CHALLENGE_SIBLING_PR`, and `CHALLENGE_SIBLING_STATE`:
  exercise challenge PR cleanup decisions.
- `CHALLENGE_ROLE` / `CHALLENGE_AUTO_MERGE`: drive the closed-PR resource policy (`closed_pr_resource_policy`); a challenger under auto-merge gets pane-release-only, everything else full cleanup.
