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
| `glm-5.2` | `z-ai/glm-5.2` | yes | no | yes |
| `kimi-k2.7-code` | `moonshotai/kimi-k2.7-code` | yes | no | yes |
| `qwen-3-coder` | `qwen/qwen3-coder` | no | no | yes |

Coding is currently blocked globally because `nativeAgent.allowedPhases` does
not include `coding`. The `qwen-3-coder`, `glm-5.2`, and `kimi-k2.7-code`
registry entries are coding-eligible and have workflow certification artifacts,
but they are not coding-executable until the checked-in phase gate permits
native coding.

`qwen-3-coder` is review-executable but not planning-executable because its
launch-priority role eligibility is `coding` and `review`, not `planning`.

## Runability Versus Certification

Native model rollout has two separate gates:

1. **Certification and router eligibility** prove that a model identity is known,
   has a valid native capability entry, and passes the fixture-backed native
   workflow certification suite.
2. **Launch runability** proves that the exact phase/model pair can pass
   preflight for the current repository configuration and environment.

A model can be certified but still not launchable for a specific phase. The
current coding block is the main example: the models have certification
artifacts, but `check-native-agent-launch` rejects coding because the phase is
not enabled.

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
- The raw OpenRouter model ID is listed in
  `nativeAgent.providers.openrouter.models`.
- The model registry entry has a native capability for `native-openrouter`.
- The model has a valid workflow certification artifact for the current
  certification suite.

The next launch-readiness blocker is native coding runability. Until `coding` is
enabled in `nativeAgent.allowedPhases` and verified through preflight plus the
certification suite, no native model should be treated as executable for coding.
