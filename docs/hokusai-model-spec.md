# Hokusai Model Specification  
## Model Name: Wavemill Workflow Router

---

## 1. Overview

The **Wavemill Workflow Router** predicts the optimal configuration of AI agents to complete a technical task successfully within a defined cost constraint.

Given a structured description of a task and a maximum budget, the model selects:
- planner model
- coder model
- reviewer model
- execution depth parameters

The model is trained on historical task execution data from Wavemill, where workflows are evaluated based on real outcomes including completion success, cost, time, and intervention.

---

## 2. Objective

The primary objective of the model is:

**Maximize task completion success rate while remaining within a specified cost constraint**

---

## 3. Benchmark Definition

Scorer ID:
`hokusai.scorers.wavemill.success_rate_under_budget:v1`

### 3.1 Benchmark Task

Each benchmark sample consists of:
- a structured task descriptor
- a set of available models
- a maximum cost constraint

The model must output a workflow configuration that is expected to complete the task successfully within the cost limit.

---

### 3.2 Evaluation Criteria

#### Stage 1 — Scoreability
A benchmark row is scoreable if:
- the route artifact is valid JSON with planner, coder, and reviewer fields
- the selected measurement policy has enough task input to replay or reroute
- the observed eval row provides completion and budget/cost data

Malformed route artifacts are not dropped. They are counted as `invalid_route` diagnostics.

#### Stage 2 — Feasibility
A prediction is feasible if:
- selected models are allowed
- observed cost ≤ max cost

Else score = 0.

#### Stage 3 — Outcome Score

Score = Successful Completion Under Budget

HEM field:
`workflow_success_rate_under_budget`

Benchmark Score = SuccessfulRunsWithinBudget / ScoreableRuns

---

### 3.3 Definition of Success

completed_successfully == true

---

### 3.4 Budget Compliance

actual_cost_usd ≤ max_cost_usd

### 3.5 Measurement Policies

- `replay_exact_match`: use the persisted route decision exactly as captured in the route artifact and score it against the observed eval outcome.
- `challenge_prospective`: reconstruct the persisted task input, reroute under the current router with the requested `modelsAvailable`, and score the prospective route against the same observed eval outcome.

### 3.6 Diagnostics

The scorer also emits `wavemill_router_diagnostics` with:
- `scoreable_coverage`
- `invalid_route_rate`
- `budget_compliance_rate`
- `completion_success_rate`
- `total_cost_usd`
- `timing_p50_ms`
- `timing_p95_ms`
- `intervention_rate`
- `intervention_count`
- `total_records`
- `scoreable_records`
- `invalid_route_records`

Mint eligibility may be blocked when `scoreable_coverage` falls below the configured threshold. The default helper threshold is `0.8`, with a default maximum invalid route rate of `0.2`.

---

## 4. Input Schema

```json
{
  "schema_version": "1.0",
  "task_id": "string",
  "task_descriptor": {
    "task_type": "bugfix|feature|refactor|infra|tests|migration|docs|unknown",
    "language": "python|typescript|javascript|go|rust|java|bash|multi|unknown",
    "domain": "backend|frontend|fullstack|devops|data|ml|mobile|unknown",
    "complexity": 1,
    "repo_size_bucket": "small|medium|large|xlarge",
    "files_touched_bucket": "1|2_5|6_15|16_plus",
    "description_length_bucket": "short|medium|long",
    "is_greenfield": false,
    "is_migration": false,
    "requires_tests": true,
    "cross_service": false,
    "ui_heavy": false,
    "risk_level": "low|medium|high"
  },
  "constraints": {
    "max_cost_usd": 2.5
  },
  "available_models": {
    "planner_models": ["string"],
    "coder_models": ["string"],
    "reviewer_models": ["string"]
  }
}
```

---

## 5. Output Schema

```json
{
  "schema_version": "1.0",
  "route": {
    "planner_model": "string",
    "coder_model": "string",
    "reviewer_model": "string",
    "plan_depth": "low|medium|high",
    "code_depth": "low|medium|high",
    "review_mode": "light|standard|deep"
  },
  "predictions": {
    "expected_success_probability": 0.0,
    "expected_cost_usd": 0.0,
    "confidence": 0.0
  }
}
```

---

## 6. Training / Submission Schema

```json
{
  "schema_version": "1.0",
  "run_id": "string",
  "task_id": "string",
  "constraints": {
    "max_cost_usd": 3.0
  },
  "route_taken": {
    "planner_model": "model-a",
    "coder_model": "model-b",
    "reviewer_model": "model-c"
  },
  "observed_outcomes": {
    "completed_successfully": true,
    "actual_cost_usd": 2.41,
    "actual_time_seconds": 1840,
    "intervention_count": 1
  }
}
```

---

## 7. DeltaOne Definition

**1 DeltaOne = 1 percentage point improvement in success rate under budget**

DeltaOne = BenchmarkScore_new − BenchmarkScore_baseline

---

## 8. Summary

This model predicts workflow configurations that maximize successful task completion within budget using real execution data. The benchmark is measured by `hokusai.scorers.wavemill.success_rate_under_budget:v1` and persisted as `workflow_success_rate_under_budget` plus coverage and diagnostics fields.
