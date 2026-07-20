# HOK-2074 Native Routing Canary

## Linear Issue

- Issue: HOK-2074
- Title: [Phase 1] Light randomization of reviewer-model assignment with logged propensity
- Project: wavemill
- Status: Backlog

## Objective

Implement a light, bounded exploration policy for reviewer-model assignment so
eligible matched-signature tasks can randomize reviewer choice while logging the
exact assignment propensity.

## Requirements

- Add bounded reviewer-model exploration only for eligible tasks.
- Persist the selected reviewer model and exact propensity with each relevant
  routing/eval record.
- Add guardrails that prevent or cap exploration for high-stakes tasks.
- Keep existing deterministic reviewer assignment behavior when exploration is
  disabled or the task is ineligible.
- Add focused automated tests for deterministic behavior, randomized assignment,
  propensity logging, and high-stakes guardrails.

## Native Canary Purpose

This task is intentionally used as a native routing canary because it exercises
real Wavemill routing semantics with a modest code-change surface. A successful
run should prove that native planning, native patch coding, and native review can
work through route selection, implementation, test updates, completion artifacts,
and review handoff on a realistic routing task.

## Suggested Native Runs

Primary canary:

- Planner: `glm-5.2`
- Coder: `qwen-3-coder`
- Reviewer: `glm-5.2`

Challenger canary:

- Planner: `kimi-k2.7-code`
- Coder: `kimi-k2.7-code`
- Reviewer: `qwen-3-coder`

## Acceptance Criteria

- Reviewer-model assignment randomizes only for eligible tasks.
- Logged propensity is exact for the assignment policy used.
- High-stakes tasks are excluded or capped according to the guardrail policy.
- Existing router behavior remains stable when exploration is disabled.
- Tests cover the new policy and persistence behavior.
