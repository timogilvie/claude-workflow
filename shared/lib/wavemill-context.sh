#!/opt/homebrew/bin/bash
set -euo pipefail

# Wavemill Context - Subsystem documentation lifecycle management
#
# This script provides commands for managing subsystem documentation:
# - init: Bootstrap subsystem specs from codebase analysis
# - update <subsystem>: Refresh a specific subsystem spec
# - check: Drift detection across all specs
# - search <query>: Keyword search across subsystem specs

REPO_DIR="${REPO_DIR:-$PWD}"

# Source common library and load layered config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
load_config "$REPO_DIR"

# Validate dependencies
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }

# Logging
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }

# ============================================================================
# SUBCOMMAND HANDLERS
# ============================================================================

cmd_init() {
  log "Initializing subsystem documentation..."
  echo ""

  # Parse flags
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force|-f)
        args+=("--force")
        shift
        ;;
      --interactive|-i)
        args+=("--interactive")
        shift
        ;;
      *)
        log_error "Unknown flag: $1"
        show_help
        exit 1
        ;;
    esac
  done

  # Run context-init.ts
  if npx tsx "$TOOLS_DIR/context-init.ts" "${args[@]}" "$REPO_DIR"; then
    echo ""
    log "✓ Subsystem documentation initialized"
    return 0
  else
    local rc=$?
    echo ""
    log_error "Initialization failed"
    return "$rc"
  fi
}

cmd_update() {
  local subsystem_id="$1"
  shift

  if [[ -z "$subsystem_id" ]]; then
    log_error "Missing required argument: <subsystem-id>"
    echo ""
    echo "Usage: wavemill context update <subsystem-id> [options]"
    echo ""
    echo "Options:"
    echo "  --no-confirm    Skip diff confirmation"
    exit 1
  fi

  log "Updating subsystem: $subsystem_id"
  echo ""

  # Parse flags
  local args=("$subsystem_id")
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-confirm)
        args+=("--no-confirm")
        shift
        ;;
      *)
        log_error "Unknown flag: $1"
        exit 1
        ;;
    esac
  done

  # Run context-update.ts
  if npx tsx "$TOOLS_DIR/context-update.ts" "${args[@]}" "$REPO_DIR"; then
    echo ""
    log "✓ Subsystem updated"
    return 0
  else
    local rc=$?
    echo ""
    log_error "Update failed"
    return "$rc"
  fi
}

cmd_check() {
  # Parse flags
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)
        args+=("--json")
        shift
        ;;
      *)
        log_error "Unknown flag: $1"
        exit 1
        ;;
    esac
  done

  # Run context-check.ts
  if npx tsx "$TOOLS_DIR/context-check.ts" "${args[@]}" "$REPO_DIR"; then
    return 0
  else
    local rc=$?
    return "$rc"
  fi
}

cmd_search() {
  local query="$1"
  shift

  if [[ -z "$query" ]]; then
    log_error "Missing required argument: <query>"
    echo ""
    echo "Usage: wavemill context search <query> [options]"
    echo ""
    echo "Options:"
    echo "  --limit N       Max results to show (default: 10)"
    echo "  --section NAME  Search only in specific section"
    exit 1
  fi

  # Parse flags
  local args=("$query")
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit)
        args+=("--limit" "$2")
        shift 2
        ;;
      --section)
        args+=("--section" "$2")
        shift 2
        ;;
      *)
        log_error "Unknown flag: $1"
        exit 1
        ;;
    esac
  done

  # Run context-search.ts
  if npx tsx "$TOOLS_DIR/context-search.ts" "${args[@]}" "$REPO_DIR"; then
    return 0
  else
    local rc=$?
    return "$rc"
  fi
}

show_help() {
  cat <<EOF
Wavemill Context - Subsystem documentation lifecycle management

Usage:
  wavemill context <command> [options]

Commands:
  init              Bootstrap subsystem specs from codebase analysis
                    Options:
                      --force, -f        Overwrite existing specs
                      --interactive, -i  Prompt for subsystem confirmation

  update <id>       Refresh a specific subsystem spec
                    Arguments:
                      <id>              Subsystem ID (e.g., 'linear-api')
                    Options:
                      --no-confirm      Skip diff confirmation

  check             Report stale/orphaned/undocumented subsystems
                    Options:
                      --json            Output JSON format

  search <query>    Keyword search across subsystem specs
                    Arguments:
                      <query>           Search term
                    Options:
                      --limit N         Max results (default: 10)
                      --section NAME    Search only specific section

Examples:
  # Initialize subsystem documentation
  wavemill context init

  # Force regenerate all specs
  wavemill context init --force

  # Update a specific subsystem
  wavemill context update linear-api

  # Check for stale documentation
  wavemill context check

  # Search for "error handling"
  wavemill context search "error handling"

  # Search with limit
  wavemill context search "api" --limit 5

EOF
}

# ============================================================================
# MAIN DISPATCHER
# ============================================================================

main() {
  local subcommand="${1:-}"

  if [[ -z "$subcommand" ]]; then
    show_help
    exit 0
  fi

  shift

  case "$subcommand" in
    init)
      cmd_init "$@"
      ;;
    update)
      cmd_update "$@"
      ;;
    check)
      cmd_check "$@"
      ;;
    search)
      cmd_search "$@"
      ;;
    help|--help|-h)
      show_help
      exit 0
      ;;
    *)
      log_error "Unknown subcommand: $subcommand"
      echo ""
      show_help
      exit 1
      ;;
  esac
}

main "$@"
