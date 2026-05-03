#!/usr/bin/env bash
set -euo pipefail

require_tend_runtime() {
  if ! command -v npx >/dev/null 2>&1; then
    echo "SKIP: npx unavailable"
    exit 0
  fi

  if ! command -v tsx >/dev/null 2>&1; then
    echo "SKIP: tsx unavailable"
    exit 0
  fi
}

create_tend_fixture_root() {
  local prefix="$1"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  TMP_DIR="$(mktemp -d "/tmp/${prefix}.XXXXXX")"
  REPO_DIR="$TMP_DIR/repo"
  FAKE_BIN="$TMP_DIR/bin"
  STATE_DIR="$TMP_DIR/state"
  mkdir -p "$REPO_DIR" "$FAKE_BIN" "$STATE_DIR"
  export SCRIPT_DIR REPO_ROOT TMP_DIR REPO_DIR FAKE_BIN STATE_DIR PATH="$FAKE_BIN:$PATH"
}

cleanup_tend_fixture_root() {
  rm -rf "${TMP_DIR:-}"
}

write_fake_gh() {
  cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$GH_CALL_LOG"

case "${1:-} ${2:-} ${3:-}" in
  "repo view --json")
    printf '%s\n' "${GH_REPO:-acme/widgets}"
    ;;
  "pr list --base")
    cat "$GH_PR_LIST_FILE"
    ;;
  "pr list --label")
    if [[ -f "${GH_MERGING_LIST_FILE:-}" ]]; then
      cat "$GH_MERGING_LIST_FILE"
    else
      printf '[]\n'
    fi
    ;;
  "pr view"*)
    pr_number="${3:-}"
    cat "${GH_PR_VIEW_DIR}/${pr_number}.json"
    ;;
  "pr checks"*)
    pr_number="${3:-}"
    if [[ -f "${GH_PR_CHECKS_DIR:-}/$pr_number.json" ]]; then
      cat "${GH_PR_CHECKS_DIR}/$pr_number.json"
    else
      cat "$GH_PR_CHECKS_FILE"
    fi
    ;;
  "pr merge"*)
    pr_number="${3:-}"
    printf '%s\n' "$pr_number" >> "$GH_MERGED_LOG"
    if [[ -f "${GH_PR_LIST_FILE:-}" ]]; then
      node -e "const fs=require('fs');const file=process.argv[1];const pr=Number(process.argv[2]);const data=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file, JSON.stringify(data.filter((item)=>item.number!==pr)));" "$GH_PR_LIST_FILE" "$pr_number"
    fi
    ;;
  "pr close"*)
    pr_number="${3:-}"
    printf '%s\n' "$pr_number" >> "$GH_CLOSED_LOG"
    ;;
  "pr comment"*)
    pr_number="${3:-}"
    printf '%s\n' "$pr_number" >> "$GH_COMMENT_LOG"
    ;;
  "api repos/"*)
    if [[ "${2:-}" == repos/*/commits/*/check-runs ]]; then
      cat "$GH_CHECK_RUNS_FILE"
    else
      printf '{}\n'
    fi
    ;;
  "api --method POST")
    printf '{}\n'
    ;;
  "api --method DELETE")
    printf '{}\n'
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 1
    ;;
esac
EOF
  chmod +x "$FAKE_BIN/gh"
}

write_fake_npx() {
  local real_npx
  local real_tsx
  real_npx="$(command -v npx)"
  real_tsx="$(command -v tsx)"

  cat > "$FAKE_BIN/npx" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "tsx" ]]; then
  shift
  export PATH="$FAKE_BIN:\$PATH"
  exec "$real_tsx" "\$@"
fi

exec "$real_npx" "\$@"
EOF
  chmod +x "$FAKE_BIN/npx"
}

write_fake_git() {
  cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$GIT_CALL_LOG"

if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--git-common-dir" ]]; then
  printf '%s\n' "$GIT_COMMON_DIR"
  exit 0
fi

if [[ "${1:-}" == "rev-parse" && "${2:-}" == "auto/integration" ]]; then
  printf '%s\n' "${GIT_INTEGRATION_SHA:-1111111111111111111111111111111111111111}"
  exit 0
fi

if [[ "${1:-}" == "rev-parse" && "${2:-}" == origin/* ]]; then
  printf '%s\n' "${GIT_BRANCH_SHA:-2222222222222222222222222222222222222222}"
  exit 0
fi

if [[ "${1:-}" == "worktree" && "${2:-}" == "add" ]]; then
  # Skip the optional --detach flag so we always pluck the worktree path
  # whether the caller is `git worktree add <path> <branch>` or
  # `git worktree add --detach <path> <ref>`.
  shift 2
  if [[ "${1:-}" == "--detach" ]]; then
    shift
  fi
  mkdir -p "${1:-}"
  exit 0
fi

if [[ "${1:-}" == "worktree" && "${2:-}" == "remove" ]]; then
  rm -rf "${4:-}"
  exit 0
fi

if [[ "${1:-}" == "fetch" ]]; then
  exit 0
fi

if [[ "${1:-}" == "rebase" && "${2:-}" == "--abort" ]]; then
  exit 0
fi

if [[ "${1:-}" == "rebase" ]]; then
  if [[ "${GIT_REBASE_FAIL:-0}" == "1" ]]; then
    echo "${GIT_REBASE_FAIL_MESSAGE:-rebase conflict}" >&2
    exit 1
  fi
  exit 0
fi

if [[ "${1:-}" == "push" ]]; then
  exit 0
fi

if [[ "${1:-}" == "remote" && "${2:-}" == "get-url" ]]; then
  printf '%s\n' "git@github.com:${GH_REPO:-acme/widgets}.git"
  exit 0
fi

echo "unexpected git args: $*" >&2
exit 1
EOF
  chmod +x "$FAKE_BIN/git"
  mkdir -p "$STATE_DIR/git-common"
  export GIT_COMMON_DIR="$STATE_DIR/git-common"
}

write_pr_view() {
  local pr_number="$1"
  local title="$2"
  local branch="$3"
  local base_branch="$4"
  local labels_json="$5"
  local body_file="$6"

  mkdir -p "$STATE_DIR/pr-view"
  cat > "$STATE_DIR/pr-view/${pr_number}.json" <<EOF
{
  "number": ${pr_number},
  "title": "${title}",
  "body": $(node -e "const fs=require('fs');process.stdout.write(JSON.stringify(fs.readFileSync(process.argv[1],'utf8')))" "$body_file"),
  "state": "OPEN",
  "author": { "login": "wavemill" },
  "headRefName": "${branch}",
  "baseRefName": "${base_branch}",
  "labels": ${labels_json},
  "url": "https://github.com/${GH_REPO:-acme/widgets}/pull/${pr_number}",
  "createdAt": "2026-04-28T12:00:00Z",
  "updatedAt": "2026-04-28T12:00:00Z",
  "mergedAt": null,
  "closedAt": null
}
EOF
}
