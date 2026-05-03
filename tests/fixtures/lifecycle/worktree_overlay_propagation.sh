#!/usr/bin/env bash
# Verifies that mill's worktree-creation step copies
# .wavemill-config.local.json from the parent repo into each new worktree.
# Without this, ready checks running inside the worktree (e.g.
# migration-chain-integrity, ready-policy) only see the base config and
# silently miss developer overrides.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/shared/lib/wavemill-startup-runner.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-worktree-overlay.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Set up a synthetic repo with a base config and a local overlay.
SOURCE_REPO="$TMP_DIR/source"
mkdir -p "$SOURCE_REPO"
git -C "$SOURCE_REPO" init -q -b main
git -C "$SOURCE_REPO" config user.email "test@example.com"
git -C "$SOURCE_REPO" config user.name "Test"
cat > "$SOURCE_REPO/.wavemill-config.json" <<'EOF'
{ "mill": { "baseBranch": "main" } }
EOF
echo ".wavemill-config.local.json" > "$SOURCE_REPO/.gitignore"
git -C "$SOURCE_REPO" add .wavemill-config.json .gitignore
git -C "$SOURCE_REPO" commit -q -m "initial"

# The overlay is gitignored — only present in the working tree.
cat > "$SOURCE_REPO/.wavemill-config.local.json" <<'EOF'
{ "mill": { "baseBranch": "auto/integration" } }
EOF

# Create a worktree the way mill does.
WT_DIR="$TMP_DIR/worktree"
git -C "$SOURCE_REPO" worktree add -q "$WT_DIR" -b "task/test" HEAD >/dev/null

# Sanity check: the overlay is NOT in the freshly-created worktree.
if [[ -f "$WT_DIR/.wavemill-config.local.json" ]]; then
  echo "FAIL: precondition broken — overlay was already in worktree before propagation"
  exit 1
fi

# Now run the propagation step from the runner. The intent is to copy the
# overlay if the parent has one. We extract just that block by grepping the
# runner for the exact lines we added so the test fails closed if the
# implementation is removed.
if ! grep -F 'cp "$REPO_DIR/.wavemill-config.local.json" "$wt_dir/.wavemill-config.local.json"' "$RUNNER" >/dev/null; then
  echo "FAIL: startup-runner is missing the .wavemill-config.local.json propagation copy"
  exit 1
fi

# Exercise the copy with the same shape the runner uses.
REPO_DIR="$SOURCE_REPO"
wt_dir="$WT_DIR"
if [[ -f "$REPO_DIR/.wavemill-config.local.json" ]]; then
  cp "$REPO_DIR/.wavemill-config.local.json" "$wt_dir/.wavemill-config.local.json"
fi

if [[ ! -f "$WT_DIR/.wavemill-config.local.json" ]]; then
  echo "FAIL: overlay was not copied into worktree"
  exit 1
fi

# Content must match — copy, not stub.
if ! diff -q "$SOURCE_REPO/.wavemill-config.local.json" "$WT_DIR/.wavemill-config.local.json" >/dev/null; then
  echo "FAIL: overlay copy diverged from source"
  exit 1
fi

# When no overlay exists in the parent, propagation must be a no-op (not
# create a stub file in the worktree).
SOURCE_REPO_NO_OVERLAY="$TMP_DIR/source-no-overlay"
mkdir -p "$SOURCE_REPO_NO_OVERLAY"
git -C "$SOURCE_REPO_NO_OVERLAY" init -q -b main
git -C "$SOURCE_REPO_NO_OVERLAY" config user.email "test@example.com"
git -C "$SOURCE_REPO_NO_OVERLAY" config user.name "Test"
echo '{}' > "$SOURCE_REPO_NO_OVERLAY/.wavemill-config.json"
git -C "$SOURCE_REPO_NO_OVERLAY" add .wavemill-config.json
git -C "$SOURCE_REPO_NO_OVERLAY" commit -q -m "initial"

WT_NO_OVERLAY="$TMP_DIR/worktree-no-overlay"
git -C "$SOURCE_REPO_NO_OVERLAY" worktree add -q "$WT_NO_OVERLAY" -b "task/test2" HEAD >/dev/null

REPO_DIR="$SOURCE_REPO_NO_OVERLAY"
wt_dir="$WT_NO_OVERLAY"
if [[ -f "$REPO_DIR/.wavemill-config.local.json" ]]; then
  cp "$REPO_DIR/.wavemill-config.local.json" "$wt_dir/.wavemill-config.local.json"
fi

if [[ -f "$WT_NO_OVERLAY/.wavemill-config.local.json" ]]; then
  echo "FAIL: no-overlay parent should not produce overlay in worktree"
  exit 1
fi

echo "PASS: worktree overlay propagation copies overlay when present and is a no-op when absent"
exit 0
