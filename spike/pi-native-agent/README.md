# Pi native-runtime embed spike (throwaway)

Backs the **"Pi source spike findings"** section of
[`docs/native-agent-runtime-plan.md`](../../docs/native-agent-runtime-plan.md).
Proves *in executed code* that `pi-agent-core` can be embedded as Wavemill's
native runtime while Wavemill keeps ownership of tool execution, phase policy,
and the transcript.

## Run

```bash
cd spike/pi-native-agent
npm install
npm run spike   # or: node spike.mjs
```

Exits non-zero if any kill criterion fails.

## What it proves

A deterministic mock "Hokusai" provider (no network) drives a two-turn planning
run: turn 1 requests two `read_file` calls (one inside the worktree, one that
escapes it), turn 2 produces a final answer.

| Kill criterion | Pi seam exercised | Evidence in output |
| --- | --- | --- |
| **(a)** phase policy runs *before* tool exec; denial fed back to model | `AgentLoopConfig.beforeToolCall({ block, reason })` | `../secrets.env` is denied pre-exec; the allowed read succeeds; the denial becomes an `isError` tool result |
| **(b)** custom provider, no core fork | `registerApiProvider({ api, stream, streamSimple })` + `Model.api` dispatched through `getApiProvider()` | the run completes using `api: "hokusai-mock"` |
| **(c)** usage → `SessionModelUsage` | pi `Usage{input,output,cacheRead,cacheWrite}` | totals map to `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}` |

Wavemill owns the `read_file` executor and the planning-phase policy; Pi owns
only the provider turn and the loop. A Wavemill-style `NativeAgentEvent`
transcript is derived from Pi's `AgentEvent` stream into `native-session.jsonl`,
showing the format is not opaque.

## Not covered here (still Wavemill-owned per the plan)

`NativePatch` envelope, worktree isolation, MCP, sub-agents, real provider
adapters, and the Linear/PR/ready workflow tools. This spike is intentionally
the minimal proof of the embed seam, against pinned `pi@0.79.8`.
