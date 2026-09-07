#!/usr/bin/env bash
# Safety control: the task branch's local head changes *during*
# safe_remove_task_worktree_and_branch's own verification window (a commit
# lands between its first `rev-parse` of the branch and the final
# post-verification `rev-parse` re-check). The helper must notice the head
# moved out from under it and preserve the branch
# (verificationReason=local_head_changed) rather than delete a branch it no
# longer has an accurate picture of.
#
# This is deliberately racy in real life, so the fixture forces it
# deterministically: it installs a `git` PATH shim (ahead of the harness's
# generic remote-call counter) that appends a real commit to the task branch
# as a side effect of the FIRST `fetch origin refs/heads/<base>:...` call the
# helper makes - i.e. exactly the network round-trip that sits between the
# helper's initial and final `rev-parse` of the branch.
set -euo pipefail

incident_setup_control_local_head_changed() {
  CONTROL_ISSUE="HOK-4005"
  CONTROL_SLUG="control-local-head-changed"
  local branch="task/$CONTROL_SLUG"
  local wt_dir="$WORKTREE_ROOT/$CONTROL_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'first commit\n' > "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "first commit" >/dev/null
  git -C "$wt_dir" push -u origin "$branch" >/dev/null 2>&1
  git -C "$REPO_DIR" fetch origin "$branch" >/dev/null 2>&1

  # Merge the branch to base so the ancestry/remote checks all pass cleanly
  # and the helper reaches its final re-verification step - that is the
  # step this control targets.
  git -C "$REPO_DIR" merge --ff-only "$branch" >/dev/null
  git -C "$REPO_DIR" push origin auto/integration >/dev/null 2>&1

  local race_marker="$SCENARIO_DIR/race-fired"
  rm -f "$race_marker"
  local real_git
  real_git="$(command -v git)"
  cat > "$BIN_DIR/git" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
args=("\$@")
i=0
while [[ \$i -lt \${#args[@]} && "\${args[\$i]}" == "-C" ]]; do
  i=\$((i + 2))
done
sub="\${args[\$i]:-}"
case "\$sub" in
  fetch|ls-remote|push)
    printf '%s\n' "\${args[*]}" >> "$GIT_REMOTE_CALLS_LOG"
    ;;
esac
if [[ "\$sub" == "fetch" && ! -f "$race_marker" ]]; then
  case "\${args[*]}" in
    *"refs/heads/auto/integration:refs/remotes/origin/auto/integration"*)
      : > "$race_marker"
      "$real_git" -C "$wt_dir" commit --allow-empty -m "raced commit landed mid-verification" >/dev/null 2>&1 || true
      ;;
  esac
fi
exec "$real_git" "\$@"
SHIM
  chmod +x "$BIN_DIR/git"

  local ready_dir="$wt_dir/features/$CONTROL_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  incident_seed_task "$CONTROL_ISSUE" "$(jq -cn \
    --arg slug "$CONTROL_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:"",status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-4005"}')"

  incident_write_hook "$CONTROL_ISSUE" "idle" "Stop" "" "claude"
}
