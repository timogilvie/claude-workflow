#!/usr/bin/env bash

_with_timeout_pre_change() {
  local secs=$1
  shift

  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
    return $?
  fi

  "$@" &
  local cmd_pid=$!
  ( sleep "$secs" && kill "$cmd_pid" 2>/dev/null ) >/dev/null 2>&1 &
  local wd_pid=$!

  wait "$cmd_pid" 2>/dev/null
  local rc=$?

  kill "$wd_pid" 2>/dev/null || true

  return "$rc"
}
