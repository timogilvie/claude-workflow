#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario coding_complete_launches_review
register_lifecycle_scenario pr_with_real_review_artifact_enters_ready
register_lifecycle_scenario pr_without_review_artifact_relaunches_review

setup_coding_complete_launches_review() {
  CURRENT_PHASE="coding"
  MONITOR_ITERATIONS=2
  write_stage_result "$FEATURE_DIR" "coding" "running" "$CURRENT_AGENT"
  printf '{"stage":"coding","confidence":"high"}\n' > "$FEATURE_DIR/.coding-complete"
}

assert_coding_complete_launches_review() {
  local output="$1"

  check_contains "coding complete reaches review phase" "$output" "phase=review"
  check_contains "coding complete records coding completed" "$output" "|coding|completed|"
  check_contains "coding complete starts review" "$output" "|review|running|"
  check_contains "coding complete launches review" "$output" "review_launches=1"
}

setup_pr_with_real_review_artifact_enters_ready() {
  CURRENT_PHASE="review"
  PR="862"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  cat > "$FEATURE_DIR/.review-result.json" <<JSON
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":862,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0,"history":["kept"]}}
JSON
}

assert_pr_with_real_review_artifact_enters_ready() {
  local output="$1"

  check_contains "real review artifact enters ready" "$output" "phase=ready"
  check_contains "real review artifact launches ready" "$output" "ready_launches=1"
  check_contains "real review artifact preserves exit code" "$output" '"exitCode":0'
  check_contains "real review artifact preserves history field" "$output" '"history":["kept"]'
}

setup_pr_without_review_artifact_relaunches_review() {
  CURRENT_PHASE="review"
  PR="863"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  rm -f "$FEATURE_DIR/.review-result.json"
}

assert_pr_without_review_artifact_relaunches_review() {
  local output="$1"

  check_contains "missing review artifact stays review" "$output" "phase=review"
  check_contains "missing review artifact records running review" "$output" "|review|running|"
  check_contains "missing review artifact launches review" "$output" "review_launches=1"
  check_contains "missing review artifact does not launch ready" "$output" "ready_launches=0"
  check_contains "missing review artifact records missing evidence" "$output" '"missingReviewEvidence":true'
}
