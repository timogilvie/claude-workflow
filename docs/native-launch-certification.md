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

`qwen-3-coder` is planning-executable only while its global v2 `workflow`
certification artifact is fresh and valid. Missing, stale, malformed, wrong-suite,
or phase-insufficient artifacts keep it out of the planner pool.

## Runability Versus Certification

Native model rollout has two separate gates:

1. **Certification and router eligibility** prove that a model identity is known,
   has a valid native capability entry, and passes the fixture-backed native
   workflow certification suite.
2. **Launch runability** proves that the exact phase/model pair can pass
   preflight for the current repository configuration and environment.

A model can be certified but still not launchable for a specific phase. A
patch-only `qwen-3-coder` artifact remains launchable for coding and review, but
planning requires a `workflow` artifact and fails closed otherwise.

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
- The model has a valid workflow certification artifact for the current
  certification suite.
- Native coding additionally requires `nativeAgent.patchCoding.enabled` and a
  valid `.wavemill/native-agent/patch-coding-certification.json` smoke artifact.

Run the HOK-2074 canary fixture in
`tests/fixtures/native-routing-canary/README.md` before broad rollout. It
checks the current primary and challenger native model matrices against a real
Wavemill routing task.
