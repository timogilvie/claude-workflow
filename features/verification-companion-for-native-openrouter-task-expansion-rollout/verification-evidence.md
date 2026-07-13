# HOK-2424 Verification Evidence

Generated: 2026-07-13

Links:
- Verification companion for rollout issue `HOK-2416`
- Current issue `HOK-2424`

## Outcome

- Verifier implementation is complete and repo checks passed.
- The rollout gate is **not yet satisfied** from this evidence run because criterion `C4` failed.
- The failure is reproducible in the verifier’s temp repo: the mutation attempt is denied, tracked-file content stays unchanged, but `git status --porcelain` changes from empty to `?? prompt-registry.jsonl`.

## Commands Run

### Focused helper test

```bash
node --test tools/hok2424-verify-native-expansion.test.ts
```

```text
1..1
# tests 8
# suites 1
# pass 8
# fail 0
```

### Lint

```bash
npm run lint
```

```text
--- Results: 383 passed, 0 failed ---
```

### Broad repo typecheck / test sweep

```bash
npm run typecheck
```

```text
# tests 1197
# suites 232
# pass 1197
# fail 0

--- Results: 60 passed, 0 failed ---
--- Results: 22 passed, 0 failed ---
```

### Offline verifier

```bash
npx tsx tools/hok2424-verify-native-expansion.ts
```

```text
HOK-2424 native OpenRouter task-expansion verification
Generated: 2026-07-13T15:54:39.946Z
Requested model: qwen/qwen3-coder

| Criterion | Status | Evidence |
| --- | --- | --- |
| C1 Native task expansion runs for a configured OpenRouter model | PASS | provider=openrouter model=qwen/qwen3-coder api=hok2424-scripted-qwen-qwen3-coder-1783958075920 |
| C2 Expanded packet is valid and expand-issue artifact layout is written | PASS | Wrote ../../../../../../var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-cu1kO5/.wavemill/verification/task-packet.md plus header/details/native sidecar (validator issues=2). |
| C3 Transcript, usage, identity, denied-tool, and provenance records are present | PASS | transcript=../../../../../../var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-cu1kO5/.wavemill/runs/hok2424-qwen-qwen3-coder-offline-1783958075920/native-sessions/expansion-hok2424-qwen-qwen3-coder-offline-1783958075920.jsonl manifestRefs=6 registryRecords=7 |
| C4 Read-only policy denies mutation attempts and leaves the worktree unchanged | FAIL | git status changed |
| C5 Missing or stale read-only certification blocks task-expansion model selection | PASS | missing=>uncertified (reason=missing_artifact; modelId=qwen/qwen3-coder; nativeCapability=certified; requiredPhase=read-only; requiredSuiteVersion=v1; artifactPath=/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-lGBGcW/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json); stale=>uncertified (reason=stale_artifact; modelId=qwen/qwen3-coder; nativeCapability=certified; requiredPhase=read-only; foundPhase=workflow; requiredSuiteVersion=v1; foundSuiteVersion=v1; certifiedAt=2026-05-13T12:00:00.000Z; artifactPath=/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-9jggX9/.wavemill/native-agent-certifications/qwen/qwen3-coder/v1.json); fresh=>ready |
| C6 fallbackOnUnavailable preserves Claude rollback only for prerequisite failures | PASS | missing_key fallback returned Claude with a warning; non-availability error was rethrown. |
| C7 Native packet matches the Claude/Codex baseline structure | PASS | 10 numbered sections matched baseline features/verification-companion-for-native-openrouter-task-expansion-rollout/task-packet.md. |
```

### Live verifier path

Environment check:

```bash
if [ -n "$OPENROUTER_API_KEY" ]; then echo present; else echo absent; fi
```

```text
absent
```

```bash
npx tsx tools/hok2424-verify-native-expansion.ts --live
```

```text
Live run: SKIPPED - OPENROUTER_API_KEY is not set in this environment.
```

## Artifact Paths

Offline happy-path artifacts:

- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/verification/task-packet.md`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/verification/task-packet-header.md`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/verification/task-packet-details.md`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/verification/task-packet.native.json`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/runs/hok2424-qwen-qwen3-coder-offline-1783958272956/native-sessions/expansion-hok2424-qwen-qwen3-coder-offline-1783958272956.jsonl`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/manifests/hok2424-qwen-qwen3-coder-offline-1783958272956.json`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-6l9b6a/.wavemill/registry/resources.jsonl`

Mutation-check artifacts:

- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-hVrctR/.wavemill/runs/hok2424-qwen-qwen3-coder-mutation-1783958275429/native-sessions/expansion-hok2424-qwen-qwen3-coder-mutation-1783958275429.jsonl`
- `/var/folders/0v/2l0qx62n3tgf2p_32p6_0_ww0000gn/T/hok2424-native-expansion-hVrctR/.wavemill/manifests/hok2424-qwen-qwen3-coder-mutation-1783958275429.json`

Baseline comparison packet:

- `features/verification-companion-for-native-openrouter-task-expansion-rollout/task-packet.md`

## Findings

1. `C4` is a real rollout blocker for `HOK-2416`.
   - The denied mutation was recorded correctly.
   - The tracked-file hash stayed unchanged.
   - `git status --porcelain` still changed because the temp repo gained an untracked `prompt-registry.jsonl` file.
   - From the verifier JSON run, the mutation case observed:

```text
gitStatusBefore=""
gitStatusAfter="?? prompt-registry.jsonl"
```

2. The live OpenRouter check is deferred in this shell.
   - `OPENROUTER_API_KEY` is absent, so the verifier could only record the explicit skip path.

## Notes

- The verifier currently exercises `qwen/qwen3-coder` offline as the configured representative model.
- The native-expanded packet is valid task-packet markdown and writes the expected full/header/details/sidecar artifact set.
- Provenance checks passed: transcript, usage/cost, provider/model/API fields, denied-tool list field, manifest, and registry entries were all present.
- Results should be linked back to `HOK-2416` when posting this evidence to the issue tracker.
