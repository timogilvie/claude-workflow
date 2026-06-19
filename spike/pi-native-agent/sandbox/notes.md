# Planning notes (sandbox fixture)

This file lives inside the pretend worktree and is readable in the planning phase.
The agent is expected to read this successfully, and to be DENIED when it tries to
read a path that escapes the worktree (e.g. ../secrets.env).
