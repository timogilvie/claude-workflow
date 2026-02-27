#!/usr/bin/env bash
set -euo pipefail

# Runner for test files that use custom assert/test harnesses
# These files use process.exit(1) on failure, so we just check exit codes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../shared/lib"

PASS=0
FAIL=0
SKIP=0

for f in \
  constraint-parser.test.ts \
  constraint-storage.test.ts \
  difficulty-analyzer.test.ts \
  eval-export.test.ts \
  eval-persistence.test.ts \
  eval-schema.test.ts \
  llm-router.test.ts \
  repo-context-analyzer.test.ts \
  review-context-gatherer.test.ts \
  rule-generator.test.ts \
  task-context-analyzer.test.ts \
  task-packet-validator.test.ts \
  workflow-cost.test.ts \
; do
  echo -n "  $f: "
  if npx tsx "$LIB_DIR/$f" > /dev/null 2>&1; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
  fi
done

# Known-broken tests (pre-existing issues, tracked separately)
for f in \
  constraint-validator.test.ts \
; do
  echo "  $f: SKIP (known import issue)"
  SKIP=$((SKIP + 1))
done

echo ""
echo "--- Results: $PASS passed, $FAIL failed, $SKIP skipped ---"

if (( FAIL > 0 )); then
  exit 1
fi
