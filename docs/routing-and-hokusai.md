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

### Route Prediction Contract

Eval records can also carry two small optional router-analysis blocks:

- `routePrediction`: the router's falsifiable expectation for success, cost, confidence, risk, and a compact rationale/features summary
- `routeCalibration`: the comparison between that prediction and actual workflow outcomes such as `workflowCost`, `outcomes.success`, duration, and intervention count

These fields are additive and intentionally small. They are meant for calibration and feedback loops, not for full autonomous change manifests.

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

### Live Prediction Contract

Live Hokusai routing uses the public Model 30 prediction endpoint:

`POST https://api.hokus.ai/api/v1/models/30/predict`

Wavemill sends a nested `inputs` payload with:

- `inputs.task.description`
- `inputs.task.task_type`
- optional `inputs.routing`, `inputs.context`, `inputs.workflow`, and `inputs.metadata`

Wavemill expects `predictions.recommended_strategy` in the response and converts it into the internal `WorkflowRouteDecision`. If the request times out, auth fails, the API returns `4xx/5xx`, or the response shape is invalid, Wavemill classifies the failure and falls back to local routing.

### Submission Schema

Outbound Hokusai training submissions include a `schema_version` field:

- `1.0` submissions contain route, constraint, and observed outcome fields.
- `1.1` submissions also include a `rubric_signals` block when sanitized rubric features are available.
- `1.2` submissions can additionally include optional `route_prediction` and `route_calibration` blocks when present on the eval record.

The `rubric_signals` block carries the rubric version, criterion count, mean score, five normalized criterion scores, optional determinative boundary, and optional rubric provenance. These values come from the privacy-safe rubric projection on the task descriptor plus record-level rubric metadata.

Free-text rubric rationale, stage rationale, judge notes, prompt-registry hashes, and internal model identifiers are not forwarded. Redaction uses an allow-list for safe strings, so unexpected new text fields are stripped by default while numeric rubric features pass through unchanged.

The new fields are optional. Existing consumers can continue accepting old submissions and ignore unknown optional fields until they are updated for `1.1`.

### Contribution Queue

Outcome and benchmark contribution uploads are separate from live Model 30 routing. Live prediction calls stay synchronous and continue to fall back to local routing when Hokusai is unavailable; Wavemill does not enqueue stale route requests.

When `hokusai.contributions.enabled` is `true` and user consent is valid, Wavemill can store redacted contribution rows under `.wavemill/hokusai/` and later drain them to an explicitly configured contribution endpoint. The queue only stores validated row shapes such as the public Submit Data fields (`success_under_budget`, optional `inputs`, `actual_cost_usd`, `wall_clock_seconds`, `task_id`, `harness`) and the stricter `technical_task_router_row/v1` benchmark shape. Raw eval payloads, task text, prompts, and other unredacted inputs are rejected before enqueue.

If no explicit contribution endpoint is configured, drain can export pending rows for manual submission instead of pretending upload succeeded. Transient failures such as timeouts, `429`, and `5xx` responses are retried with persisted backoff; permanent failures such as auth, schema, or malformed-row errors move to dead-letter with redacted operator-facing details only.

## Related Commands

- `wavemill mill` runs routing as part of the main factory loop
- `wavemill route` shows the recommended planner, coder, and reviewer workflow for a task
- `wavemill eval` inspects the outcome data that routing learns from

## See Also

- [Mill Mode](mill-mode.md) — the default workflow
- [CLI Reference](cli-reference.md) — all commands and command groups
- [Eval Mode](eval-mode.md) — how outcomes are scored
- [Adding Models](model-additions.md) — maintainer checklist for adding model support
