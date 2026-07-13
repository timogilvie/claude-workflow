# Verification Companion Baseline

This baseline task packet represents the expected Claude/Codex expansion structure for HOK-2424 verification comparisons.

## Quick Reference

- Objective: verify the native OpenRouter task-expansion rollout path without mutating the working tree.
- Key files: `tools/expand-issue.ts`, `shared/lib/native-expansion.ts`, `shared/lib/issue-expander.ts`.
- Constraints: preserve fallback behavior, prove provenance artifacts are written, keep verification deterministic offline.

<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->

## 1. Objective

### What
Validate native OpenRouter task expansion end-to-end and confirm rollback behavior remains safe.

### Why
The rollout for HOK-2416 is incomplete until native task expansion can be verified against the expected artifact and policy contract.

### Scope In
- Deterministic verification coverage for configured OpenRouter-native task-expansion models.
- Artifact, provenance, and fallback checks.
- Structural comparison against a Claude/Codex baseline packet.

### Scope Out
- Expanding unrelated Linear issues.
- Broad router tuning outside the native task-expansion rollout.

## 2. Technical Context

### Repository
This work happens in the wavemill repository.

### Key Files
- `tools/expand-issue.ts`
- `shared/lib/native-expansion.ts`
- `shared/lib/issue-expander.ts`
- `shared/lib/native-agent/providers.ts`

### Dependencies
- OpenRouter model configuration in `.wavemill-config.json`
- Native certification artifacts in `.wavemill/native-agent-certifications/`

### Architecture Notes
- Native task expansion must remain read-only.
- Fallback is allowed only for native prerequisite failures when configured.

## 3. Implementation Approach

1. Build a deterministic verifier harness around fixture-backed native expansion.
2. Validate artifacts, provenance, certification gates, and fallback behavior.
3. Produce evidence that can be pasted back into the issue.

## 4. Success Criteria

### Functional Requirements
- [ ] **[REQ-F1]** Native task expansion writes the standard task-packet artifacts plus native metadata.
- [ ] **[REQ-F2]** Native provenance records include prompt, runtime, and tool-set references.
- [ ] **[REQ-F3]** Read-only policy denies mutation attempts without changing the tracked worktree.

### Non-Functional Requirements
- [ ] Verification can run deterministically without network access.

### Code Quality
- [ ] Follows existing verification tool patterns.
- [ ] TypeScript types remain specific.
- [ ] No lint errors.

## 5. Implementation Constraints

- Code style: reuse existing verifier and `runTool` patterns.
- Testing: cover pass and fail paths for each acceptance check helper.
- Security: do not weaken read-only policy or certification gates.
- Backwards compatibility: preserve Claude fallback semantics.

## 6. Validation Steps

### Functional Requirement Validation

**[REQ-F1] Native task expansion writes the standard task-packet artifacts plus native metadata.**

Validation scenario:
1. Setup: run the verifier for a configured native OpenRouter model.
2. Action: inspect the emitted task packet, header, details, sidecar, transcript, and manifest files.
3. Expected result: every expected artifact exists and the saved packet validates as markdown.
4. Edge cases:
   - Missing transcript path in the sidecar → verifier fails.
   - Missing prompt/runtime/tool-set provenance record → verifier fails.

**[REQ-F3] Read-only policy denies mutation attempts without changing the tracked worktree.**

Validation scenario:
1. Setup: run the fixture-backed native expansion inside an isolated git repo.
2. Action: let the scripted native session attempt a mutation tool call.
3. Expected result: the transcript records a denied tool call and `git status --porcelain` is unchanged.
4. Edge cases:
   - Mutation tool executes instead of being denied → verifier fails.
   - Tracked file content changes after the denied call → verifier fails.

## Release Readiness

- **databaseChangeRisk**: none
- **envChanges**: none
- **configChanges**: package.json
- **manualSteps**: paste verification output into HOK-2424 and link the result to HOK-2416
