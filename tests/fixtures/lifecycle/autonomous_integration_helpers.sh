#!/usr/bin/env bash

init_autonomous_integration_fixture() {
  local name="$1"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  TMP_DIR="$(mktemp -d "/tmp/wavemill-${name}.XXXXXX")"
  REPO_DIR="$TMP_DIR/repo"
  FAKE_BIN="$TMP_DIR/bin"
  GH_LOG="$TMP_DIR/gh.log"
  GIT_LOG="$TMP_DIR/git.log"
  REAL_GIT="$(command -v git)"
  REAL_NPX="$(command -v npx)"

  export REPO_ROOT REPO_DIR TMP_DIR FAKE_BIN GH_LOG GIT_LOG REAL_GIT REAL_NPX
  mkdir -p "$FAKE_BIN" "$REPO_DIR"
  : > "$GH_LOG"
  : > "$GIT_LOG"

  cleanup_autonomous_integration_fixture() {
    if [[ "${KEEP_TMP:-0}" == "1" ]]; then
      echo "Keeping fixture tmp dir: $TMP_DIR"
      return
    fi
    rm -rf "$TMP_DIR"
  }
  trap cleanup_autonomous_integration_fixture EXIT

  write_fake_git
  write_fake_gh
  write_fake_npx
  export PATH="$FAKE_BIN:$PATH"
  init_git_repo
}

write_fake_git() {
  cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'git %s\n' "$*" >> "${GIT_LOG:?}"

case "$*" in
  "rev-parse --git-common-dir")
    printf '%s/.git\n' "${REPO_DIR:?}"
    exit 0
    ;;
  "fetch origin auto/integration")
    exit 0
    ;;
  "push --force-with-lease="*" origin "*)
    exit 0
    ;;
  "rev-parse origin/"*)
    printf '1111111111111111111111111111111111111111\n'
    exit 0
    ;;
  "rebase --abort")
    printf 'rebase aborted\n'
    exit 0
    ;;
  "rebase origin/auto/integration")
    if [[ "${FAKE_REBASE_CONFLICT:-0}" == "1" ]]; then
      printf 'CONFLICT (content): simulated conflict\n' >&2
      exit 1
    fi
    exit 0
    ;;
esac

exec "${REAL_GIT:?}" "$@"
EOF
  chmod +x "$FAKE_BIN/git"
}

write_fake_gh() {
  cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'gh %s\n' "$*" >> "${GH_LOG:?}"

contains_arg() {
  local needle="$1"
  shift
  local arg
  for arg in "$@"; do
    [[ "$arg" == "$needle" ]] && return 0
  done
  return 1
}

if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  if contains_arg "--label" "$@"; then
    printf '%s\n' "${MERGING_PR_LIST_JSON:-[]}"
  else
    printf '%s\n' "${PR_LIST_JSON:-[]}"
  fi
  exit 0
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "checks" ]]; then
  if [[ -n "${PR_CHECKS_JSON:-}" ]]; then
    printf '%s\n' "$PR_CHECKS_JSON"
  else
    printf '[{"name":"ci","state":"COMPLETED","conclusion":"success"}]\n'
  fi
  exit 0
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "merge" ]]; then
  printf 'merged %s\n' "${3:-unknown}" >> "${GH_LOG:?}"
  exit 0
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "comment" ]]; then
  printf 'commented %s %s\n' "${3:-unknown}" "$*" >> "${GH_LOG:?}"
  exit 0
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "close" ]]; then
  printf 'closed %s %s\n' "${3:-unknown}" "$*" >> "${GH_LOG:?}"
  exit 0
fi

if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
  pr_number="${3:-0}"
  if [[ -n "${PR_VIEW_DIR:-}" && -f "$PR_VIEW_DIR/$pr_number.json" ]]; then
    cat "$PR_VIEW_DIR/$pr_number.json"
  else
    node -e '
      const number = Number(process.argv[1]);
      process.stdout.write(JSON.stringify({
        number,
        title: `PR ${number}`,
        body: "<!-- wavemill-meta\nrisk: low\n-->",
        state: "OPEN",
        author: { login: "bot" },
        headRefName: `task/pr-${number}`,
        baseRefName: "auto/integration",
        labels: [{ name: "wavemill" }, { name: "wm:ready" }],
        url: `https://github.com/example/repo/pull/${number}`,
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
      }));
    ' "$pr_number"
  fi
  exit 0
fi

if [[ "${1:-}" == "repo" && "${2:-}" == "view" ]]; then
  printf 'example/repo\n'
  exit 0
fi

if [[ "${1:-}" == "api" ]]; then
  if [[ "$*" == *check-runs* ]]; then
    if [[ -n "${CHECK_RUNS_JSON:-}" ]]; then
      printf '%s\n' "$CHECK_RUNS_JSON"
    else
      printf '{"check_runs":[{"name":"ci","conclusion":"success"}]}\n'
    fi
  else
    printf '{}\n'
  fi
  exit 0
fi

printf 'unexpected gh command: %s\n' "$*" >&2
exit 1
EOF
  chmod +x "$FAKE_BIN/gh"
}

write_fake_npx() {
  cat > "$FAKE_BIN/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "tsx" ]]; then
  shift
  exec tsx "$@"
fi

exec "${REAL_NPX:?}" "$@"
EOF
  chmod +x "$FAKE_BIN/npx"
}

init_git_repo() {
  git -C "$REPO_DIR" init -q
  git -C "$REPO_DIR" config user.email "fixture@example.com"
  git -C "$REPO_DIR" config user.name "Fixture"
  printf 'base\n' > "$REPO_DIR/file.txt"
  git -C "$REPO_DIR" add file.txt
  git -C "$REPO_DIR" commit -q -m "initial"
  git -C "$REPO_DIR" branch -M main
  git -C "$REPO_DIR" checkout -q -b auto/integration
  git -C "$REPO_DIR" checkout -q main
  git -C "$REPO_DIR" remote add origin https://github.com/example/repo.git
}

create_task_branch() {
  local branch="$1"
  local content="$2"

  git -C "$REPO_DIR" checkout -q -B "$branch" main
  printf '%s\n' "$content" > "$REPO_DIR/${branch//\//-}.txt"
  git -C "$REPO_DIR" add .
  git -C "$REPO_DIR" commit -q -m "$branch"
  git -C "$REPO_DIR" checkout -q main
}

write_integration_config() {
  local ready_policy="${1:-false}"
  local risk_policy="${2:-require-label}"

  cat > "$REPO_DIR/.wavemill-config.json" <<EOF
{
  "mill": {
    "baseBranch": "auto/integration"
  },
  "integration": {
    "enabled": true,
    "integrationBranch": "auto/integration",
    "promotionBranch": "main",
    "mergeMethod": "squash",
    "deleteBranchAfterMerge": true,
    "haltOnRed": true,
    "highRiskPolicy": "manual",
    "readyPolicy": {
      "enabled": $ready_policy,
      "riskPolicy": "$risk_policy",
      "enforceMigrationCoupling": true
    }
  }
}
EOF
}

pr_json() {
  local number="$1"
  local title="$2"
  local branch="$3"
  local created_at="$4"
  local body="$5"
  local labels
  if [[ $# -ge 6 ]]; then
    labels="$6"
  else
    labels='[{"name":"wavemill"},{"name":"wm:ready"}]'
  fi

  BODY="$body" LABELS="$labels" node -e '
    const pr = {
      number: Number(process.argv[1]),
      title: process.argv[2],
      headRefName: process.argv[3],
      createdAt: process.argv[4],
      isDraft: false,
      labels: JSON.parse(process.env.LABELS),
      body: process.env.BODY,
    };
    process.stdout.write(JSON.stringify(pr));
  ' "$number" "$title" "$branch" "$created_at"
}

metadata_body() {
  printf '<!-- wavemill-meta\n%s\n-->' "$1"
}

run_tend_once() {
  (cd "$REPO_ROOT" && npx tsx tools/tend.ts --once --repo-dir "$REPO_DIR")
}

run_tend_dry_run() {
  (cd "$REPO_ROOT" && npx tsx tools/tend.ts --once --dry-run --repo-dir "$REPO_DIR")
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $message"
    echo "Expected to find: $needle"
    echo "Actual:"
    printf '%s\n' "$haystack"
    exit 1
  fi
}

assert_log_count() {
  local pattern="$1"
  local expected="$2"
  local file="$3"
  local actual

  actual="$(grep -c "$pattern" "$file" 2>/dev/null || true)"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: expected $expected matches for '$pattern' in $file, got $actual"
    cat "$file"
    exit 1
  fi
}
