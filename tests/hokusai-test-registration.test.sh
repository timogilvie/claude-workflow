#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="${HOKUSAI_TEST_REGISTRATION_REPO_DIR:-$DEFAULT_REPO_DIR}"

if [[ -n "${HOKUSAI_TEST_REGISTRATION_BASELINE:-}" ]]; then
  BASELINE_FILE="$HOKUSAI_TEST_REGISTRATION_BASELINE"
elif [[ "$REPO_DIR" == "$DEFAULT_REPO_DIR" ]]; then
  BASELINE_FILE="$SCRIPT_DIR/test-registration-baseline.txt"
else
  BASELINE_FILE=""
fi

run_registration_check() {
  local repo_dir="$1"
  local baseline_file="${2:-}"
  local unit_runner="$repo_dir/tests/run-unit-tests.sh"
  local custom_runner="$repo_dir/tests/run-custom-tests.sh"
  declare -A registered=()
  declare -A baseline=()
  local rel
  local missing=()
  local stale_baseline=()
  local roots=()

  for root in "$repo_dir/shared" "$repo_dir/tools" "$repo_dir/src"; do
    [[ -d "$root" ]] && roots+=("$root")
  done

  if (( ${#roots[@]} == 0 )); then
    echo "No scoped TypeScript test roots found."
    return 0
  fi

  if [[ -f "$unit_runner" ]]; then
    while IFS= read -r rel; do
      [[ "$rel" == *.test.ts ]] && registered["$rel"]=1
    done < <(bash "$unit_runner" --list)
  fi

  if [[ -f "$custom_runner" ]]; then
    while IFS= read -r rel; do
      registered["shared/lib/$rel"]=1
    done < <(
      awk '
        /^for f in \\/ && seen == 0 { in_for=1; seen=1; next }
        in_for && /^; do/ { in_for=0 }
        in_for && $1 ~ /\.test\.ts$/ { print $1 }
      ' "$custom_runner"
    )
  fi

  if [[ -n "$baseline_file" && -f "$baseline_file" ]]; then
    while IFS= read -r rel; do
      [[ -z "$rel" || "$rel" == \#* ]] && continue
      baseline["$rel"]=1
      if [[ ! -f "$repo_dir/$rel" ]]; then
        stale_baseline+=("$rel")
      fi
    done < "$baseline_file"
  fi

  while IFS= read -r test_file; do
    rel="${test_file#$repo_dir/}"
    if [[ -z "${registered[$rel]:-}" && -z "${baseline[$rel]:-}" ]]; then
      missing+=("$rel")
    fi
  done < <(find "${roots[@]}" -name '*.test.ts' -type f | sort)

  if (( ${#missing[@]} > 0 )); then
    echo "TypeScript test files missing from central test registration:" >&2
    printf '  %s\n' "${missing[@]}" >&2
  fi

  if (( ${#stale_baseline[@]} > 0 )); then
    echo "Stale test registration baseline entries:" >&2
    printf '  %s\n' "${stale_baseline[@]}" >&2
  fi

  if (( ${#missing[@]} > 0 || ${#stale_baseline[@]} > 0 )); then
    return 1
  fi
}

run_negative_case() {
  local tmp_dir
  local output
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  mkdir -p "$tmp_dir/shared/lib" "$tmp_dir/tools" "$tmp_dir/src" "$tmp_dir/tests"
  touch "$tmp_dir/shared/lib/unregistered.test.ts"
  cat > "$tmp_dir/tests/run-unit-tests.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--list" ]]; then
  exit 0
fi
SH
  chmod +x "$tmp_dir/tests/run-unit-tests.sh"

  if output="$(
    HOKUSAI_TEST_REGISTRATION_REPO_DIR="$tmp_dir" \
    HOKUSAI_TEST_REGISTRATION_CHECK_ONLY=1 \
    bash "$0" 2>&1
  )"; then
    echo "Negative registration fixture unexpectedly passed." >&2
    return 1
  fi

  if [[ "$output" != *"shared/lib/unregistered.test.ts"* ]]; then
    echo "Negative registration fixture did not report the missing test path." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
}

run_registration_check "$REPO_DIR" "$BASELINE_FILE"

if [[ "${HOKUSAI_TEST_REGISTRATION_CHECK_ONLY:-0}" != "1" ]]; then
  run_negative_case
  echo "All scoped TypeScript tests are registered or baselined."
fi
