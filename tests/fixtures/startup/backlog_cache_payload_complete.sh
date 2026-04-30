#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/wavemill-common.sh"

complete_payload='{
  "identifier": "HOK-1456",
  "title": "Use backlog cache",
  "description": "Details",
  "labels": { "nodes": [ { "name": "Area:Startup" } ] },
  "relations": { "nodes": [] },
  "inverseRelations": { "nodes": [] }
}'

empty_values_payload='{
  "identifier": "HOK-1456",
  "title": "Use backlog cache",
  "description": "",
  "labels": { "nodes": [] },
  "relations": { "nodes": [] },
  "inverseRelations": { "nodes": [] }
}'

expect_complete() {
  local name="$1" payload="$2"
  if ! issue_payload_is_complete "$payload"; then
    echo "expected complete payload: $name" >&2
    exit 1
  fi
}

expect_incomplete() {
  local name="$1" payload="$2"
  if issue_payload_is_complete "$payload"; then
    echo "expected incomplete payload: $name" >&2
    exit 1
  fi
}

expect_complete "all fields present" "$complete_payload"
expect_complete "empty description and arrays" "$empty_values_payload"

expect_incomplete "missing identifier" '{
  "title": "Use backlog cache",
  "description": "Details",
  "labels": { "nodes": [] },
  "relations": { "nodes": [] },
  "inverseRelations": { "nodes": [] }
}'

expect_incomplete "null title" '{
  "identifier": "HOK-1456",
  "title": null,
  "description": "Details",
  "labels": { "nodes": [] },
  "relations": { "nodes": [] },
  "inverseRelations": { "nodes": [] }
}'

expect_incomplete "missing labels nodes" '{
  "identifier": "HOK-1456",
  "title": "Use backlog cache",
  "description": "Details",
  "labels": {},
  "relations": { "nodes": [] },
  "inverseRelations": { "nodes": [] }
}'

expect_incomplete "missing relations nodes" '{
  "identifier": "HOK-1456",
  "title": "Use backlog cache",
  "description": "Details",
  "labels": { "nodes": [] },
  "relations": {},
  "inverseRelations": { "nodes": [] }
}'

expect_incomplete "missing inverse relations nodes" '{
  "identifier": "HOK-1456",
  "title": "Use backlog cache",
  "description": "Details",
  "labels": { "nodes": [] },
  "relations": { "nodes": [] },
  "inverseRelations": {}
}'

expect_incomplete "empty input" ""
