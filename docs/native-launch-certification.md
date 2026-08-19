# Native Launch Certification

Run the native agent launch-readiness gate with:

```bash
npm run test:native-launch-certification
```

The suite is intentionally offline and fixture-backed so it can run locally and
in CI without live model spend. It certifies the launch surface for native
OpenRouter models such as Kimi, Qwen, and GLM across the wavemill lifecycle.

## Coverage

- Native planning reaches `planning/awaiting_user` without auto-approval and
  preserves explicit approvals created after the awaiting-user state is visible.
- Native coding applies scoped patches, writes completion artifacts, and supports
  blocked-completion handoff without writing `.coding-complete`.
- Native review handles malformed model output, records review artifacts, and
  drives the PR handoff flow with idempotent GitHub/Linear fixtures.
- Native launcher preflight rejects unsupported model/stage combinations before
  pane launch and emits actionable diagnostics.
- Router certification verifies Kimi, Qwen, and GLM aliases and raw OpenRouter
  IDs against launch-priority role eligibility.
- Lifecycle fixtures cover malformed native launchers, missing markers, monitor
  recovery, approval gates, blocked-completion behavior, and review handoff.
- Dashboard/status fixtures verify native launch failures are surfaced to the
  operator instead of leaving panes stuck silently.

CI runs this command as a dedicated step after the normal shell/unit suite, so a
native launch certification failure blocks launch-readiness changes.

## Current Native Launch Matrix

This table reflects the checked-in native OpenRouter configuration and the
phase preflight gate. It is the operator-facing runability matrix for native
launches, not a general list of models that the router knows about.

| Model alias | OpenRouter model | Planning | Coding | Review |
| --- | --- | --- | --- | --- |
| `glm-5.2` | `z-ai/glm-5.2` | yes | yes | yes |
| `kimi-k2.7-code` | `moonshotai/kimi-k2.7-code` | yes | yes | yes |
| `qwen-3-coder` | `qwen/qwen3-coder` | yes | yes | yes |

Native coding is enabled by the checked-in `nativeAgent.allowedPhases` and
`nativeAgent.patchCoding.enabled` settings. The repo-level patch-coding smoke
artifact certifies the native patch runtime, and the provider/model workflow
certification artifacts certify the configured OpenRouter model identities.

Planning launchability is still fail-closed at runtime: a model must have a
fresh global `workflow` certification artifact for the active suite before
planner preflight, workflow routing, or challenge routing can select it.

## Runability Versus Certification

Native model rollout has two separate gates:

1. **Certification and router eligibility** prove that a model identity is known,
   has a valid native capability entry, and passes the fixture-backed native
   workflow certification suite.
2. **Launch runability** proves that the exact phase/model pair can pass
   preflight for the current repository configuration and environment.

A model can be certified but still not launchable for a specific phase. For
example, `gemini-2.5-flash` is known to the native OpenRouter catalog but its
launch-priority role eligibility is `coding` and `review`, so planning preflight
rejects it before launch.

Use this preflight command when checking a specific launch path:

```bash
node --import tsx tools/check-native-agent-launch.ts \
  --repo-dir . \
  --agent native-openrouter \
  --phase planning \
  --model kimi-k2.7-code
```

Change `--phase` to `planning`, `coding`, or `review`, and use either the model
alias or raw OpenRouter model ID. A launch is executable only when this command
passes in the same environment that will run `wavemill mill`.

## Minimum Native OpenRouter Requirements

- `OPENROUTER_API_KEY` is present in the launch environment.
- `nativeAgent.enabled` is `true`.
- `nativeAgent.allowedPhases` includes the phase being launched.
- `nativeAgent.providers.openrouter.enabled` is `true`.
- The model is present in the global effective-model projection for the launch phase.
- The global model registry entry has a native capability for `native-openrouter`.
- Planning requires a valid global `workflow` certification artifact for the
  current certification suite at preflight. Missing, stale, malformed,
  wrong-suite, or lower-phase artifacts keep the model out of planner pools.
- Native coding additionally requires `nativeAgent.patchCoding.enabled` and a
  valid `.wavemill/native-agent/patch-coding-certification.json` smoke artifact.

## Native Planning Canary

Use the reusable Qwen planning canary before broad native planner rollout:

```bash
npx tsx tools/native-planning-canary.ts --model qwen-3-coder --issue HOK-2779 --json
```

`--dry-run` checks gate agreement without live model spend. A full run writes
secrets-free evidence to
`.wavemill/audits/canaries/qwen-3-coder-native-planning.json`, including the
preflight/router/projection/challenge gate matrix and launch artifact metadata.

Run the HOK-2074 canary fixture in
`tests/fixtures/native-routing-canary/README.md` before broad rollout. It
checks the current primary and challenger native model matrices against a real
Wavemill routing task.
