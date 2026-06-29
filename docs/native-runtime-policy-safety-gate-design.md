---
title: Native Runtime Policy Safety Gate Design
---

# Native Runtime Policy Safety Gate Design

**Status:** design (Epic 8 / HOK-2363)
**Research date:** 2026-06-29
**Deliverable for:** `docs/` — no source code changes

---

## 1. Purpose and Scope

This document:

- Compares Wavemill's native runtime phase-policy semantics against `@gotgenes/pi-permission-system`.
- Defines which patterns Wavemill should borrow and where Wavemill remains the safety authority.
- Defines the integration seams for approval, network, provenance, recovery, and abort/timeout.
- Lists concrete gaps in current Wavemill behavior so downstream implementation issues (Epics 2, 6, 8, 10) can proceed independently from this design.

Scope is **design-only**. No code changes are made by this document. All paths are relative to the repository root.

---

## 2. Non-Delegation / Authority Invariant

**The core invariant:** Wavemill is the safety authority. Plugin or Pi-layer policy can only add restrictions; it can never relax a Wavemill denial.

Formally:

```
effective_decision = deny  if  Wavemill_denies  OR  plugin_denies

i.e.: a Wavemill allow + plugin deny = deny
      a Wavemill deny  + plugin allow = deny  (plugin cannot override Wavemill)
```

This **non-delegation invariant** means:

1. Pi's `beforeToolCall` hook is the adopted enforcement point. Wavemill policy runs first inside this hook. Plugin policy may add further restrictions after Wavemill allows.
2. No plugin's allow grant may override a Wavemill phase denial, path denial, network denial, or user rejection.
3. Safety authority is **not** delegated to `@gotgenes/pi-permission-system` or any other Pi plugin.
4. Untrusted tool result content (repo files, issue bodies, PR comments, diff lines) cannot escalate phase policy, path policy, network policy, approval state, or completion requirements.

Sources:
- `docs/native-agent-runtime-plan.md` § "Build vs. Adopt" and § "Pi plugin ecosystem findings"
- `spike/pi-native-agent/spike.mjs` — proves `beforeToolCall` blocks before exec (kill criterion a)

---

## 3. Comparison Method and Source-of-Truth References

### Evidence classification

Every `@gotgenes/pi-permission-system` primitive is classified:

| Code | Meaning |
|------|---------|
| `R` | Observed in repo evidence (spike code or existing Wavemill implementation) |
| `P` | Inferred from existing plan text (`docs/native-agent-runtime-plan.md`) |
| `Q` | Open question or assumption — not substantiated by spike code or current implementation |

The spike (`spike/pi-native-agent/spike.mjs`) was intentionally minimal — it proves the `beforeToolCall` embed seam only. MCP, skills, and the full permission-system package were not exercised.

### Source-of-truth references

| Topic | Primary source |
|-------|----------------|
| Phase + path policy gate | `shared/lib/native-agent/tools/policies.ts` |
| Workflow mutation matrix | `shared/lib/native-agent/workflow-tools/mutation-policy.ts` |
| Ready-phase per-edit guardrail | `shared/lib/native-agent/workflow-tools/ready-remediation.ts` |
| Command classification | `shared/lib/native-agent/command-classifier.ts` |
| Command substrate enforcement | `shared/lib/native-agent/command-substrate.ts` |
| Permission patterns (safe dialect) | `shared/lib/permission-patterns.ts` |
| Secret redaction (native-agent) | `shared/lib/native-agent/tools/redaction.ts` |
| Text/PII redaction (generic) | `shared/lib/text-redaction.ts` |
| Pi embed kill-criteria proof | `spike/pi-native-agent/spike.mjs` |
| Pi spike README | `spike/pi-native-agent/README.md` |
| Epic 8 deliverables / Pi plugin inventory | `docs/native-agent-runtime-plan.md` § "Pi plugin ecosystem findings" |
| Workflow tool contracts | `docs/native-workflow-tool-contracts.md` |

---

## 4. Primitive Comparison

### 4.1 Most-Restrictive-Wins Layering

**Pi (`@gotgenes/pi-permission-system`) claimed primitives:**
Allow/ask/deny gates with most-restrictive-wins layering across multiple policy plugins. Evidence: **P** — plan text names this as a pattern to study; not exercised in `spike.mjs`.

**Current Wavemill behavior:**
No explicit layering model exists. Checks are sequenced but not formally ordered:

- `policies.ts:evaluateBeforeToolCallPolicy()` runs phase check → path check; first denial returns immediately.
- `mutation-policy.ts:isMutationAllowed()` is a separate matrix with a hard merge-denial invariant.
- `command-substrate.ts:runCommand()` runs class check → cwd check.

These form an implicit three-layer sequence but there is no single "layer merge" function.

**Design:**

Define a four-layer ordering, evaluated top-to-bottom; the first denial wins:

| Priority | Layer | Implementation location | Wavemill-owned? |
|----------|-------|------------------------|-----------------|
| 1 | Phase policy | `beforeToolCall` evaluator — `policies.ts` | Yes |
| 2 | Path policy | Path-field + cross-cutting path check — `policies.ts` | Yes |
| 3 | Network policy | Network allowlist check (new — see Gap G-4) | Yes |
| 4 | Plugin/Pi-layer restrictions | `@gotgenes/pi-permission-system`, if adopted | Plugin (additive only) |

Once a layer denies, later layers are not consulted. The plugin layer (4) is evaluated only after Wavemill's three layers all allow.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Deny-first merge semantics | Pi permission system (concept) | Wavemill defines the rule |
| Phase logic | Wavemill-owned | Wavemill |
| Path logic | Wavemill-owned | Wavemill |
| Network logic | Wavemill-owned (new) | Wavemill |
| Plugin restriction | Pi/gotgenes (additive) | Wavemill; plugin may restrict, never relax |

---

### 4.2 Cross-Cutting Path Gates

**Pi claimed primitives:** Cross-cutting path protection applied to all tool calls regardless of tool type. Evidence: **P** — plan text names it; not exercised in spike.

**Current Wavemill behavior:**
`policies.ts:evaluateBeforeToolCallPolicy()` applies path checks only for tools listed in `config.pathFieldsByTool`. Tools not listed receive no path check regardless of their arguments. This is opt-in per tool, not cross-cutting.

`ready-remediation.ts:evaluateReadyRemediation()` applies a per-edit-path scope check in ready phase — closer to cross-cutting, but only for one phase.

**Design:**

Add a cross-cutting path check that applies to any tool whose arguments include a string or string[] that resolves to a filesystem path:

1. Any path argument resolving outside the worktree is denied (`path_denied`).
2. Path traversal sequences (`..`) that escape the worktree root are denied.
3. Wavemill-owned system paths (stage results, session JSONL) may be exempted by an explicit phase-policy allowlist, not by general exception logic.
4. The worktree root is fixed at phase-launch time; it may not be derived from tool arguments or untrusted content.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Cross-cutting application concept | Pi pattern | Wavemill applies it |
| Worktree boundary definition | Wavemill-owned (per-worktree launch) | Wavemill |
| Path normalization | `policies.ts:resolveCandidatePath()` (existing) | Wavemill |

---

### 4.3 Outside-Worktree Gates

**Pi claimed primitives:** Outside-cwd checks denying reads or writes outside the process working directory. Evidence: **R** — directly proven in `spike/pi-native-agent/spike.mjs`. The `../secrets.env` read is denied by `planningPhasePolicy()` via `beforeToolCall` before the executor is invoked; the denial reason `path_denied: '../secrets.env' resolves outside the worktree` is fed back to the model as an error tool result.

**Current Wavemill behavior:**

- `policies.ts:resolveCandidatePath()` + `normalizeWorktreeRoot()` — resolve a candidate path against the worktree root; return `kind: 'inside' | 'outside'`.
- `command-substrate.ts:resolveAllowedCwd()` — rejects attempts to spawn a process with a cwd outside the allowed roots.

Both are implemented.

**Design:**

The existing Wavemill implementation is correct and complete for path arguments. The Pi `beforeToolCall` hook is the right enforcement point.

**Conflict resolution rule:** If a tool is phase-allowed but a path argument resolves outside the worktree, the decision is `path_denied`. Phase and path reasons are separate; both are surfaced in the transcript event as the applicable `reason` field.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Denial before execution | Pi `beforeToolCall` seam | Wavemill owns the policy logic |
| Path resolution | `policies.ts` (existing) | Wavemill |
| cwd enforcement for commands | `command-substrate.ts` (existing) | Wavemill |

---

### 4.4 Bash Pattern Policy

**Pi claimed primitives:** Bash pattern gates classifying shell commands as safe or dangerous before execution. Evidence: **P** — plan names this as a pattern to study; `permission-patterns.ts` is the Wavemill equivalent already.

**Current Wavemill behavior:**

- `permission-patterns.ts:isSafePattern()` — checks a command against a dangerous-pattern list (rm, git push, git commit, etc.). If the command does **not** match any dangerous prefix, it is considered safe. Unknown commands are therefore safe by default.
- `command-classifier.ts:classifyCommand()` — delegates entirely to `isSafePattern()`.
- `command-substrate.ts:runCommand()` — classifies before spawning; dangerous → reject with `approval: 'rejected'`, reason `dangerous-command-pattern`.

The current default is **deny-known-dangerous** (blocklist semantics). This means commands not on the blocklist execute without a safe-pattern check (Gap G-2).

**Design:**

Retain `permission-patterns.ts` as the **single command-safety dialect**. Do not introduce a second classification system. The Pi permission system's bash patterns are borrowable as additional entries in the dangerous list, but Wavemill owns the list.

Proposed semantic flip (addresses G-2): change to **allow-known-safe** (allowlist semantics):

- A command is classified `safe` if and only if it matches at least one pattern in the safe-pattern allowlist (FILE_SYSTEM_READ, GIT_READ, GITHUB_CLI_READ, etc.).
- A command matching none of the safe patterns is classified `dangerous` regardless of whether it appears in the blocklist.
- The blocklist is retained as the first early-rejection check for performance; the allowlist check follows.

Until this flip is implemented, the current blocklist behavior is authoritative.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Pattern library | `permission-patterns.ts` (Wavemill); Pi patterns as additions | Wavemill |
| Classification function | `command-classifier.ts` (Wavemill) | Wavemill |
| Enforcement | `command-substrate.ts` (Wavemill) | Wavemill |

---

### 4.5 MCP Gates

**Pi claimed primitives:** MCP/skill gates enforcing phase and path policy on Model Context Protocol tool calls, possibly via a proxy-tool approach. Evidence: **Q** — not exercised in `spike.mjs`; plan names `pi-mcp-adapter` as a bridge reference but no MCP spike was run.

**Current Wavemill behavior:** No MCP tooling exists in the native agent. No MCP gate is implemented. MCP is a later tool family (Epic 10, `docs/native-agent-runtime-plan.md` § "Later Tool Families").

**Design:**

When MCP tools are added (Epic 10), all MCP calls must route through the same `beforeToolCall` evaluator as native tools, at the proxy-tool layer:

1. Phase policy evaluated before any proxied MCP call.
2. Path policy applied to any path arguments in the proxied call.
3. Network policy evaluated before the proxied call reaches an external service.
4. Every proxied MCP result tagged with `external-untrusted` provenance.
5. Proxied calls recorded in the transcript with the same event shape as native tool calls.

The `pi-mcp-adapter` proxy-tool design (lazy server startup, MCP schemas kept out of default context) is a viable bridge reference, but Wavemill adds its policy layer on top. MCP servers' own permission models are not adopted as authoritative.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Proxy-tool design | `pi-mcp-adapter` (reference) | Wavemill adds policy on top |
| Phase gate on proxied calls | Wavemill (new design work — Epic 10) | Wavemill |
| Provenance tagging | Wavemill | Wavemill |

---

### 4.6 Skill Gates

**Pi claimed primitives:** Skill gates applying phase and path policy to Pi "skill" calls (predefined callable sequences). Evidence: **Q** — Pi skills are not exercised in the spike; no skill semantics are defined in current Wavemill native-agent code.

**Current Wavemill behavior:** No skill concept exists in the native agent.

**Design:**

If Pi skills are adopted, they are treated identically to native tools from a policy perspective:

1. Every skill invocation passes through `beforeToolCall` phase and path checks.
2. Skills must be explicitly enumerated in the tool registry; no implicit skill is auto-approved.
3. Skills that internally call multiple sub-tools: each sub-tool call is evaluated independently.
4. Skill results: `wavemill-generated` provenance only for Wavemill-owned skills; `external-untrusted` for third-party Pi skills.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Skill invocation seam | Pi (if adopted) | Wavemill policy applied on top |
| Phase gate on skill calls | Wavemill | Wavemill |

---

### 4.7 Session-Scoped Approvals

**Pi claimed primitives:** Session-scoped approvals caching a user's approval for a risky action so they are not re-prompted for the same action within the same session. Evidence: **Q** — no approval ledger in current `command-substrate.ts` or `policies.ts`. Current substrate returns `approved`/`rejected` per invocation with no memory across calls.

**Current Wavemill behavior:**
`command-substrate.ts` returns `approval: 'approved' | 'rejected'` per invocation. There is no ledger. Each invocation is evaluated independently. The `ToolPolicy` interface in `docs/native-agent-runtime-plan.md` defines `requiresApproval: boolean | 'when-risky'` but this is not yet implemented in `policies.ts`.

**Design:**

Define four approval scopes, each broader than the last:

| Scope | Persists over | Typical use |
|-------|---------------|-------------|
| `single-use` | One invocation only | Default for any risky command |
| `tool-scoped` | All calls to the same tool in the session | e.g., "allow `git commit` for this session" |
| `phase-scoped` | All calls within the current phase | e.g., "allow these test commands during coding" |
| `session-scoped` | All calls in the current native session | e.g., "allow network reads for this run" |

Rules:
1. A model cannot escalate an approval to a broader scope. Scope is set by the user at approval time.
2. Only the Wavemill-owned approval ledger may record approvals. A plugin may observe approval state but may not grant approvals.
3. Approvals never override a hard phase denial or path denial. An approval converts a `requires-approval` check from pending to approved; it cannot relax a `phase_denied` or `path_denied` decision.
4. The ledger is per-native-session; it does not persist across sessions or worktrees.
5. `approval_needed` is a waiting state, not an error. The agent pauses; the dashboard surfaces it; the user responds.

This requires new implementation. See Gap G-3.

**Borrow/own split:**

| Aspect | Borrowed from | Authority |
|--------|---------------|-----------|
| Scope concepts | Pi permission system (concept) | Wavemill |
| Ledger implementation | New Wavemill code | Wavemill; plugin cannot grant |

---

## 5. Borrow vs Own Decisions

Summary table across all primitives:

| Pattern | Borrow from Pi? | Wavemill is authority? | Notes |
|---------|----------------|------------------------|-------|
| `beforeToolCall` enforcement point | Yes (Pi seam) | Yes — policy logic is Wavemill's | Proven in spike; Pi owns the seam, Wavemill owns the decisions |
| Deny-first layering semantics | Yes (Pi concept) | Yes | Wavemill defines the four-layer ordering |
| Path normalization and worktree boundary | No (Wavemill's `resolveCandidatePath`) | Yes | Already implemented |
| Outside-worktree denial | Yes (Pi pattern proven in spike) | Yes | cwd + path checks are Wavemill code |
| Bash dangerous patterns | Partial (Pi patterns as additions) | Yes | `permission-patterns.ts` is the single dialect |
| Allow/ask/deny gate shape | Yes (concept reference for `when-risky`) | Yes | Wavemill owns the approval ledger |
| Most-restrictive-wins merge | Yes (Pi concept) | Yes | Wavemill defines the four-layer ordering |
| Cross-cutting path gate | Yes (Pi concept) | Yes | Wavemill applies it to all path arguments |
| MCP proxy-tool design | Yes (`pi-mcp-adapter` reference) | Yes | Wavemill evaluates policy on every proxied call |
| MCP permission model | No — not adopted | Yes | Wavemill phase policy applies to all MCP calls |
| Skill gates | Yes (Pi reference if skills adopted) | Yes | Each skill call passes through `beforeToolCall` |
| Session-scoped approval ledger | Yes (Pi concept) | Yes | New Wavemill code; plugin cannot grant approvals |
| Secret redaction patterns | No (Wavemill's `redaction.ts` is more complete) | Yes | `text-redaction.ts` handles PII; `tools/redaction.ts` handles secrets |

**Explicitly NOT delegated to the Pi plugin layer:**

- Phase policy logic
- Path boundary determination and worktree root
- Network allowlist evaluation
- Tool-result provenance tagging
- Approval grant authority
- Completion contract verification
- Stuck-loop detection
- Dirty-tree cleanup decisions

---

## 6. Integration Points

### 6.1 Approval Integration Point

**Current state:** `ToolPolicy.requiresApproval: boolean | 'when-risky'` is defined in the runtime plan but not yet implemented in `policies.ts`. `command-substrate.ts` returns `approved`/`rejected` per invocation with no approval ledger.

**Design:**

```
approval_gate(tool_call):
  if tool.requiresApproval == false  →  allow
  if tool.requiresApproval == true   →  require explicit user approval
  if tool.requiresApproval == 'when-risky':
    classify command via classifyCommand()
    if safe      →  allow
    if dangerous →  check approval ledger at declared scope
      if approved in ledger  →  allow, record reuse
      if not in ledger       →  emit approval_needed, block, wait
```

`approval_needed` is a waiting state (not a crash):
- Emit `tool_started` event with `approval: 'pending'`.
- Call `wavemill_hook_write(state='waiting', event='approval_needed', detail=toolName)`.
- Resume when the user grants or rejects; emit `approval_granted` or `approval_rejected`.
- A rejected approval produces `approval: 'rejected'` in the transcript; the tool call does not execute.

Downstream issue area: Epic 8 — human approval hooks.

---

### 6.2 Network Integration Point

**Current state:** `nativeAgent.policy.networkDefault: "deny"` is in the config shape (`docs/native-agent-runtime-plan.md` § Config Shape). Network policy is not enforced in any current policy evaluator. `command-substrate.ts` does not block network-capable commands such as `curl` beyond the pattern check.

**Design:**

Network policy is a third layer in the four-layer ordering (between path and plugin). Three values:

| Policy | Behavior |
|--------|---------|
| `deny` | No network calls allowed. Commands resolving to network-capable binaries (`curl`, `wget`, `ssh`, `nc`, etc.) are classified `dangerous` regardless of safe-pattern match. Tool calls requiring external network access are denied with `network_denied`. |
| `allowlisted` | Only calls to domains/URLs in the per-phase allowlist are permitted. |
| `allow` | Unrestricted (reserved for future advanced tools; never the default). |

Proposed default allowlists per phase:

| Phase | Allowlist |
|-------|-----------|
| task-expansion | Linear API |
| planning | Linear API |
| coding | *(deny all)* |
| review | GitHub API + Linear API |
| ready | GitHub API |

`network_denied` is a new `ToolPolicyReason` value (see Gap G-9). It is treated as a hard denial, not a soft warning.

Downstream issue area: Epic 8 — network allowlists by phase and tool.

---

### 6.3 Provenance Integration Point

**Current state:** Provenance types defined in `docs/native-agent-runtime-plan.md` § Tool Result Provenance. Not yet attached to `NativeToolResult` in code.

**Design:**

Provenance is attached to every tool result as part of `NativeToolResult`. Defaults by tool:

| Tool / source | Default provenance |
|---------------|--------------------|
| `read_file`, `search_text`, `git_diff` | `repo-untrusted` |
| `git_status`, `git_log` | `repo-trusted` |
| Wavemill-owned artifacts (stage results, session JSONL, plan, task packet) | `wavemill-generated` |
| `linear_get_issue`, GitHub comments, PR bodies, remote metadata | `external-untrusted` |
| Model-generated text / phase prompts | `provider-generated` |

**Non-escalation invariant:** A tool result tagged `repo-untrusted` or `external-untrusted` may inform the model's next action. It may not cause `beforeToolCall` to:
- Expose mutation tools in a read-only phase
- Bypass path policy
- Request or grant network access
- Convert a pending approval to approved
- Weaken completion requirements

The `beforeToolCall` evaluator must evaluate only Wavemill-controlled state (phase, config, worktree path, tool registry, approval ledger).

Downstream issue area: Epic 8 — provenance tagging and prompt-injection tests.

---

### 6.4 Recovery Integration Point

**Current state:** `phase_blocked` event type defined in `NativeAgentEvent` (plan); `.coding-blocked-completion.json` shape defined in `shared/lib/blocked-completion.ts`. No runtime stuck-loop detection or recovery artifact generation exists.

**Design:**

Recovery artifacts per trigger:

| Trigger | Recovery artifact | Required fields |
|---------|------------------|----------------|
| Repeated same tool failure (≥ N times) | `phase_blocked` event + recovery JSONL | `blockingReason: 'repeated_tool_failure'`, `toolName`, `failCount`, `lastError` |
| Repeated same patch rejection (≥ N times) | `phase_blocked` event | `blockingReason: 'patch_loop'`, `patchContext` |
| No new artifacts after N turns | `phase_blocked` event | `blockingReason: 'no_progress'`, `turnCount` |
| Budget exhausted | `phase_blocked` event | `blockingReason: 'budget_exhausted'`, `budgetType` |
| Approval needed and not yet granted | `approval_needed` event (waiting, not blocked) | `toolName`, `approvalScope`, `riskClass` |

State surfacing:
- `phase_blocked` → `wavemill_hook_write(state='error', event='phase_blocked', detail=blockingReason)`
- `approval_needed` → `wavemill_hook_write(state='waiting', event='approval_needed', detail=toolName)`

Neither state should look like an agent crash. The transcript event and the hook status together give the dashboard and operator enough context to diagnose or resume.

Downstream issue area: Epic 8 — stuck-loop detection and recovery artifacts.

---

### 6.5 Abort/Timeout Integration Point

**Current state:** `command-substrate.ts` implements SIGTERM → SIGKILL with 2 s grace for per-command abort/timeout. `AbortSignal` threading exists for individual commands. No abort logic exists for partial mutation batches, atomic patch rollback, or dirty-tree policy.

**Design:**

Cleanup matrix per scenario (from `docs/native-agent-runtime-plan.md` § Abort, Timeout, And Dirty-Tree Cleanup):

| Scenario | Required action |
|---------|----------------|
| Running command receives abort/timeout | SIGTERM, then SIGKILL after 2 s grace (already implemented) |
| Abort during atomic patch call | Fully revert the patch — all-or-nothing; no partial application |
| Abort after turn N successful mutation, before turn N+1 | Mutation remains; transcript and stage result report the partial state |
| Dirty tree at abort — changes from this native session | Phase policy must choose one of: commit, leave-dirty-and-block, stash, or reject completion. Must not silently advance to review. |
| Dirty tree at abort — user-authored changes | Never discard unless the change was created by this native session AND phase policy explicitly allows rollback |

Dirty-tree cleanup is a **phase-policy parameter** for the coding phase, not inferred behavior. It must be an explicit `dirtyTreePolicy` configuration value. The implementation must verify this choice before creating `.coding-complete`.

Before `.coding-complete` is written:
1. Confirm commit policy is satisfied.
2. Confirm `dirtyTreePolicy` action has been executed.
3. Confirm no in-flight mutation batch has pending calls.

Downstream issue areas: Epic 5 — dirty-tree policy; Epic 8 — abort/timeout cleanup.

---

## 7. Gaps vs Current Wavemill Behavior

| ID | Gap description | Current state | Affected epics |
|----|----------------|--------------|----------------|
| G-1 | No explicit most-restrictive-wins layering model across policy layers | Phase, path, and workflow mutation checks are sequenced but not formally ordered in a single merge function | Epic 8 |
| G-2 | Bash command classification uses deny-known-dangerous, not allow-known-safe | `isSafePattern()` returns `true` for anything not matching a dangerous prefix; unknown commands are classified safe by default | Epic 6, Epic 8 |
| G-3 | No session-scoped approval ledger | `command-substrate.ts` returns `approved`/`rejected` per invocation; no cross-invocation memory | Epic 8 |
| G-4 | No network allowlist policy enforced in any evaluator | `networkDefault: "deny"` is in the config shape but not enforced in `policies.ts` or `command-substrate.ts` | Epic 8 |
| G-5 | No MCP gate semantics in native-agent | No MCP tooling; no policy hooks for future MCP proxy calls | Epic 10 |
| G-6 | No skill gate semantics in native-agent | No Pi skill concept; no policy hooks defined | Epic 10 |
| G-7 | No tool-result provenance tagging in code | Provenance types defined in plan but not attached to `NativeToolResult` records | Epic 8 |
| G-8 | No prompt-injection tests for untrusted tool output | No tests verify that `repo-untrusted` or `external-untrusted` content cannot escalate `beforeToolCall` decisions | Epic 8 |
| G-9 | `network_denied` reason code does not exist | `ToolPolicyReason` in `policies.ts` only has `phase_denied` and `path_denied` | Epic 8 |
| G-10 | No stuck-loop detection | No repeated-failure counter, no no-progress detector, no budget-exhaustion recovery artifact | Epic 8 |
| G-11 | No dirty-tree policy after abort | `command-substrate.ts` handles process termination; no post-abort tree cleanup policy exists | Epic 5, Epic 8 |
| G-12 | `text-redaction.ts` does not cover secrets | `text-redaction.ts` covers PII (email, URL, path, username, repo) but not API keys, PATs, or bearer tokens — partially addressed by `shared/lib/native-agent/tools/redaction.ts` which does cover these patterns | Epic 8 |
| G-13 | Cross-cutting path gate is opt-in per tool | `pathFieldsByTool` requires explicit registration; tools not listed receive no path check regardless of their arguments | Epic 2, Epic 8 |
| G-14 | No `approval_needed` dashboard state | `wavemill_hook_write` supports `waiting` but no approval-specific event shape is defined | Epic 8 |
| G-15 | `requiresApproval` is defined in the plan's `ToolPolicy` interface but not implemented in `policies.ts` | The current `ToolPolicyConfig` has no `requiresApproval` field; the approval gate is not wired | Epic 8 |

---

## 8. Downstream Issues Unblocked by This Design

Each item below has a sufficient design to begin implementation independently:

| Implementation area | Starting point | Epic |
|--------------------|---------------|------|
| Most-restrictive-wins layer merge | Add `evaluatePolicyLayers(phase, path, network, plugin)` to `policies.ts` with first-denial-wins semantics | Epic 8 |
| Network allowlist | Add `network_denied` to `ToolPolicyReason`; add `networkPolicy` to `ToolPolicyConfig`; define per-phase allowlists | Epic 8 |
| Approval ledger | New `shared/lib/native-agent/approval-ledger.ts`; wire `requiresApproval: 'when-risky'` into `policies.ts`; define four scopes | Epic 8 |
| `approval_needed` hook state | Extend hook event vocabulary; add `approval_needed` to `wavemill_hook_write` event type; map to `state='waiting'` | Epic 8 |
| Provenance tagging | Add `provenance: ToolResultProvenance` to `NativeToolResult`; set defaults in each tool executor | Epic 8 |
| Prompt-injection test suite | `shared/lib/native-agent/tools/policies.test.ts` — assert that `external-untrusted` content does not affect `beforeToolCall` phase/path/network decisions | Epic 8 |
| `network_denied` reason code | Extend `ToolPolicyReason` union in `policies.ts` | Epic 8 |
| Stuck-loop detection | New `shared/lib/native-agent/stuck-loop-detector.ts`; emit `phase_blocked` events per trigger table in § 6.4 | Epic 8 |
| Dirty-tree cleanup policy | Add `dirtyTreePolicy` field to coding-phase config; enforce in `.coding-complete` pre-check | Epic 5, Epic 8 |
| Bash allowlist semantics flip | Refactor `isSafePattern()` in `permission-patterns.ts` to match safe-pattern allowlist; update `classifyCommand()` accordingly | Epic 6, Epic 8 |
| Cross-cutting path gate | Extend `policies.ts` to scan all string arguments for path-like values by default (not only `pathFieldsByTool` entries) | Epic 2, Epic 8 |
| MCP gate design | Separate design + `pi-mcp-adapter` spike required first; Wavemill policy applies on all proxied calls | Epic 10 |
| Secret + PII redaction consolidation | Extend `shared/lib/native-agent/tools/redaction.ts` or merge `text-redaction.ts` patterns; add configured-secret-name support | Epic 8 |

---

## 9. Assumptions / Open Questions

| ID | Topic | Classification | Recommended next action |
|----|-------|----------------|------------------------|
| A-1 | `@gotgenes/pi-permission-system` uses most-restrictive-wins layering as documented | **P** — inferred from plan text; not verified against the package | Run the package against a Wavemill read-only deny case and an outside-worktree deny case (per `docs/native-agent-runtime-plan.md` § immediate Pi-plugin spike additions) |
| A-2 | `@gotgenes/pi-permission-system` exposes MCP gate hooks | **Q** — not exercised in any spike | Defer to Epic 10; Wavemill defines its own MCP proxy-tool approach regardless |
| A-3 | `@gotgenes/pi-permission-system` exposes skill gate hooks | **Q** — not exercised | Defer to Epic 10 |
| A-4 | Pi permission system's session-scoped approval concepts align with the four scopes defined in § 4.7 | **Q** — not verified | Run a Pi permission-system probe before Epic 8 approval-ledger implementation; adjust scope definitions if the package uses a different model |
| A-5 | `pi-mcp-adapter` proxy-tool approach is compatible with Wavemill-owned `beforeToolCall` policy evaluation | **P** — inferred from plan description | Epic 10 spike: run `pi-mcp-adapter` with a toy MCP server and verify Wavemill can still enforce phase policy before the proxied call executes |
| A-6 | Network policy enforcement at the tool-executor level (pattern classification + allowlist check) is sufficient without kernel-level sandboxing | **P** — assumed for Epic 8 scope | Commands reaching the network are identified by command pattern and blocked at `classifyCommand()`; full kernel sandboxing is out of scope for Epic 8 |
| A-7 | The `@gotgenes/pi-permission-system` plugin was never run against a Wavemill deny scenario | **R** — confirmed by spike README and spike.mjs contents | The spike proves `beforeToolCall` works but does not exercise the pi-permission-system package itself; claims about its specific semantics (allow/ask/deny gates, layering, MCP hooks) are inferred from plan text only |
