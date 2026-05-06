---
title: Routing & Hokusai
---

Wavemill gets better over time by learning which models perform best on which kinds of work. That learning loop is what turns `wavemill mill` from simple automation into a self-improving software factory.

## Routing

For each task, Wavemill can choose different models and execution depths for planning, coding, and review.

Routing considers:

- task type and risk signals
- historical eval performance on similar work
- expected success rate
- expected cost

The goal is not to pick one best model globally. The goal is to pick the best workflow for this task.

### Stable Routing Metadata

Eval records now preserve router attribution as structured fields on `routingDecision`:

- `decisionPolicyVersion`: the policy surface that actually made the decision
- `routeMode`: the emitted route strategy, such as `heuristic`, `stage-aware`, `hokusai`, or `policy`
- `routeArtifactSchemaVersion`: the route artifact shape version
- `policyResolverVersion`: the policy-resolution helper version
- `operatingModeDependency`: quota operating mode, separate from policy source

Current stable `decisionPolicyVersion` identifiers are:

- `baseline`
- `heuristic`
- `heuristic-fallback`
- `stage-aware`
- `hokusai`
- `policy`
- `expanded-route`

`operatingModeDependency` is orthogonal to the policy source. For example, a route may be emitted by the stage-aware router while also recording `operatingModeDependency: "survival"`.

These fields are additive. Older eval records may omit them and remain valid.

### CLI Transparency

When routing deviates from the normal path, `wavemill mill` prints a single concise line explaining why. Examples:

```text
11:31:02 [router] constrained mode: claude-opus-4-7 quota is degrading; reserving it for high-complexity steps
11:31:02 [router] policy adjustment: coder claude-opus-4-7 -> claude-sonnet-4-6 (quota=degrading)
11:31:44 [coder] claude-opus-4-7 unavailable (quota); falling back to claude-sonnet-4-6
```

These lines appear only when quota state or fallback behavior changes the normal route. Healthy normal-mode runs stay silent.

## Where The Data Comes From

By default, routing improves from your own repositories:

1. Wavemill executes work.
2. `eval` scores the outcome.
3. The eval record is stored locally.
4. Future tasks use that history for routing.

This means Wavemill can become more effective and more cost-efficient over time without requiring any shared dataset.

## Challenge Mode

Challenge mode periodically runs the same task with two different model configurations. That produces direct comparison data instead of relying only on independent scores.

Challenge data helps answer questions like:

- which model handles refactors better
- which model is cheaper for low-risk tasks
- which model needs fewer review iterations on UI work

That comparison data makes routing more reliable over time.

## Hokusai

Hokusai is the collective-intelligence layer for routing.

If you opt in, Wavemill can supplement your local eval history with shared signals gathered across many teams and tasks. This helps with cold starts and can improve routing quality before you have a large local dataset.

Use:

```bash
wavemill hokusai status
wavemill hokusai enable
wavemill hokusai disable
```

Hokusai is optional. The default model is:

- local learning from your own data
- collective learning only when explicitly enabled

### Submission Schema

Outbound Hokusai training submissions include a `schema_version` field:

- `1.0` submissions contain route, constraint, and observed outcome fields.
- `1.1` submissions also include a `rubric_signals` block when sanitized rubric features are available.

The `rubric_signals` block carries the rubric version, criterion count, mean score, five normalized criterion scores, optional determinative boundary, and optional rubric provenance. These values come from the privacy-safe rubric projection on the task descriptor plus record-level rubric metadata.

Free-text rubric rationale, stage rationale, judge notes, prompt-registry hashes, and internal model identifiers are not forwarded. Redaction uses an allow-list for safe strings, so unexpected new text fields are stripped by default while numeric rubric features pass through unchanged.

The new fields are optional. Existing consumers can continue accepting old submissions and ignore unknown optional fields until they are updated for `1.1`.

## Related Commands

- `wavemill mill` runs routing as part of the main factory loop
- `wavemill route` shows the recommended planner, coder, and reviewer workflow for a task
- `wavemill eval` inspects the outcome data that routing learns from

## See Also

- [Mill Mode](mill-mode.md) — the default workflow
- [CLI Reference](cli-reference.md) — all commands and command groups
- [Eval Mode](eval-mode.md) — how outcomes are scored
- [Adding Models](model-additions.md) — maintainer checklist for adding model support
