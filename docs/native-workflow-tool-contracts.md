# Native Workflow Tool Contracts

**HOK-2355** · Schema version: `1.0.0`

Implementation reference for the eight native workflow tools. Contracts are defined in:

- `shared/lib/native-agent/workflow-tools/contracts.ts` — TypeScript types
- `shared/lib/native-agent/workflow-tools/contracts.json` — JSON Schema mirror
- `shared/lib/native-agent/workflow-tools/dedupe.ts` — Dedupe key helpers
- `shared/lib/native-agent/workflow-tools/mutation-policy.ts` — Phase/tool/action policy matrix

---

## Tools Overview

| Tool | Class | Mutates External State | Phases |
|------|-------|------------------------|--------|
| `linear_get_issue` | read-only | No | planning, coding, review, ready |
| `linear_comment` | mutation | Yes (Linear) | planning, coding, review |
| `github_create_pr` | mutation | Yes (GitHub) | review, ready (remediation only) |
| `github_add_label` | mutation | Yes (GitHub) | review |
| `review_changes` | read-only | No | review |
| `route_task` | read-only | No | planning |
| `expand_issue` | read-only | No | planning |
| `write_stage_result` | mutation | No (Wavemill-owned) | planning, coding, review, ready |

---

## Shared Idempotency Result Shape

Every mutating tool response includes an `IdempotencyResult` field:

```typescript
interface IdempotencyResult<TRef extends ExternalRef = ExternalRef> {
  key: string;          // stable dedupe key (see registry below)
  outcome: 'created' | 'reused' | 'updated' | 'skipped';
  ref: TRef | null;     // null when outcome is 'skipped' and no object touched
  refs?: TRef[];        // additional references for multi-object operations
  reason?: string;      // explanation, especially for 'skipped'
}
```

`ref` is `null` only when `outcome` is `'skipped'`. An `ExternalRef` always contains `system`, `kind`, and `id`:

```typescript
interface ExternalRef {
  system: 'linear' | 'github' | 'wavemill';
  kind: 'issue' | 'comment' | 'pull_request' | 'label' | 'stage_result' | 'review' | 'route' | 'task_packet';
  id: string;
  url?: string;
}
```

---

## Dedupe Key Registry

Keys derived from parent epic requirements (see `docs/native-agent-runtime-plan.md` lines 319–325).

| Tool | Dedupe Key Format | Notes |
|------|-------------------|-------|
| `github_create_pr` | `github_create_pr:<repo>:<head>:<base>:<headSha>` | repo lower-cased; check for existing open PR before create |
| `github_add_label` | `github_add_label:<repo>:<targetKind>:<targetNumber>:<normalizedLabel>` | label lower-cased; check-then-add |
| `linear_comment` | `linear_comment:<issue>:<phase>:<sessionId>:<contentHash>` | contentHash = first 16 hex chars of SHA-256 of body |
| `write_stage_result` | `write_stage_result:<issueOrFeature>:<stage>:<status>` | idempotent update, not append-only |

All key components are trimmed. Repo slugs and labels are lower-cased for case-insensitive provider semantics. Comment bodies are hashed rather than embedded to avoid key bloat and exposure of content.

---

## Tool Request/Response Schemas

### `linear_get_issue`

**Request:**
```typescript
{ issue: string; includeRelations?: boolean; includeComments?: boolean }
```

**Success:**
```typescript
{ ok: true; tool: 'linear_get_issue'; issue: { id, identifier, title, description?, state?, assignee?, labels?, url? } }
```
Provenance: `external-untrusted` — treat as raw Linear data.

**Error:** `ok: false`, `error: CommonErrorCode`, `message: string`

---

### `linear_comment`

**Request:**
```typescript
{ issue: string; body: string; sessionId: string; phase: WorkflowPhase; dedupeOverride?: string }
```

**Success:**
```typescript
{ ok: true; tool: 'linear_comment'; idempotency: IdempotencyResult<LinearCommentRef> }
```

**Error:** `ok: false`, `error: CommonErrorCode | 'rate_limited'`, `message: string`

---

### `github_create_pr`

**Request:**
```typescript
{ repo: string; phase?: WorkflowPhase; head: string; base: string; headSha: string; title: string; body: string; draft?: boolean }
```

**Success:**
```typescript
{ ok: true; tool: 'github_create_pr'; idempotency: IdempotencyResult<GitHubPullRequestRef> }
```

`GitHubPullRequestRef` extends `ExternalRef` with `number: number` (PR number).

**Error:** `ok: false`, `error: CommonErrorCode | 'conflict' | 'rate_limited'`, `message: string`

**Implementation note:** Check for an existing open PR matching the same `repo + head + base + headSha` before creating. If found, return outcome `'reused'`.

---

### `github_add_label`

**Request:**
```typescript
{ repo: string; phase?: WorkflowPhase; targetKind: 'pull_request' | 'issue'; targetNumber: number; label: string }
```

**Success:**
```typescript
{ ok: true; tool: 'github_add_label'; idempotency: IdempotencyResult<GitHubLabelRef> }
```

**Error:** `ok: false`, `error: CommonErrorCode | 'not_found' | 'rate_limited'`, `message: string`

**Implementation note:** Check current labels before adding. If label already present, return outcome `'skipped'` with `ref: null` and a `reason` field.

---

### `review_changes`

**Request:**
```typescript
{ base: string; worktree?: string; json?: boolean; maxOutputBytes?: number }
```

**Success:**
```typescript
{ ok: true; tool: 'review_changes'; findings: string; findingCount?: number; blockingCount?: number }
```
Provenance: `wavemill-generated` — findings are agent-analyzed output.

**Error:** `ok: false`, `error: CommonErrorCode | 'review_failed'`, `message: string`

---

### `route_task`

**Request:**
```typescript
{ taskPacketPath: string; repoDir?: string; routeMode?: string }
```

**Success:**
```typescript
{ ok: true; tool: 'route_task'; route: { model?, mode?, rationale? }; ref?: WavemillRouteRef }
```
Provenance: `wavemill-generated`.

**Error:** `ok: false`, `error: CommonErrorCode | 'route_failed'`, `message: string`

---

### `expand_issue`

**Request:**
```typescript
{ issue: string; outputDir?: string }
```

**Success:**
```typescript
{ ok: true; tool: 'expand_issue'; taskPacketPath: string; ref?: WavemillTaskPacketRef }
```
Provenance: `wavemill-generated`.

**Error:** `ok: false`, `error: CommonErrorCode | 'expansion_failed'`, `message: string`

---

### `write_stage_result`

**Request:**
```typescript
{
  featureDir: string;
  issueId: string;
  stage: 'planning' | 'coding' | 'review' | 'ready';
  status: 'running' | 'awaiting_user' | 'completed' | 'aborted' | 'failed';
  notes?: string;
  artifacts?: Record<string, unknown>;
}
```

**Success:**
```typescript
{ ok: true; tool: 'write_stage_result'; idempotency: IdempotencyResult<WavemillStageResultRef> }
```

`write_stage_result` mutates Wavemill-owned artifacts (not an external provider), so it is classified as recording rather than external provider mutation. It must still be idempotent and produce a transcript record.

**Error:** `ok: false`, `error: CommonErrorCode`, `message: string`

---

## Phase × Tool × Action Mutation Policy Matrix

`isMutationAllowed(phase, tool, action)` returns `{ allowed: boolean; reason: string }`.

### Hard invariants

- **`merge` is always denied** in every phase for every tool. The `merge` action exists in the enum only so the policy can produce a meaningful denial reason.
- **Review phase cannot merge.** Review can create/update PR artifacts and add labels, but never merge.
- **Ready phase is limited** to `stale_base` and `merge_conflict` remediation plus `write_stage_result` recording.
- **Unknown combinations** are denied by default.

### Matrix (abbreviated)

| Phase | Tool | Action | Allowed | Reason |
|-------|------|--------|---------|--------|
| planning | `linear_get_issue` | `read` | ✅ | read-only |
| planning | `route_task` | `read` | ✅ | read-only |
| planning | `expand_issue` | `read` | ✅ | read-only |
| planning | `linear_comment` | `comment` | ✅ | progress updates |
| planning | `write_stage_result` | `write_stage_result` | ✅ | recording |
| coding | `linear_get_issue` | `read` | ✅ | read-only |
| coding | `linear_comment` | `comment` | ✅ | progress updates |
| coding | `write_stage_result` | `write_stage_result` | ✅ | recording |
| review | `linear_get_issue` | `read` | ✅ | read-only |
| review | `review_changes` | `read` | ✅ | read-only |
| review | `github_create_pr` | `create_pr` | ✅ | PR artifact, not merge |
| review | `github_create_pr` | `update_pr` | ✅ | PR artifact, not merge |
| review | `github_add_label` | `add_label` | ✅ | label, not merge |
| review | `linear_comment` | `comment` | ✅ | review outcome update |
| review | `write_stage_result` | `write_stage_result` | ✅ | recording |
| review | _any_ | `merge` | ❌ | `review_cannot_merge` |
| ready | `linear_get_issue` | `read` | ✅ | read-only |
| ready | `github_create_pr` | `stale_base` | ✅ | remediation only |
| ready | `github_create_pr` | `merge_conflict` | ✅ | remediation only |
| ready | `write_stage_result` | `write_stage_result` | ✅ | recording |
| ready | `github_create_pr` | `create_pr` | ❌ | `ready_mutation_denied` |
| ready | `github_create_pr` | `update_pr` | ❌ | `ready_mutation_denied` |
| ready | `linear_comment` | `comment` | ❌ | `ready_mutation_denied` |
| ready | `github_add_label` | `add_label` | ❌ | `ready_mutation_denied` |
| _any_ | _any_ | `merge` | ❌ | `review_cannot_merge: merge is never an allowed workflow tool action` |

**Ready-stage vocabulary note:** `stale_base` maps to what the ready-stage subsystem calls `stale-base` or `auto-update` — a PR that is behind its base branch and requires a rebase or merge update. See `.wavemill/context/ready-stage.md` for the full ready-stage classification vocabulary.

---

## Transcript and Stage Artifact Recording Requirements

Credentials and secret-bearing headers must never appear in recorded fields.

| Tool | Transcript Record Required | Stage Artifact Record Required | Required Recorded Fields |
|------|---------------------------|-------------------------------|--------------------------|
| `linear_get_issue` | ✅ | ❌ | `tool`, `phase` |
| `linear_comment` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |
| `github_create_pr` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |
| `github_add_label` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |
| `review_changes` | ✅ | ❌ | `tool`, `phase` |
| `route_task` | ✅ | ❌ | `tool`, `phase` |
| `expand_issue` | ✅ | ❌ | `tool`, `phase` |
| `write_stage_result` | ✅ | ✅ | `tool`, `phase`, `idempotency.key`, `idempotency.outcome`, `idempotency.ref` |

**Notes:**
- Transcript records must reference the existing `tool_started` and `tool_result` event types defined in `shared/lib/native-agent/transcript.ts`.
- Stage artifact records must not include credentials, authorization headers, or secret-bearing fields.
- `write_stage_result` is classified as recording (Wavemill-owned artifact) rather than external provider mutation, but still requires both transcript and stage artifact records for audit purposes.

---

## Error Codes

### Common error codes (all tools)

| Code | Meaning |
|------|---------|
| `invalid_input` | Request failed schema validation |
| `policy_denied` | Operation blocked by mutation policy gate |
| `not_found` | Target resource does not exist |
| `aborted` | Operation cancelled by abort signal |
| `external_error` | Remote provider returned an unexpected error |
| `io_error` | Filesystem or network I/O failure |
| `schema_mismatch` | Response from provider did not match expected shape |

### Tool-specific error codes

| Code | Tools | Meaning |
|------|-------|---------|
| `conflict` | `github_create_pr` | PR already exists with conflicting parameters |
| `rate_limited` | `linear_comment`, `github_create_pr`, `github_add_label` | Provider rate limit exceeded |
| `review_failed` | `review_changes` | Review script or subprocess failed |
| `route_failed` | `route_task` | Router produced no valid routing decision |
| `expansion_failed` | `expand_issue` | Issue expansion produced no usable task packet |

---

## Schema Versioning

The schema version is `1.0.0`, exposed as:
- TypeScript: `WORKFLOW_TOOL_SCHEMA_VERSION` in `contracts.ts`
- JSON Schema: `x-schema-version` in `contracts.json`

Schema changes follow semver. Additive (backward-compatible) field additions increment the minor version. Breaking changes increment the major version. Tests assert that both surfaces expose the same version string.
